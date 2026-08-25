import { createECDH } from "node:crypto";
import webpush from "web-push";
import type { PushSubscriptionStore } from "./stores/push-subscriptions.js";
import type { RelayLogger } from "./logging.js";

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** web-push TTL is SECONDS (spec: "the Time to Live of the message"). */
export const PUSH_TTL_SECONDS = 3600;
const BODY_CAP = 200;
/** Push services answer gone with 404 or 410 — both mean "delete the row". */
const GONE_STATUS = new Set([404, 410]);

/**
 * Only endpoints on known, standards-based push services are accepted.
 * The hub POSTes to each stored endpoint from its own network context —
 * accepting arbitrary HTTPS URLs would hand every account a blind server-side
 * POST primitive (SSRF).
 *
 * Allowed providers:
 * - Google FCM: fcm.googleapis.com, fcm.notifications.google.com
 * - Apple APNs: *.push.apple.com (Safari on macOS, iOS/iPadOS Home Screen Web Apps)
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    // Push services should only be reachable over normal HTTPS (implicit or 443).
    if (url.port !== "" && url.port !== "443") return false;

    if (
      url.hostname === "fcm.googleapis.com" ||
      url.hostname === "fcm.notifications.google.com"
    ) {
      return true;
    }

    // Apple officially requires allowing any subdomain of push.apple.com.
    if (url.hostname.endsWith(".push.apple.com")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const subject = env.XACPX_RELAY_VAPID_SUBJECT;
  const publicKey = env.XACPX_RELAY_VAPID_PUBLIC_KEY;
  const privateKey = env.XACPX_RELAY_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

/**
 * Validate a VAPID config eagerly. `web-push` only rejects malformed keys at
 * first use, which would surface as an unhandled rejection inside the
 * fire-and-forget fan-out — the exact failure mode this module must prevent.
 * Returns null for configs that cannot work.
 */
// Mirrors web-push's own validation so an accepted config is one the library
// will actually accept at send time — not just a lookalike.
const STRICT_B64URL = /^[A-Za-z0-9_-]+$/;

export function validateVapidConfig(config: VapidConfig | null): VapidConfig | null {
  if (!config) return null;
  // web-push does `new URL(subject)`: only absolute mailto:/https: URLs pass.
  try {
    const u = new URL(config.subject);
    if (u.protocol !== "mailto:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  // Keys must be STRICT URL-safe base64 (web-push rejects '+'/'/'/'='), then
  // decode to exact P-256 material sizes: public = uncompressed point (65
  // bytes), private = scalar (32 bytes). Node's decoder is lenient about
  // garbage like '!' — strict alphabet + decoded length together close that.
  const b64urlOk = (v: string) => STRICT_B64URL.test(v);
  const b64url = (v: string) => v.replace(/-/g, "+").replace(/_/g, "/");
  if (!b64urlOk(config.publicKey) || !b64urlOk(config.privateKey)) return null;
  if (config.publicKey.length !== 87 || config.privateKey.length !== 43) return null;
  try {
    const pkBytes = Buffer.from(b64url(config.publicKey), "base64");
    const skBytes = Buffer.from(b64url(config.privateKey), "base64");
    if (pkBytes.length !== 65 || pkBytes[0] !== 0x04 || skBytes.length !== 32) return null;
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(pkBytes);
  } catch {
    return null;
  }
  return config;
}

type WebPushLike = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options: { TTL: number },
  ): Promise<unknown>;
};

export class PushNotifier {
  private wp: WebPushLike = webpush as unknown as WebPushLike;
  private detailsSet = false;
  private readonly deps: {
    config: VapidConfig | null;
    subscriptions: PushSubscriptionStore;
    logger?: RelayLogger;
  };

  constructor(deps: {
    config: VapidConfig | null;
    subscriptions: PushSubscriptionStore;
    logger?: RelayLogger;
  }) {
    // Fail fast on malformed VAPID input: web-push only validates at first
    // use, which would otherwise surface as an unhandled rejection inside the
    // fire-and-forget fan-out. An invalid config downgrades to push-disabled.
    const valid = validateVapidConfig(deps.config);
    if (deps.config && !valid) {
      deps.logger?.warn("relay.push.disabled", "web push disabled: invalid VAPID config (subject must be mailto:/https:, keys must be base64url P-256 material)");
    }
    this.deps = { ...deps, config: valid };
  }

  /** Test seam: swap the web-push binding. */
  _setWebPushForTests(wp: WebPushLike): void {
    this.wp = wp;
    this.detailsSet = false;
  }

  private ensureDetails(): boolean {
    if (!this.deps.config) return false;
    if (!this.detailsSet) {
      this.wp.setVapidDetails(this.deps.config.subject, this.deps.config.publicKey, this.deps.config.privateKey);
      this.detailsSet = true;
    }
    return true;
  }

  /** Fan out a task-completion notification to every subscription of the account.
   *  Never throws or rejects: push failures must not affect the WS broadcast /
   *  persist path (server.ts calls this fire-and-forget). */
  async sendTaskCompletion(accountId: string, notice: { instanceId: string; instanceName: string; text: string }): Promise<void> {
    try {
      await this.sendTaskCompletionInner(accountId, notice);
    } catch (err) {
      // Belt-and-braces: even a bug above must never reject into the caller.
      this.deps.logger?.warn("relay.push.fanout_failed", "push fan-out aborted unexpectedly", { error: String(err) });
    }
  }

  private async sendTaskCompletionInner(accountId: string, notice: { instanceId: string; instanceName: string; text: string }): Promise<void> {
    if (!this.ensureDetails()) return;
    const payload = JSON.stringify({
      title: notice.instanceName,
      body: notice.text.slice(0, BODY_CAP),
      instanceId: notice.instanceId,
      url: "/",
    });
    for (const sub of this.deps.subscriptions.listByAccount(accountId)) {
      try {
        await this.wp.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: PUSH_TTL_SECONDS },
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: unknown }).statusCode;
        if (typeof statusCode === "number" && GONE_STATUS.has(statusCode)) {
          this.deps.subscriptions.deleteByEndpoint(sub.endpoint);
        } else {
          this.deps.logger?.warn("relay.push.send_failed", "web push delivery failed", {
            endpointHost: safeHost(sub.endpoint),
            statusCode: typeof statusCode === "number" ? statusCode : undefined,
          });
        }
      }
    }
  }
}

/** Log only the push endpoint's host — the full URL is a bearer-ish secret. */
function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unparseable";
  }
}
