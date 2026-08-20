import { homedir } from "node:os";
import { join } from "node:path";

import {
  MSG,
  RELAY_CAPABILITIES,
  type AgentDirectorySnapshotPayload,
  type InstanceNoticePayload,
  type InstanceRecoveryAckPayload,
  type RelayEnvelope,
} from "@ganglion/xacpx-relay-protocol";
import type {
  ChannelStartInput,
  ControlService,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  ScheduledChannelMessageInput,
  SessionResourceCatalog,
} from "xacpx/plugin-api";
import { coreHomeDir } from "xacpx/plugin-api";

/** Mirrors core `ChannelStopReason` (exported from plugin-api once consumers pick up the bump). */
type ChannelStopReason = "shutdown" | "disabled" | "removed" | "logout";

import { parseRelayChannelConfig, type RelayChannelConfig } from "./config.js";
import {
  CredentialStore,
  defaultCredentialPath,
  type RelayCredential,
} from "./credential-store.js";
import {
  createControlBridge,
  subscribeControlEvents,
  dispatchControlEvent,
} from "./control-bridge.js";
import { RelayClient, type RelayClientOptions } from "./relay-client.js";
import { createStateMirror } from "./state-mirror.js";
import {
  RmuxSidecarSupervisor,
  SupervisedRmuxDriver,
  createProductionTerminalDriver,
} from "./terminal/rmux-sidecar-supervisor.js";
import {
  missingRequiredRmuxBridgeCapabilities,
  type RmuxTerminalDriver,
} from "./terminal/rmux-driver.js";
import { TerminalRegistryStore } from "./terminal/terminal-registry-store.js";
import {
  DefaultRelayTerminalRuntime,
  type RelayTerminalRuntime,
} from "./terminal/terminal-runtime.js";
import {
  createTerminalViewerPublisher,
  handleTerminalEvent,
  handleTerminalRequest,
  isTerminalEventType,
  isTerminalRequestType,
} from "./terminal-bridge.js";
import { retireRelayTerminals } from "./terminal/retire-terminals.js";
import { logTerminalEvent } from "./terminal/terminal-log.js";
import {
  RMUX_BUNDLED_VERSION,
  type ResolvedRmuxBinaries,
} from "./terminal/resolve-rmux-binaries.js";
import { redactPathForDoctor } from "./terminal/terminal-diagnostics.js";

type OrchestrationTaskRecord = Parameters<
  MessageChannelRuntime["notifyTaskCompletion"]
>[0];

interface CredentialStoreLike {
  load(): RelayCredential | null;
  save(credential: RelayCredential): void;
  clear(): void;
}

interface RelayClientLike {
  start(abortSignal: AbortSignal): void;
  stop(): void;
  isReady?(): boolean;
  sendEvent(
    type: string,
    payload: unknown,
    onFlush?: (error?: Error) => void,
  ): void;
  sendRequest?<T = unknown>(
    type: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<T>;
}

export function defaultTerminalRegistryDir(): string {
  return join(coreHomeDir(process.env.HOME ?? homedir()), "relay");
}

export interface RelayChannelDeps {
  credentialStore?: CredentialStoreLike;
  createClient?: (options: RelayClientOptions) => RelayClientLike;
  /** Override terminal registry directory (tests). Default: ~/.xacpx/relay */
  terminalRegistryDir?: string;
  /**
   * Trailing debounce window for the FULL endpoint directory sync pushed to the
   * hub after sessions/worker bindings change. Defaults to 250ms; tests pass a
   * smaller value (or 0) to shorten waits.
   */
  endpointSyncDebounceMs?: number;
  /**
   * Driver factory for tests. Production resolves the Rust sidecar via
   * `createProductionTerminalDriver` — never falls back to InMemory.
   */
  createTerminalDriver?: () => RmuxTerminalDriver;
}

export class RelayChannel implements MessageChannelRuntime {
  readonly id = "relay";
  readonly nativeSessionListFormat = "table" as const;

  private readonly config: RelayChannelConfig;
  private readonly credentials: CredentialStoreLike;
  private client: RelayClientLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private catalogUnsub: (() => void) | null = null;
  private control: ControlService | null = null;
  private terminal: DefaultRelayTerminalRuntime | null = null;
  private terminalReady = false;
  private terminalSupervisor: RmuxSidecarSupervisor | null = null;
  private startLogger: ChannelStartInput["logger"] | undefined;
  private readonly pendingRetirements = new Set<Promise<void>>();
  private endpointSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    options: Record<string, unknown> | undefined,
    private readonly deps: RelayChannelDeps = {},
  ) {
    this.config = parseRelayChannelConfig(options);
    this.credentials =
      deps.credentialStore ?? new CredentialStore(defaultCredentialPath());
  }

