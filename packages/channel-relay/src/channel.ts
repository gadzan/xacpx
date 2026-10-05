import { homedir } from "node:os";
import { join } from "node:path";

import {
  MSG,
  RELAY_CAPABILITIES,
  RELAY_INTERACTION_RESPONSE_RESERVE_MS,
  type AgentDirectorySnapshotPayload,
  type AgentMessageCompletionPayload,
  type AgentMessageCompletionResult,
  type ConversationTurnCorrelationDto,
  type InstanceNoticePayload,
  type InstanceRecoveryAckPayload,
  type InteractionRequestDto,
  type InteractionResponseDto,
  type RelayEnvelope,
  parseControlPayload,
} from "@ganglion/xacpx-relay-protocol";
import { isDirectConversationChatKey, parseDirectConversationChatKey } from "xacpx/plugin-api";
import type {
  ChannelStartInput,
  ChannelElicitationDecision,
  ChannelElicitationMode,
  ChannelElicitationRequest,
  PublicControlService,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  ScheduledChannelMessageInput,
  SessionResourceCatalog,
} from "xacpx/plugin-api";
import { coreHomeDir } from "xacpx/plugin-api";

/** Mirrors core `ChannelStopReason` (exported from plugin-api once consumers pick up the bump). */
type ChannelStopReason = "shutdown" | "disabled" | "removed" | "logout";

import { parseRelayChannelConfig, type RelayChannelConfig } from "./config.js";
import type { TerminalViewerEvent } from "./terminal/terminal-runtime.js";
import { parseRelayInteractionOutcome, relayFieldsFrom } from "./relay-interaction.js";
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
import { DesktopTunnelRuntime } from "./desktop/desktop-tunnel-runtime.js";
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

/**
 * How long the interaction RPC may stay open, as the interaction's OWN window
 * plus a reserve for the decision that was made in time to still travel back.
 *
 * The window closes at `expiresAt`, but cutting the transport at the same
 * instant loses a decision the human already made. The reserve is the same one
 * the hub uses, so the two ends agree on the ceiling and neither side's timer is
 * the surprise. A hard floor keeps a window that has already passed from
 * producing a non-positive timeout, which would fail the RPC before it was sent.
 */
function windowTransportCeilingMs(expiresAt: number): number {
  return Math.max(1, expiresAt - Date.now()) + RELAY_INTERACTION_RESPONSE_RESERVE_MS;
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

/**
 * An interaction could not be opened, or was closed before a human decided.
 *
 * Distinct from a `ChannelElicitationDecision` on purpose, and the distinction is
 * the whole point. The renderer contract says an infrastructure close — timeout,
 * withdrawal, transport failure, shutdown, a destination that cannot be shown a
 * private form — is NOT a user action and must not carry an invented
 * `responderId`. Returning `{ action: "cancel", responderId: initiatorId }`
 * instead made core's re-verification compare the initiator with itself, so the
 * fake passed and an infrastructure close was committed as a user decision.
 *
 * Throwing this lets core's own abort race and post-decision checks settle the
 * request as `cancel`, which is the outcome these paths always intended.
 *
 * `reason` is for the channel's own logs and tests; core deliberately receives
 * no decision rather than a decision describing why not.
 */
export class RelayElicitationUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`relay elicitation is unavailable: ${reason}`);
    this.name = "RelayElicitationUnavailable";
  }
}

export class RelayChannel implements MessageChannelRuntime {
  readonly id = "relay";
  readonly nativeSessionListFormat = "table" as const;
  /**
   * Form capability, declared because this channel IMPLEMENTS it: rendering means
   * opening an interaction on the hub and waiting for the authenticated human's
   * answer, which `requestElicitation` does through the real Relay transport.
   *
   * A constant, not constructor state. There is no build where this channel
   * exists but cannot reach a hub — the renderer is the transport itself, so
   * "capable" and "implemented" cannot diverge. That is the one thing the plugin
   * contract's G9 forbids: declaring `form` while `requestElicitation` throws
   * would make the broker dispatch onto a channel that cannot answer. Core's own
   * probe still requires both halves, so an earlier build whose method was a stub
   * is caught by the runtime check rather than by this declaration.
   *
   * Note the scope this declaration does NOT express: it is per-CHANNEL, while
   * the renderer is per-ROUTE. A form is showable only on a Direct Conversation
   * turn (`bot:<conversation>:<topic>`); an ordinary session turn resolves to
   * `relay:<accountId>`, which has no `conversation` correlation and no surface
   * that mounts a form. `requestElicitation` refuses those turns itself — see
   * `unsupported-route` there — because this contract has no way to say "capable
   * on some routes only".
   */
  readonly elicitationModes: readonly ChannelElicitationMode[] = ["form"];

