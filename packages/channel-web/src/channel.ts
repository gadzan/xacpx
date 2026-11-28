import { subscribeControlEvents } from "@ganglion/xacpx-control-bridge";
import type {
  ChannelElicitationDecision,
  ChannelElicitationRequest,
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  ChannelStartInput,
  ChannelStopReason,
  PublicControlService,
  SessionResourceCatalog,
} from "xacpx/plugin-api";

import { parseWebChannelConfig, type WebChannelConfig } from "./config.js";
import { eventChatKey, isLocalScope, toWebEvent } from "./events.js";
import { startLocalWebServer, type LocalWebServer } from "./server.js";
import { LocalTerminal, type LocalTerminalClient } from "./terminal.js";

export class WebChannel {
  readonly id = "web";
  readonly elicitationModes = ["form"] as const;
  private server: LocalWebServer | null = null;
  private unsubscribe: (() => void) | null = null;
  private terminal: LocalTerminal | null = null;
  private loggedIn = true;

  constructor(private readonly options: Record<string, unknown> = {}) {}

  isLoggedIn(): boolean {
    return this.loggedIn;
  }

  async login(): Promise<string> {
    this.loggedIn = true;
    return "web";
  }

  logout(): void {
    this.loggedIn = false;
  }

  async start(input: ChannelStartInput): Promise<void> {
    const control = input.control;
    if (!control) throw new Error("web channel needs the control service");
    const config = parseWebChannelConfig(this.options);
    const webRoot = await resolveDashboard();
    if (config.terminal.enabled) {
      this.terminal = await startTerminal(input.sessionResources, input.logger);
    }
    this.server = await startLocalWebServer({
      config,
      port: config.port,
      ...(webRoot ? { webRoot } : {}),
      control,
      trustedConversationPrompt: input.trustedConversationPrompt,
      trustedConversationPolicyPrompt: input.trustedConversationPolicyPrompt,
      ...(this.terminal ? { terminal: this.terminal.client() } : {}),
    });
    const actualPort = this.server.port;
    this.unsubscribe = subscribeControlEvents(control, (type, payload) => {
      if (!isLocalScope(eventChatKey(type, payload))) return;
      const event = toWebEvent(type, payload);
      if (!event || event.kind !== "control-event") {
        if (event) this.server?.local.publish(event);
        return;
      }
      this.server?.local.project(event.event);
      this.server?.local.noteDirectoryEvent(event.event);
      this.server?.local.publish(event);
    });
    const host = config.host.includes(":") ? `[${config.host}]` : config.host;
    await input.logger.info?.("web.listening", `local web console at http://${host}:${actualPort}`, {
      host: config.host,
      port: actualPort,
    });
  }

  async stop(_reason?: ChannelStopReason): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.server?.close();
    this.server = null;
    await this.terminal?.stop();
    this.terminal = null;
  }

  requestPermission(request: ChannelPermissionRequest): Promise<ChannelPermissionDecision> {
    if (!this.server) return Promise.reject(new Error("channel-missing"));
    return this.server.local.interactions.openPermission(request);
  }

  requestElicitation(request: ChannelElicitationRequest): Promise<ChannelElicitationDecision> {
    if (!this.server) return Promise.reject(new Error("channel-missing"));
    return this.server.local.interactions.openElicitation(request);
  }

  async notifyTaskCompletion(): Promise<void> {}
  async notifyTaskProgress(): Promise<void> {}
  async sendCoordinatorMessage(): Promise<void> {}

  config(): WebChannelConfig {
    return parseWebChannelConfig(this.options);
  }

  control(): PublicControlService | undefined {
    return undefined;
  }
}

async function startTerminal(
  catalog: SessionResourceCatalog | undefined,
  logger: { warn?: (event: string, message: string) => Promise<void> | void },
): Promise<LocalTerminal | null> {
  if (!catalog) {
    await logger.warn?.("web.terminal.unavailable", "the local terminal needs the session catalog");
    return null;
  }
  try {
    const terminal = new LocalTerminal(catalog);
    await terminal.start();
    return terminal;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.warn?.("web.terminal.unavailable", `the local terminal did not start: ${message}`);
    return null;
  }
}

async function resolveDashboard(): Promise<string | undefined> {
  try {
    const web = await import("@ganglion/xacpx-web");
    return typeof web.tryResolveWebRoot === "function" ? web.tryResolveWebRoot() : undefined;
  } catch {
    return undefined;
  }
}
