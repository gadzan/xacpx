import webpush from "web-push";
import type { PushSubscriptionStore } from "./stores/push-subscriptions.js";
import type { RelayLogger } from "./logging.js";

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export const PUSH_TTL_MS = 3600;
const BODY_CAP = 200;
/** Push services answer gone with 404 or 410 — both mean "delete the row". */
const GONE_STATUS = new Set([404, 410]);

export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const subject = env.XACPX_RELAY_VAPID_SUBJECT;
  const publicKey = env.XACPX_RELAY_VAPID_PUBLIC_KEY;
  const privateKey = env.XACPX_RELAY_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
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

  constructor(private readonly deps: {
    config: VapidConfig | null;
    subscriptions: PushSubscriptionStore;
    logger?: RelayLogger;
  }) {}

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
   *  Never throws: push failures must not affect the WS broadcast/persist path. */
  async sendTaskCompletion(accountId: string, notice: { instanceId: string; instanceName: string; text: string }): Promise<void> {
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
          { TTL: PUSH_TTL_MS },
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