  private readonly config: RelayChannelConfig;
  private readonly credentials: CredentialStoreLike;
  private client: RelayClientLike | null = null;
  private unsubscribe: (() => void) | null = null;
  private catalogUnsub: (() => void) | null = null;
  private control: PublicControlService | null = null;
  private terminal: DefaultRelayTerminalRuntime | null = null;
  private terminalReady = false;
  private terminalSupervisor: RmuxSidecarSupervisor | null = null;
  private startLogger: ChannelStartInput["logger"] | undefined;
  private readonly pendingRetirements = new Set<Promise<void>>();
  private endpointSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private desktop: DesktopTunnelRuntime | null = null;

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
    this.desktop?.closeAll("logout");
    this.desktop = null;
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
    // Capture it for EVERY subsystem here, not inside each bootstrap: desktop is
    // config-only and does not go through the terminal path, so a terminal-disabled
    // + desktop-enabled channel would otherwise leave the tunnel runtime with no
    // logger at all and its probe/tunnel events silently dropped.
    this.startLogger = input.logger;

    const capabilities: string[] = [
      ...(await this.bootstrapTerminal(input)),
      // Interaction with the authenticated human, over the same connection that
      // already carries prompts. Advertised because `requestElicitation` is a
      // real implementation on this transport, and NOT advertised as a separate
      // flag that could rot: the capability IS the implementation.
      //
      // The permission half is deliberately absent — the wire carries the kind,
      // but nothing renders it yet, and advertising it would claim a capability
      // the connector cannot deliver.
      RELAY_CAPABILITIES.interactionElicitationFormV1,
    ];
    if (this.bootstrapDesktop())
      capabilities.push(RELAY_CAPABILITIES.desktopRfbV1);
    const bridge = createControlBridge(control, {
      ...(input.trustedConversationPrompt
        ? { trustedConversationPrompt: input.trustedConversationPrompt }
        : {}),
    });
    const onRequest = (
      envelope: RelayEnvelope,
      respond: (payload: unknown) => void,
    ) => {
      if (this.desktop && envelope.type === MSG.desktopPrepare) {
        void this.desktop.handlePrepare(envelope, respond);
        return;
      }
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

    // Declared before the client is created so the `onFatal` closure below and the
    // wait at the end of this method share the same slot.
    let fatalError: Error | null = null;
    let resolveStarted: () => void = () => {};
    const startedSettled = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

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
        if (this.desktop?.handleCancel(envelope)) return;
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
        this.desktop?.closeAll("control-disconnected");
      },
      logger: input.logger,
      onFatal: (reason) => {
        // A terminal connector failure must fail this start, because
        // `MessageChannelRegistry` only records a channel in
        // `failedStartupChannels` when `start()` rejects — and that record is the
        // only thing the declared-vs-live capability audit can read. Without it a
        // relay channel whose credential is stale keeps its advertised form
        // capability forever while every `requestElicitation` fails, which is the
        // capability lie M5 exists to stop.
        //
        // Deliberately NOT used for ordinary disconnects: those keep their own
        // reconnect path and must not be reported as a failed startup.
        fatalError ??= new Error(`relay channel stopped: ${reason}`);
        resolveStarted();
      },
      onReady: () => {
        // Ordinary Session liveness only. Hidden bot-direct aliases are
        // intentionally absent from listSessions; Conversation-correlated
        // turns stay in the snapshot via product correlation, not this set.
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
      const patch = mirror.handleEnvelope(type, payload);
      const forwardedPayload =
        patch && typeof payload === "object" && payload !== null
          ? {
              ...(payload as Record<string, unknown>),
              event: {
                ...(payload as { event: Record<string, unknown> }).event,
                ...patch,
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

    // The wait is a race between the daemon's shutdown signal and a terminal
    // connector failure. Resolving on the latter is what makes the failure visible
    // to the registry's readiness audit (see `onFatal` above).
    if (input.abortSignal.aborted) {
      resolveStarted();
    } else {
      input.abortSignal.addEventListener("abort", () => resolveStarted(), {
        once: true,
      });
    }
    await startedSettled;
    if (fatalError !== null) {
      await this.stop("error").catch(() => {});
      throw fatalError;
    }
    await this.stop("shutdown");
  }

  /** Mutable slot filled after client construction so runtime events reach the hub. */
  private viewerPublish:
    | ((event: TerminalViewerEvent, onFlush?: (error?: Error) => void) => void)
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
    this.desktop?.closeAll("stop");
    this.desktop = null;

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

  /**
   * Render an ACP form elicitation by OPENING an interaction on the hub.
   *
   * This is the real production direction and it is dial-out: core's broker calls
   * this channel, and this channel asks the hub to put the form in front of its
   * authenticated human. There is no other entry point — `interaction-opened`
   * exists only because an interaction was opened here, and the browser answer
   * exists only because this call is still waiting for it.
   *
   * The frame that travels is the one built from CORE's normalized request, so
   * the browser sees exactly what the agent asked, bounded by core's own
   * validation. Nothing is re-derived here, least of all identity.
   *
   * Fail-closed table (every one of these closes the interaction; none fabricate
   * a decision, and none report a user's action that did not happen):
   *
   * - hub offline / not ready      -> `cancel` (no route to a human)
   * - `senderId` unreachable       -> `cancel` (an unauthenticated turn cannot
   *                                        route to an authenticated human)
   * - transport timeout / disconnect -> `cancel`
   * - `abort`/turn disposal         -> `cancel`
   * - hub answers `responded:false` -> the hub's own reason (timeout/unsupported)
   *
   * `decline` is NEVER synthesized: only a real browser action produces it, and
   * the browser's `interaction-closed`/`decline` is what carries it.
   */
  async requestElicitation(
    request: ChannelElicitationRequest,
  ): Promise<ChannelElicitationDecision> {
    const requestId = request.requestId;
    const expiresAt = request.expiresAt;
    if (!this.isClientReady()) {
      // Not started, or started but no hub link: there is nowhere to open an
      // interaction. `startLogger` is NOT the signal here — it is only assigned
      // on the terminal-enabled bootstrap branch, so an ordinary production
      // channel (terminal disabled) would bail on a logger that was never set.
      //
      // Rejected rather than answered: no human was asked, so there is no user
      // decision to report, and a `responderId` here would be invented.
      throw new RelayElicitationUnavailable("channel-missing");
    }
    // The turn's own initiator, used for ONE purpose: refusing to open an
    // interaction for a turn that has no attributable human. It is deliberately
    // NOT the identity reported back on a decision.
    //
    // The reported responder is the one the HUB stamped from its authenticated
    // session — see the mapping below. Echoing the initiator instead would turn
    // core's re-verification into `initiator == initiator`, which is a tautology
    // and would let a decision by anybody pass as the turn's initiator.
    const initiatorId = request.requester?.senderId ?? "";
    if (!initiatorId) {
      throw new RelayElicitationUnavailable("unattributable");
    }
    // Only a provably private destination may show a form: an elicitation
    // contains the agent's question and the human's answer, and neither belongs
    // where a group can read it. `undefined` is treated as unproven, NOT as
    // direct — the caller must have the channel's own report.
    if (request.chatType !== "direct") {
      await this.startLogger?.warn(
        "relay.elicitation.rejected",
        "relay renderer refuses a form it cannot prove is direct",
        { requestId, chatType: request.chatType },
      );
      throw new RelayElicitationUnavailable("not-direct");
    }
    // ROUTE-SCOPED capability, which is what the channel-wide
    // `elicitationModes = ["form"]` above could not express.
    //
    // A form is renderable on exactly one route: a Direct Conversation turn,
    // whose chatKey is `bot:<conversation>:<topic>`. That key is what yields the
    // `conversation` product correlation the web form needs to find its topic,
    // and it is the only surface that mounts a renderer — the Direct Bot pane.
    // An ordinary Relay session turn resolves its route to `relay:<accountId>`
    // (the permission fallback), so its `conversationCorrelation()` is
    // `undefined` and the frame it produces belongs to no topic at all.
    //
    // Declaring `form` channel-wide while only that one route can render made
    // every ordinary session turn also request a form. The hub opened the
    // interaction, the uncorrelated frame was scoped out of every topic view,
    // and the result was a form nobody could see reaching its timeout. That is
    // worse than refusing: an agent told the human was asked when no human ever
    // saw the question.
    if (!isDirectConversationChatKey(request.chatKey)) {
      await this.startLogger?.warn(
        "relay.elicitation.rejected",
        "relay form renderer is route-scoped to Direct Conversation turns",
        { requestId, chatKey: request.chatKey },
      );
      throw new RelayElicitationUnavailable("unsupported-route");
    }
    const fields = relayFieldsFrom(request.fields);
    if (fields === null) {
      // Core and the wire disagree on the field model. Closing rather than
      // projecting a partial form: an answer to a form the agent did not ask for
      // is worse than no answer.
      await this.startLogger?.warn("relay.elicitation.rejected", "core/wire field model drift", {
        requestId,
      });
      throw new RelayElicitationUnavailable("unsupported");
    }
    const correlation = this.conversationCorrelation(request);
    const interaction: InteractionRequestDto = {
      requestId,
      kind: "elicitation",
      ...(correlation !== undefined ? { conversation: correlation } : {}),
      expiresAt,
      elicitation: {
        mode: "form",
        message: request.message,
        fields,
        ...(request.schemaTitle !== undefined ? { schemaTitle: request.schemaTitle } : {}),
        // The schema-level DESCRIPTION travels with the title, for the reason the
        // wire validator allows an empty `message`: a schema with a good title and
        // description needs no prose. Dropping it left Relay Web with nothing at
        // all above the fields when the agent sent an empty message plus
        // `schemaTitle` — the form lost its own question.
        ...(request.schemaDescription !== undefined ? { schemaDescription: request.schemaDescription } : {}),
        // The asking Agent, carried across the wire because it is an IDENTITY and
        // not presentation. Dropping it here is what made the relay web form show
        // only a generic "Input needed" while core knew perfectly well which
        // agent was asking — and a renderer must not reconstruct identity out of
        // `message`/`schemaTitle`, both of which the agent controls.
        agent: {
          name: request.agent.name,
          ...(request.agent.sessionAlias !== undefined ? { sessionAlias: request.agent.sessionAlias } : {}),
        },
      },
    };
    try {
      // The window's own deadline plus a reserve IS the transport ceiling, so a
      // slow-but-legal answer is never cut off by a generic connector timeout,
      // while a dead one still expires.
      const timeoutMs = windowTransportCeilingMs(expiresAt);
      const relayResult = await this.sendInteractionRequest(interaction, timeoutMs, request.signal);
      const outcome = parseRelayInteractionOutcome(relayResult);
      if (!outcome.responded) {
        // Not a user action: the hub closed the window (timeout, unsupported,
        // withdrawn). The agent must learn the turn produced no decision, and the
        // form is withdrawn with it — the hub already removed the pending
        // interaction and told every browser, so there is nothing left to collect.
        //
        // This REJECTS rather than returning a decision, because the renderer
        // contract forbids inventing one: `request.signal` abort and every
        // infrastructure close are not user actions, and no authenticated human
        // answered. Returning `{ action: "cancel", responderId: initiatorId }`
        // here — which is what this did — faked a responder that happens to equal
        // the turn initiator, so the broker's re-verification PASSED and committed
        // an infrastructure close as a real user decision.
        //
        // Rejecting is safe and not a silent failure: the broker's own abort race
        // and its post-decision checks settle the request as `cancel` either way,
        // which is the outcome this path always intended.
        await this.startLogger?.warn("relay.elicitation.closed", "relay interaction closed without a user decision", {
          requestId,
          reason: outcome.reason,
        });
        throw new RelayElicitationUnavailable(outcome.reason);
      }
      const decision = outcome.response;
      // THE LOAD-BEARING LINE: the responder is the one the HUB stamped from its
      // own authenticated session — never the initiator this channel started
      // with, and never anything derived here.
      //
      // Reporting the initiator would make core's re-verification compare it with
      // itself, which is a tautology: it would pass for a decision made by ANY
      // authenticated account, or by none at all.
      const responderId = decision.responderId;
      // Narrowed to the elicitation action set. A permission action
      // (`allow_once` and friends) on an elicitation is a protocol surprise, not
      // a decision to pass to core — core would reject it, so refuse here with
      // the same cancel the surprising frame is worth.
      if (decision.action === "accept") {
        // `content` is passed through verbatim, including `undefined` and `null`:
        // core validates the answer set against its own frozen snapshot, so this
        // channel never decides whether the answers were enough.
        return { action: "accept", responderId, content: decision.content };
      }
      if (decision.action === "decline" || decision.action === "cancel") {
        return { action: decision.action, responderId };
      }
      // An action outside the elicitation set is a protocol surprise. Rejected
      // rather than mapped to `cancel`: a cancel is a USER action, and the
      // responder here would be invented — the same failure that made
      // infrastructure closes commit as user decisions, in a smaller dose.
      throw new RelayElicitationUnavailable("unsupported-action");
    } catch (error) {
      // Transport failure, or the request signal fired while the RPC was still
      // in flight. Either way there is no decision to report and the interaction
      // is abandoned — core's own fence settles the abort.
      //
      // The withdrawal is also emitted here, not only on the signal path: a
      // transport failure can happen after the hub already opened the
      // interaction, and leaving it open would collect answers for a turn whose
      // outcome is already settled. Idempotent, so nothing double-closes.
      this.withdrawInteraction(requestId);
      await this.startLogger?.warn("relay.elicitation.failed", "relay elicitation transport failed", {
        requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      // REJECTED, not returned. The renderer contract is explicit that an
      // infrastructure failure is not a user action and must not carry an invented
      // `responderId`; returning one that equals the turn initiator would pass
      // the broker's re-verification and commit a transport failure as a user's
      // decision. Rejecting lets core's abort race and post-decision checks
      // settle the request as `cancel`, which is the intended outcome.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Open the interaction on the hub and wait for the human's answer.
   *
   * Abort is propagated in BOTH directions, because a request that is abandoned
   * mid-flight must not leave a live form on someone's screen:
   *
   *   outbound — core aborts (turn disposal, agent `$/cancel_request`, timeout).
   *     Rejecting this promise locally is NOT enough on its own: the hub would
   *     keep the interaction open and keep collecting answers for a turn that no
   *     longer exists. So the abort also sends `control.interaction.withdraw`,
   *     which closes the hub's pending entry, broadcasts `interaction-closed:
   *     withdrawn` to every browser, and makes a later answer `409 gone`.
   *   inbound — if the transport rejects because the socket went away, we
   *     surface it as a rejection rather than a hang, and the caller's catch
   *     closes the interaction.
   *
   * The withdrawal is fire-and-forget: the local promise is already settled, and
   * the hub's `close` is idempotent, so a withdrawal that loses a race against
   * the human's own answer is a no-op rather than an error.
   */
  private sendInteractionRequest(
    interaction: InteractionRequestDto,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal?.aborted) {
      return Promise.reject(new Error("elicitation interaction aborted"));
    }
    const client = this.client;
    if (!client || typeof client.sendRequest !== "function") {
      return Promise.reject(new Error("relay client cannot send requests"));
    }
    const inFlight = client.sendRequest(MSG.interactionRequest, interaction, { timeoutMs });
    if (!signal) return inFlight;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        // Withdraw on the hub BEFORE settling locally, so the form disappears for
        // the human in the same tick the agent stops waiting for it.
        this.withdrawInteraction(interaction.requestId);
        reject(new Error("elicitation interaction aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      inFlight.then(
        (value) => resolve(value),
        (error: unknown) => reject(error),
      ).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /**
   * Tell the hub to close an interaction that is still open.
   *
   * Deliberately not awaited by the abort path: the caller's promise is already
   * settled, and a withdrawal must never delay or block the local outcome. The
   * hub's registry treats a withdrawal of an already-closed interaction as
   * success, so this cannot be observed as a failure.
   */
  private withdrawInteraction(requestId: string): void {
    const client = this.client;
    if (!client || typeof client.sendRequest !== "function") return;
    try {
      void Promise.resolve(
        client.sendRequest(MSG.interactionWithdraw, { requestId }, { timeoutMs: 5_000 }),
      ).catch(() => {
        // The socket went away with the interaction. Nothing to withdraw: the hub
        // drops every interaction a disconnected connector opened.
      });
    } catch {
      // Same as above for a synchronous throw — the hub already withdrew on
      // disconnect, so there is no state left to clean up.
    }
  }

  /**
   * Product correlation for the web UI's product surface, or `undefined` for an
   * interaction with no Conversation product row.
   *
   * Reads the Direct Conversation key from the turn's own route, which core
   * already validated and which `parseDirectConversationChatKey` parses strictly
   * (`bot:garbage` yields nothing). A `relay:` chatKey or any unprefixed key means
   * the turn is an ordinary channel turn with no product row, and fabricating one
   * would make the browser open the form on a conversation that does not own it.
   *
   * Only the product keys are carried. The durable row ids
   * (`botId`/`runId`/`memberTurnId`) are left absent because the connector has no
   * way to know them, and an empty string would compare equal to any other empty
   * string and satisfy a join it should not. Never a hidden `brt_*` alias — that
   * is runtime plumbing, and the wire validator rejects it.
   *
   * `replyContextToken` is deliberately NOT mapped to `promptRequestId`. It is
   * the trusted INGRESS chat key (`relay:<accountId>`) that carries the human's
   * return address, which is a different concept from the prompt request id the
   * web correlate uses. Coercing one into the other produced a correlation that
   * looked populated but joined on nothing.
   */
  private conversationCorrelation(
    request: ChannelElicitationRequest,
  ): ConversationTurnCorrelationDto | undefined {
    const parsed = parseDirectConversationChatKey(request.chatKey);
    if (!parsed) return undefined;
    return {
      conversationId: parsed.conversationId,
      topicId: parsed.topicId,
    };
  }

  private isClientReady(): boolean {
    if (!this.client) return false;
    if (typeof this.client.isReady !== "function") return true;
    return this.client.isReady();
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
    // `startLogger` is captured once in start(), before either bootstrap runs.

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

  /** Test seam: the runtime built by bootstrapDesktop, so tests can assert it
   *  received the channel's logger in a desktop-only (terminal-disabled) start. */
  getDesktopRuntimeForTests(): DesktopTunnelRuntime | null {
    return this.desktop;
  }

  /** Desktop is config-only: enabled → runtime + `desktop.rfb.v1` capability. */
  private bootstrapDesktop(): boolean {
    if (!this.config.desktop.enabled) {
      this.desktop = null;
      return false;
    }
    this.desktop = new DesktopTunnelRuntime({
      config: this.config.desktop,
      hubUrl: this.config.url,
      ...(this.startLogger ? { logger: this.startLogger } : {}),
    });
    return true;
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

  async sendAgentMessageCompletion(
    payload: AgentMessageCompletionPayload,
  ): Promise<AgentMessageCompletionResult> {
    if (
      !this.client ||
      (typeof this.client.isReady === "function" && !this.client.isReady()) ||
      typeof this.client.sendRequest !== "function"
    ) {
      throw new Error("Relay client is offline or not ready");
    }
    return await this.client.sendRequest(MSG.agentMessageCompletion, payload);
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
