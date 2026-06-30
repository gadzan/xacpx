import {
  MSG,
  type InstanceNoticePayload,
} from "@ganglion/xacpx-relay-protocol";
import type {
  ChannelStartInput,
  ControlService,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  ScheduledChannelMessageInput,
} from "xacpx/plugin-api";

import { parseRelayChannelConfig, type RelayChannelConfig } from "./config.js";
import { CredentialStore, defaultCredentialPath, type RelayCredential } from "./credential-store.js";
import { createControlBridge, subscribeControlEvents, dispatchControlEvent } from "./control-bridge.js";
import { RelayClient, type RelayClientOptions } from "./relay-client.js";

type OrchestrationTaskRecord = Parameters<MessageChannelRuntime["notifyTaskCompletion"]>[0];

interface CredentialStoreLike {
  load(): RelayCredential | null;
  save(credential: RelayCredential): void;
  clear(): void;
}

interface RelayClientLike {
  start(abortSignal: AbortSignal): void;
  stop(): void;
  sendEvent(type: string, payload: unknown): void;
}

export interface RelayChannelDeps {
  credentialStore?: CredentialStoreLike;
  createClient?: (options: RelayClientOptions) => RelayClientLike;
}

export class RelayChannel implements MessageChannelRuntime {
  readonly id = "relay";
  readonly nativeSessionListFormat = "table" as const;

  private readonly config: RelayChannelConfig;
  private readonly credentials: CredentialStoreLike;
  private client: RelayClientLike | null = null;
  private unsubscribe: (() => void) | null = null;
  // The structured control facade, captured at start(). Scheduled dispatch runs a
  // fired task's prompt through this so it streams as a real turn (turn-* events flow
  // over the same event subscription to the hub → conversation history + live view).
  private control: ControlService | null = null;

  constructor(options: Record<string, unknown> | undefined, private readonly deps: RelayChannelDeps = {}) {
    this.config = parseRelayChannelConfig(options);
    this.credentials = deps.credentialStore ?? new CredentialStore(defaultCredentialPath());
  }

  isLoggedIn(): boolean {
    return this.credentials.load() !== null || this.config.pairingToken !== undefined;
  }

  async login(): Promise<string> {
    return "relay channel pairs automatically on start; configure it via: xacpx channel add relay --url <ws-url> --token <pairing-token>";
  }

  logout(): void {
    this.credentials.clear();
  }

  async start(input: ChannelStartInput): Promise<void> {
    if (!input.control) {
      throw new Error("relay channel requires ChannelStartInput.control (xacpx >= 0.11)");
    }
    this.control = input.control;
    const bridge = createControlBridge(input.control);
    const client = (this.deps.createClient ?? ((options) => new RelayClient(options)))({
      url: this.config.url,
      credentialStore: this.credentials,
      pairingToken: this.config.pairingToken,
      instanceName: this.config.name,
      coreVersion: input.coreVersion,
      onRequest: bridge,
      onEvent: (envelope) => dispatchControlEvent(input.control, envelope),
      logger: input.logger,
    });
    this.client = client;
    this.unsubscribe = subscribeControlEvents(input.control, (type, payload) => client.sendEvent(type, payload));
    client.start(input.abortSignal);

    // Channel convention: start() stays pending until shutdown (see run-console).
    await new Promise<void>((resolve) => {
      if (input.abortSignal.aborted) {
        resolve();
        return;
      }
      input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client?.stop();
    this.client = null;
    this.control = null;
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    this.sendNotice({ kind: "task-completion", taskId: task.taskId, text: task.summary || task.resultText || task.taskId });
  }

  async notifyTaskProgress(task: OrchestrationTaskRecord, text: string): Promise<void> {
    this.sendNotice({ kind: "task-progress", taskId: task.taskId, text });
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    this.sendNotice({ kind: "coordinator-message", chatKey: input.chatKey, text: input.text });
  }

  // A due scheduled task fires here. Run it through the control turn path (not a side
  // notice) so it behaves exactly like a manual web prompt: the prompt appears in the
  // conversation, the agent reply streams + persists, and the schedule origin badges it.
  async sendScheduledMessage(input: ScheduledChannelMessageInput): Promise<void> {
    if (!this.control) {
      throw new Error("relay channel cannot dispatch scheduled task before start()");
    }
    const result = await this.control.runScheduledTurn({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      promptText: input.promptText,
      taskId: input.taskId ?? "",
      executeAt: input.executeAt ?? new Date(0).toISOString(),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    // Surface a failed turn as a thrown error so the scheduler records the task as
    // "failed" (and the web panel shows it) rather than silently "executed".
    if (!result.ok) {
      throw new Error(result.errorMessage ?? "scheduled turn failed");
    }
  }

  private sendNotice(payload: InstanceNoticePayload): void {
    this.client?.sendEvent(MSG.instanceNotice, payload);
  }
}
