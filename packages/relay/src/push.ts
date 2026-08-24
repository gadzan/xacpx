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
 * Only endpoints on these origins are accepted. The hub POSTes to each stored
 * endpoint from its own network context — accepting arbitrary HTTPS URLs would
 * hand every account a blind server-side POST primitive (SSRF). Chrome routes
 * through FCM; widen deliberately if Firefox/Safari support ever lands.
 */
const ALLOWED_ENDPOINT_ORIGINS: Record<string, true> = {
  "https://fcm.googleapis.com": true,
  "https://fcm.notifications.google.com": true,
};

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    return ALLOWED_ENDPOINT_ORIGINS[new URL(endpoint).origin] === true;
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
export function validateVapidConfig(config: VapidConfig | null): VapidConfig | null {
  if (!config) return null;
  if (!/^(mailto:|https:\/\/)/.test(config.subject)) {
    return null;
  }
  // P-256 public keys are uncompressed EC points: 65 raw bytes → 87 base64url
  // chars. Private keys: 32 bytes → 43 base64url chars.
  const b64url = (v: string) => v.replace(/-/g, "+").replace(/_/g, "/");
  if (b64url(config.publicKey).length !== 87 || !config.privateKey) return null;
  try {
    Buffer.from(b64url(config.publicKey), "base64");
    Buffer.from(b64url(config.privateKey), "base64");
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
