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
import { createStateMirror } from "./state-mirror.js";

type OrchestrationTaskRecord = Parameters<MessageChannelRuntime["notifyTaskCompletion"]>[0];

interface CredentialStoreLike {
  load(): RelayCredential | null;
  save(credential: RelayCredential): void;
  clear(): void;
}

interface RelayClientLike {
  start(abortSignal: AbortSignal): void;
  stop(): void;
  sendEvent(type: string, payload: unknown, onFlush?: (error?: Error) => void): void;
  isReady(): boolean;
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
    // Capture the guard-narrowed ControlService in a const: the `onEvent` closure below
    // runs later, and TS does not carry the `if (!input.control)` narrowing into a
    // deferred closure over the mutable `input.control` property.
    const control = input.control;
    this.control = control;
    const bridge = createControlBridge(control);
    const client = (this.deps.createClient ?? ((options) => new RelayClient(options)))({
      url: this.config.url,
      credentialStore: this.credentials,
      pairingToken: this.config.pairingToken,
      instanceName: this.config.name,
      coreVersion: input.coreVersion,
      onRequest: bridge,
      onEvent: (envelope) => dispatchControlEvent(control, envelope),
      logger: input.logger,
      // Right after (re)auth — before any subsequent control events can arrive — push
      // the local state mirror so a restarted hub recovers running turns, usage meters
      // and command hints. First connect usually sends an empty sync; harmless, and it
      // keeps one code path.
      onReady: () => {
        // Prune aliases of sessions removed while offline; a chatKey whose session
        // list cannot be read keeps its aliases (don't prune what we can't verify).
        const liveAliases = new Set<string>();
        for (const chatKey of mirror.chatKeys()) {
          try {
            for (const session of control.listSessions(chatKey)) liveAliases.add(session.alias);
          } catch {
            for (const alias of mirror.aliasesForChatKey(chatKey)) liveAliases.add(alias);
          }
        }
        client.sendEvent(MSG.instanceStateSync, mirror.takeStateSync(liveAliases), (error) => {
          // Clear only on a CONFIRMED send (ws flush callback). An errored or
          // not-ready send keeps the FIFO; the next reconnect re-sends, and the
          // hub's dedup (fingerprint + pair matching) covers the
          // delivered-but-unconfirmed race.
          if (!error) mirror.clearFinishedOffline();
        });
      },
    });
    // Mirror sees the exact payloads being forwarded, so the sync snapshot equals
    // what the hub consumed (normalized tool steps included).
    const mirror = createStateMirror({ isReady: () => client.isReady(), logger: input.logger });
    this.client = client;
    this.unsubscribe = subscribeControlEvents(control, (type, payload) => {
      mirror.handleEnvelope(type, payload);
      client.sendEvent(type, payload);
    });
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
