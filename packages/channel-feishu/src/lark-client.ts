import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuMessageClient } from "./send.js";

export interface FeishuLarkClientOptions {
  appId: string;
  appSecret: string;
  domain: string;
  injectedSdkClient?: FeishuMessageClient;
  injectedStartWS?: (handlers: Record<string, (data: unknown) => Promise<void> | void>, abortSignal?: AbortSignal) => Promise<void>;
  injectedProbeBot?: () => Promise<{ botOpenId?: string; botName?: string }>;
}

export interface FeishuLarkClient {
  sdk: FeishuMessageClient;
  probeBot(): Promise<{ botOpenId?: string; botName?: string }>;
  /**
   * Returns the group owner's open_id for a chat the bot belongs to, or
   * undefined when the response carries none. Throws on API failure so the
   * caller can fail closed (no owner assertion).
   */
  getChatOwner(chatId: string): Promise<string | undefined>;
  startWS(input: {
    handlers: Record<string, (data: unknown) => Promise<void> | void>;
    abortSignal?: AbortSignal;
  }): Promise<void>;
  stop(): void;
}

/**
 * Narrows a GET /im/v1/chats/{chat_id} response to its `data.owner_id`,
 * validating each hop so a malformed payload yields undefined (fail closed)
 * instead of a fabricated read.
 */
function extractChatOwnerId(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || !("data" in response)) return undefined;
  const data: unknown = response.data;
  if (!data || typeof data !== "object" || !("owner_id" in data)) return undefined;
  const ownerId: unknown = data.owner_id;
  return typeof ownerId === "string" && ownerId ? ownerId : undefined;
}

function resolveDomain(domain: string): unknown {
  if (domain === "lark") return Lark.Domain.Lark;
  if (domain === "feishu") return Lark.Domain.Feishu;
  return domain;
}

export function createFeishuLarkClient(options: FeishuLarkClientOptions): FeishuLarkClient {
  const sdk = options.injectedSdkClient ?? (new Lark.Client({
    appId: options.appId,
    appSecret: options.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(options.domain) as never,
  }) as unknown as FeishuMessageClient);

  let wsClient: { close(params?: { force?: boolean }): void } | null = null;

  return {
    sdk,
    async probeBot() {
      if (options.injectedProbeBot) return await options.injectedProbeBot();
      const response = await (sdk as unknown as { request(input: unknown): Promise<{ data?: { pingBotInfo?: { botID?: string; botName?: string } } }> }).request({
        method: "POST",
        url: "/open-apis/bot/v1/openclaw_bot/ping",
        data: { needBotInfo: true },
      });
      return {
        botOpenId: response.data?.pingBotInfo?.botID,
        botName: response.data?.pingBotInfo?.botName,
      };
    },
    async getChatOwner(chatId: string) {
      // The Lark SDK Client exposes a generic `request` method; our
      // FeishuMessageClient subset omits it, so this named cast re-declares
      // only that method surface.
      const requester = sdk as unknown as {
        request(input: { method: "GET"; url: string }): Promise<unknown>;
      };
      const response: unknown = await requester.request({
        method: "GET",
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      });
      return extractChatOwnerId(response);
    },
    async startWS(input) {
      if (options.injectedStartWS) {
        await options.injectedStartWS(input.handlers, input.abortSignal);
        return;
      }
      const client = new Lark.WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: resolveDomain(options.domain) as never,
      });
      wsClient = client;
      client.start({ eventDispatcher: new Lark.EventDispatcher({}).register(input.handlers as never) });
      if (input.abortSignal) {
        await new Promise<void>((resolve) => {
          if (input.abortSignal!.aborted) {
            client.close({ force: true });
            resolve();
            return;
          }
          input.abortSignal!.addEventListener("abort", () => {
            client.close({ force: true });
            resolve();
          }, { once: true });
        });
      }
    },
    stop() {
      if (wsClient) {
        wsClient.close({ force: true });
        wsClient = null;
      }
    },
  };
}