  isLoggedIn(): boolean {
    return (
      this.credentials.load() !== null || this.config.pairingToken !== undefined
    );
  }

  async login(): Promise<string> {
    return "relay channel pairs automatically on start; configure it via: xacpx channel add relay --url <ws-url> --token <pairing-token>";
  }

  async logout(): Promise<void> {
    // Spec §12.3: await durable reaping before dropping credential.
    await this.detachCatalogAndDrainRetirements();
    if (this.terminal) {
      try {
        await this.terminal.terminateAll("logout");
      } catch {
        // cleanup-pending / unreachable RMUX still allows credential clear only
        // after we attempted terminateAll (records are reaping).
      }
      try {
        await this.terminal.stop();
      } catch {
        // ignore
      }
      this.terminal = null;
      this.terminalReady = false;
    }
    await this.stopTerminalSupervisor();
    this.credentials.clear();
  }

  async start(input: ChannelStartInput): Promise<void> {
    if (!input.control) {
      throw new Error(
        "relay channel requires ChannelStartInput.control (xacpx >= 0.11)",
      );
    }
    const control = input.control;
    this.control = control;

    const capabilities = await this.bootstrapTerminal(input);

    const bridge = createControlBridge(control);
    const onRequest = (
      envelope: RelayEnvelope,
      respond: (payload: unknown) => void,
    ) => {
      if (
        this.terminal &&
        this.terminalReady &&
        isTerminalRequestType(envelope.type)
      ) {
        void handleTerminalRequest(this.terminal, envelope, respond);
        return;
      }
      bridge(envelope, respond);
    };

    const client = (
      this.deps.createClient ?? ((options) => new RelayClient(options))
    )({
      url: this.config.url,
      credentialStore: this.credentials,
      pairingToken: this.config.pairingToken,
      instanceName: this.config.name,
      coreVersion: input.coreVersion,
      capabilities,
      onRequest,
      onEvent: (envelope) => {
        if (envelope.type === MSG.instanceRecoveryAck) {
          const ids = (
            envelope.payload as InstanceRecoveryAckPayload | undefined
          )?.recoveryIds;
          if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) {
            mirror.confirmFinished(ids);
          }
          return;
        }
        if (envelope.type === MSG.agentDirectorySnapshot) {
          const snapshotPayload = envelope.payload as
            AgentDirectorySnapshotPayload | undefined;
          if (Array.isArray(snapshotPayload?.endpoints)) {
            if (
              "syncRemoteAgentDirectory" in control &&
              typeof (
                control as unknown as {
                  syncRemoteAgentDirectory: (endpoints: unknown[]) => void;
                }
              ).syncRemoteAgentDirectory === "function"
            ) {
              (
                control as unknown as {
                  syncRemoteAgentDirectory: (endpoints: unknown[]) => void;
                }
              ).syncRemoteAgentDirectory(snapshotPayload.endpoints);
            }
          }
          return;
        }
        if (
          this.terminal &&
          this.terminalReady &&
          isTerminalEventType(envelope.type)
        ) {
          // RMUX path: never fall through to legacy core PTY handlers.
          void handleTerminalEvent(this.terminal, envelope);
          return;
        }
        dispatchControlEvent(control, envelope);
      },
      onDisconnected: () => {
        this.terminal?.detachAllAttachments();
      },
      logger: input.logger,
      onReady: () => {
        const liveAliases = new Set<string>();
        for (const chatKey of mirror.chatKeys()) {
          try {
            for (const session of control.listSessions(chatKey))
              liveAliases.add(session.alias);
          } catch {
            for (const alias of mirror.aliasesForChatKey(chatKey))
              liveAliases.add(alias);
          }
        }
        mirror.expirePendingFinished();
        const { snapshot, aliases } = mirror.buildStateSync(liveAliases);
        client.sendEvent(MSG.instanceStateSync, snapshot, (error) => {
          if (!error) mirror.pruneStateMirror(liveAliases, aliases);
        });
        // Full directory sync on (re)auth: the hub rebuilds this instance's
        // presence from the authoritative snapshot.
        this.syncAgentEndpointsNow();
      },
    });

    const mirror = createStateMirror({ logger: input.logger });
    this.client = client;

    if (this.terminal) {
      // Rebind publisher now that client exists.
      const publish = createTerminalViewerPublisher(
        this.terminal,
        (type, payload, onFlush) => {
          client.sendEvent(type, payload, onFlush);
        },
      );
      // Runtime was constructed with a no-op publisher; replace via fresh wiring
      // is awkward — instead emit through a mutable slot set below.
      this.viewerPublish = publish;
    }

    this.unsubscribe = subscribeControlEvents(control, (type, payload) => {
      const finishedRecoveryId = mirror.handleEnvelope(type, payload);
      const forwardedPayload =
        finishedRecoveryId && typeof payload === "object" && payload !== null
          ? {
              ...(payload as Record<string, unknown>),
              event: {
                ...(payload as { event: Record<string, unknown> }).event,
                recoveryId: finishedRecoveryId,
              },
            }
          : payload;
      client.sendEvent(type, forwardedPayload);
      // Sessions or orchestration (worker bindings) changed → the published
      // endpoint directory may have changed. Debounce and push the FULL
      // snapshot; the hub replaces its copy and rebroadcasts to peers.
      const eventType = (payload as { event?: { type?: string } } | undefined)
        ?.event?.type;
      if (
        eventType === "sessions-changed" ||
        eventType === "orchestration-changed" ||
        eventType === "turn-started" ||
        eventType === "turn-finished"
      ) {
        this.scheduleEndpointSync();
      }
    });
    client.start(input.abortSignal);

    await new Promise<void>((resolve) => {
      if (input.abortSignal.aborted) {
        resolve();
        return;
      }
      input.abortSignal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    await this.stop("shutdown");
  }

  /** Mutable slot filled after client construction so runtime events reach the hub. */
  private viewerPublish:
    | ((
        event: import("./terminal/terminal-runtime.js").TerminalViewerEvent,
        onFlush?: (error?: Error) => void,
      ) => void)
    | null = null;

  async stop(reason: ChannelStopReason = "shutdown"): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.endpointSyncTimer) {
      clearTimeout(this.endpointSyncTimer);
      this.endpointSyncTimer = null;
    }
    await this.detachCatalogAndDrainRetirements();

    if (this.terminal) {
      // Process-owned: Runtime.stop() durable-terminates all sessions.
      // Hub/browser disconnect still only detachAllAttachments (not stop).
      await this.terminal.stop();
      this.terminal = null;
      this.terminalReady = false;
      this.viewerPublish = null;
    }
    await this.stopTerminalSupervisor();

    this.client?.stop();
    this.client = null;
    this.control = null;
  }

  private async detachCatalogAndDrainRetirements(): Promise<void> {
    this.catalogUnsub?.();
    this.catalogUnsub = null;
    if (this.pendingRetirements.size === 0) return;
    await Promise.allSettled([...this.pendingRetirements]);
  }

  private queueLogicalRetirement(
    runtime: DefaultRelayTerminalRuntime,
    logicalSessionId: string,
    reason: "archive" | "delete",
  ): void {
    const work = runtime
      .retireLogicalSession(logicalSessionId, reason)
      .catch((err) => {
        void this.startLogger?.error(
          "relay.terminal_retire_failed",
          `logical session retirement failed: ${err instanceof Error ? err.message : String(err)}`,
          {},
        );
      });
    const tracked = work.finally(() => {
      this.pendingRetirements.delete(tracked);
    });
    this.pendingRetirements.add(tracked);
  }

  private async stopTerminalSupervisor(): Promise<void> {
    if (!this.terminalSupervisor) return;
    try {
      await this.terminalSupervisor.stop();
    } catch {
      // ignore
    }
    this.terminalSupervisor = null;
  }

  async notifyTaskCompletion(task: OrchestrationTaskRecord): Promise<void> {
    this.sendNotice({
      kind: "task-completion",
      taskId: task.taskId,
      text: task.summary || task.resultText || task.taskId,
    });
  }

  async notifyTaskProgress(
    task: OrchestrationTaskRecord,
    text: string,
  ): Promise<void> {
    this.sendNotice({ kind: "task-progress", taskId: task.taskId, text });
  }

  async sendCoordinatorMessage(input: CoordinatorMessageInput): Promise<void> {
    this.sendNotice({
      kind: "coordinator-message",
      chatKey: input.chatKey,
      text: input.text,
    });
  }

  async sendScheduledMessage(
    input: ScheduledChannelMessageInput,
  ): Promise<void> {
    if (!this.control) {
      throw new Error(
        "relay channel cannot dispatch scheduled task before start()",
      );
    }
    const result = await this.control.runScheduledTurn({
      chatKey: input.chatKey,
      sessionAlias: input.sessionAlias,
      promptText: input.promptText,
      taskId: input.taskId ?? "",
      executeAt: input.executeAt ?? new Date(0).toISOString(),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
    if (!result.ok) {
      throw new Error(result.errorMessage ?? "scheduled turn failed");
    }
  }

  private sendNotice(payload: InstanceNoticePayload): void {
    this.client?.sendEvent(MSG.instanceNotice, payload);
  }

  /**
   * Safe, redacted resolution snapshot for bootstrap-failure logs. Paths are
   * trimmed to ~/… / last-two-segments; no env vars, credentials, or full PATH.
   */
  private resolutionForBootstrapLog(
    resolution: ResolvedRmuxBinaries | null | undefined,
  ): Record<string, string> {
    const base = {
      rmuxExpectedVersion: RMUX_BUNDLED_VERSION,
    };
    if (!resolution) return base;
    return {
      ...base,
      bridgeSource: resolution.source.bridge,
      bridgePath: redactPathForDoctor(resolution.bridgeCommand),
      ...(resolution.rmuxCommand && resolution.source.rmux
        ? {
            rmuxSource: resolution.source.rmux,
            rmuxPath: redactPathForDoctor(resolution.rmuxCommand),
          }
        : {}),
    };
  }

  /**
   * Registry → driver → reconcile, then return the capability snapshot for
   * handshake. Terminal disabled / unavailable → empty caps; chat still works.
   * When config flips enabled→disabled, still reads the existing registry and
   * retires leftover resources before omitting capabilities.
   */
  private async bootstrapTerminal(input: ChannelStartInput): Promise<string[]> {
    const registryDir =
      this.deps.terminalRegistryDir ?? defaultTerminalRegistryDir();

    if (!this.config.terminal.enabled) {
      try {
        await retireRelayTerminals({
          registryDir,
          terminalConfig: this.config.terminal,
          createDriver: this.deps.createTerminalDriver,
        });
      } catch (err) {
        void input.logger?.error(
          "relay.terminal_retire_on_disabled",
          `Failed to retire leftover terminals after terminal.enabled=false: ${err instanceof Error ? err.message : String(err)}`,
          {},
        );
      }

      return [];
    }

    const catalog = input.sessionResources as
      SessionResourceCatalog | undefined;
    if (!catalog) {
      throw new Error(
        "relay terminal.enabled requires ChannelStartInput.sessionResources (xacpx with SessionResourceCatalog)",
      );
    }
    this.startLogger = input.logger;

    const registry = new TerminalRegistryStore({
      dir: registryDir,
      exclusiveWriter: true,
    });
    try {
      let driver: RmuxTerminalDriver;
      if (this.deps.createTerminalDriver) {
        driver = this.deps.createTerminalDriver();
      } else {
        // Own the supervisor BEFORE start() so a handshake/spawn failure still
        // leaves this.terminalSupervisor populated with the binary resolution
        // (bridge/rmux source + redacted paths) for relay.terminal_bootstrap_failed.
        // createProductionTerminalDriver would only return after a successful
        // start and swallow this resolution on the failure path.
        const supervisor = new RmuxSidecarSupervisor({
          config: this.config.terminal,
        });
        this.terminalSupervisor = supervisor;
        driver = new SupervisedRmuxDriver(supervisor);
        await supervisor.start();
      }

      // The bridge handshake may succeed across mixed package versions, so the
      // renderer dialect must be validated explicitly before reconciliation or
      // Hub capability publication. On POSIX this includes the xterm-256color
      // dialect proof; Windows deliberately has no POSIX TERM requirement.
      const bridgeDiagnostics = await driver.diagnostics();
      const missingBridgeCapabilities = missingRequiredRmuxBridgeCapabilities(
        bridgeDiagnostics.capabilities,
      );
      if (missingBridgeCapabilities.length > 0) {
        throw new Error(
          `RMUX bridge is missing required terminal capabilities: ${missingBridgeCapabilities.join(", ")}`,
        );
      }

      const runtime = new DefaultRelayTerminalRuntime({
        registry,
        driver,
        catalog,
        config: this.config.terminal,
        onViewerEvent: (event, onFlush) => {
          this.viewerPublish?.(event, onFlush);
        },
      });
      await runtime.start();
      this.terminal = runtime;
      this.terminalReady = true;
      void logTerminalEvent(input.logger, "relay.terminal.runtime_ready", {
        capabilityCount: 2,
        maxSessions: this.config.terminal.maxSessions,
        maxViewersPerTerminal: this.config.terminal.maxViewersPerTerminal,
      });
      this.viewerPublish = createTerminalViewerPublisher(
        runtime,
        (type, payload, onFlush) => {
          if (!this.client) {
            onFlush?.(new Error("not-ready"));
            return;
          }
          this.client.sendEvent(type, payload, onFlush);
        },
      );

      this.catalogUnsub = catalog.subscribe((event) => {
        if (event.type === "archived" || event.type === "removed") {
          this.queueLogicalRetirement(
            runtime,
            event.session.logicalSessionId,
            event.type === "archived" ? "archive" : "delete",
          );
        }
        // restored: catalog view only — do not create/revive a terminal.
      });

      return [
        RELAY_CAPABILITIES.terminalRmuxRecoveryV1,
        RELAY_CAPABILITIES.terminalMultiViewV1,
      ];
    } catch (err) {
      const resolution = this.resolutionForBootstrapLog(
        this.terminalSupervisor?.getResolution(),
      );
      void logTerminalEvent(
        input.logger,
        "relay.terminal.runtime_unavailable",
        {
          errorClass: err instanceof Error ? err.name : "Error",
          ...resolution,
        },
      );
      void input.logger?.error(
        "relay.terminal_bootstrap_failed",
        `RMUX terminal runtime failed to start; continuing without terminal capabilities: ${err instanceof Error ? err.message : String(err)}`,
        resolution,
      );
      const running = this.terminal;
      this.terminal = null;
      this.terminalReady = false;
      if (running) {
        try {
          await running.stop();
        } catch {
          // ignore
        }
      } else {
        try {
          await registry.close();
        } catch {
          // ignore
        }
      }
      await this.stopTerminalSupervisor();
      return [];
    }
  }

  /** Test seam */
  getTerminalRuntimeForTests(): RelayTerminalRuntime | null {
    return this.terminal;
  }

  async sendAgentMessageRoute(payload: {
    sourceNodeId: string;
    sourceEndpointId: string;
    targetNodeId: string;
    targetEndpointId: string;
    messageId: string;
    content: string;
    requestedMode: string;
    replyTo?: string;
  }): Promise<{
    messageId: string;
    status: "injected" | "queued" | "failed";
    modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
    targetState?: "idle" | "running";
    errorCode?: string;
  }> {
    if (
      !this.client ||
      (typeof this.client.isReady === "function" && !this.client.isReady()) ||
      typeof this.client.sendRequest !== "function"
    ) {
      throw new Error("Relay client is offline or not ready");
    }
    return await this.client.sendRequest(MSG.agentMessageRoute, payload);
  }

  syncAgentEndpoints(endpoints: unknown[]): void {
    if (this.client && typeof this.client.sendEvent === "function") {
      this.client.sendEvent(MSG.instanceAgentEndpointsSync, { endpoints });
    }
  }

  /** Trailing-debounce the FULL directory sync after endpoint-affecting control
   *  events (sessions/worker bindings changed). Multiple mutations in a burst
   *  collapse into one snapshot push. */
  private scheduleEndpointSync(): void {
    if (this.endpointSyncTimer) clearTimeout(this.endpointSyncTimer);
    this.endpointSyncTimer = setTimeout(() => {
      this.endpointSyncTimer = null;
      this.syncAgentEndpointsNow();
    }, this.deps.endpointSyncDebounceMs ?? 250);
  }

  /** Read the authoritative local endpoint directory from the control facade and
   *  push it to the hub as a full snapshot (replace semantics). Best-effort. */
  syncAgentEndpointsNow(): void {
    const control = this.control;
    if (!control || !this.client) return;
    if (
      typeof (
        control as unknown as {
          getPublishedAgentEndpoints?: () => unknown[] | Promise<unknown[]>;
        }
      ).getPublishedAgentEndpoints !== "function"
    ) {
      return;
    }
    Promise.resolve(
      (
        control as unknown as {
          getPublishedAgentEndpoints: () => unknown[] | Promise<unknown[]>;
        }
      ).getPublishedAgentEndpoints(),
    )
      .then((endpoints) => {
        if (Array.isArray(endpoints) && this.client) {
          this.client.sendEvent(MSG.instanceAgentEndpointsSync, { endpoints });
        }
      })
      .catch(() => {
        // Best-effort: a transient control read failure must not break the
        // channel; the next event/onReady will retry the full sync.
      });
  }
}
