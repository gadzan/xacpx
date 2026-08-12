// RelayTerminalRuntime — deep module (spec §9–§11).
//
// LOCK ORDER (must never reverse):
//   1. per-logical-session mutex
//   2. per-terminal mutex
//
// `openOrResume` always acquires the logical lock first, then the terminal
// lock when mutating a known terminalId. `terminate` / recovery / input take
// only the per-terminal lock (they already know terminalId). Never acquire
// logical-after-terminal.
//
// Viewer/controller/recovery state stays in memory via TerminalAttachmentRegistry.
// Durable creating/live/reaping transitions go through TerminalRegistryStore.
import type { TerminalReconciler } from "./terminal-reconciler.js";
import { TerminalReconciler as TerminalReconcilerImpl } from "./terminal-reconciler.js";
import type { TerminalRecordV1, TerminalReapReason } from "./terminal-types.js";
import type { TerminalRegistryStore } from "./terminal-registry-store.js";
import {
  type RmuxRecoveryEvent,
  type RmuxTerminalDriver,
} from "./rmux-driver.js";
import type { RelayTerminalConfig } from "../config.js";
import {
  TerminalAttachmentGenerationMismatchError,
  TerminalAttachmentNotFoundError,
  TerminalAttachmentRegistry,
  TerminalNotControllerError,
  TerminalViewerCapacityExceededError,
  type TerminalAttachmentEvent,
} from "./terminal-attachments.js";
import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
} from "xacpx/plugin-api";
import {
  TERMINAL_REBASE_CHUNK_BYTES,
  type TerminalErrorCode,
} from "@ganglion/xacpx-relay-protocol";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

const RELAY_CHANNEL_ID = "relay";
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_LAST_INPUT_CHECKPOINT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public result types (spec §9)
// ---------------------------------------------------------------------------

/** Whether this open created the RMUX session or attached to an existing one.
 *  Connector-local only — never forwarded on the Hub wire response. */
export type TerminalOpenKind = "created" | "resumed";

export interface TerminalOpenResult {
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller" | "spectator";
  viewerCount: number;
  openKind: TerminalOpenKind;
}

/** Strip connector-local fields before responding to the Hub. */
export function toTerminalOpenWireResult(result: TerminalOpenResult): {
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller" | "spectator";
  viewerCount: number;
} {
  return {
    terminalId: result.terminalId,
    generation: result.generation,
    attachmentId: result.attachmentId,
    role: result.role,
    viewerCount: result.viewerCount,
  };
}

export interface TerminalRoleResult {
  terminalId: string;
  generation: string;
  attachmentId: string;
  role: "controller";
  viewerCount: number;
}

export type TerminalTerminateResult =
  | { status: "terminated" }
  | { status: "cleanup-pending" };

export type TerminalViewerEvent =
  | {
    type: "rebase-start";
    attachmentId: string;
    terminalId: string;
    generation: string;
    epoch: number;
    nextSequence: number;
    cols: number;
    rows: number;
    alternate: boolean;
    totalBytes: number;
    chunkCount: number;
  }
  | {
    type: "rebase-chunk";
    attachmentId: string;
    terminalId: string;
    generation: string;
    epoch: number;
    index: number;
    dataBase64: string;
  }
  | {
    type: "rebase-end";
    attachmentId: string;
    terminalId: string;
    generation: string;
    epoch: number;
  }
  | {
    type: "bytes";
    attachmentId: string;
    terminalId: string;
    generation: string;
    epoch: number;
    sequence: number;
    dataBase64: string;
  }
  | {
    type: "exit";
    attachmentId: string;
    terminalId: string;
    generation: string;
    code?: number;
    reason: string;
  }
  | {
    type: "role-changed";
    attachmentId: string;
    terminalId: string;
    role: "controller" | "spectator";
    viewerCount: number;
  }
  | {
    type: "queue-overflow";
    attachmentId: string;
    terminalId: string;
  };

export interface RelayTerminalRuntime {
  start(): Promise<void>;
  openOrResume(input: {
    chatKey: string;
    sessionAlias: string;
    viewerId: string;
    cols: number;
    rows: number;
  }): Promise<TerminalOpenResult>;
  /** Late Hub timeout: detach resume; terminate create only when still sole owner. */
  compensateTimedOutOpen(result: TerminalOpenResult): Promise<void>;
  startRecovery(attachmentId: string): Promise<void>;
  detach(attachmentId: string): void;
  detachAllAttachments(): void;
  peekAttachment(attachmentId: string): {
    viewerId: string;
    terminalId: string;
    generation: string;
    role: "controller" | "spectator";
  } | undefined;
  heartbeat(attachmentId: string): void;
  input(attachmentId: string, generation: string, data: Uint8Array): Promise<void>;
  resize(attachmentId: string, generation: string, cols: number, rows: number): Promise<void>;
  takeControl(attachmentId: string, generation: string): Promise<TerminalRoleResult>;
  resync(attachmentId: string, generation: string): Promise<void>;
  terminate(input: {
    terminalId: string;
    generation: string;
    reason: "explicit-close" | "archive" | "delete" | "idle" | "disabled";
  }): Promise<TerminalTerminateResult>;
  retireLogicalSession(logicalSessionId: string, reason: "archive" | "delete"): Promise<void>;
  terminateAll(reason: "disabled" | "logout"): Promise<void>;
  stop(): Promise<void>;
}

export class TerminalRuntimeError extends Error {
  readonly code: TerminalErrorCode;

  constructor(code: TerminalErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TerminalRuntimeError";
    this.code = code;
  }
}

export interface TerminalRuntimeClock {
  now(): number;
}

export interface TerminalRuntimeOptions {
  registry: TerminalRegistryStore;
  driver: RmuxTerminalDriver;
  catalog: SessionResourceCatalog;
  config: RelayTerminalConfig;
  /**
   * Deliver a viewer event toward the Hub. When `onFlush` is provided (byte-
   * carrying frames), call it after the underlying websocket flush/error so
   * outbound backpressure can track pending — not lifetime — bytes.
   */
  onViewerEvent: (
    event: TerminalViewerEvent,
    onFlush?: (error?: Error) => void,
  ) => void;
  clock?: TerminalRuntimeClock;
  killTimeoutMs?: number;
  lastInputCheckpointMinIntervalMs?: number;
  randomUUID?: () => string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.tail;
    this.tail = prev.then(() => gate, () => gate);
    return prev.then(fn).finally(release);
  }
}

interface LiveHandle {
  terminalId: string;
  generation: string;
  logicalSessionId: string;
  rmuxSessionId: string;
  paneId: string;
  /** In-memory idle clock (ms); refreshed only by open/takeControl/controller input. */
  lastActivityAt: number;
  leaseLost: boolean;
  /** Last durable lastInputAt checkpoint time (ms). */
  lastCheckpointAt: number;
}

interface RecoveryLoop {
  attachmentId: string;
  abort: AbortController;
  done: Promise<void>;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function chunkCountFor(totalBytes: number): number {
  return totalBytes === 0 ? 0 : Math.ceil(totalBytes / TERMINAL_REBASE_CHUNK_BYTES);
}

function buildRmuxName(installationId: string, terminalId: string): string {
  return `xacpx-relay-${installationId.slice(0, 8)}-${terminalId.replaceAll("-", "")}`;
}

function buildTags(input: {
  installationId: string;
  logicalSessionId: string;
  terminalId: string;
  generation: string;
}): string[] {
  return [
    "xacpx:relay",
    `owner:${input.installationId}`,
    `logical:${input.logicalSessionId}`,
    `terminal:${input.terminalId}`,
    `generation:${input.generation}`,
    "schema:1",
  ];
}

function findByLogical(
  terminals: Readonly<Record<string, TerminalRecordV1>>,
  logicalSessionId: string,
): TerminalRecordV1 | undefined {
  for (const rec of Object.values(terminals)) {
    if (rec.logicalSessionId === logicalSessionId) return rec;
  }
  return undefined;
}

function mapAttachmentError(err: unknown): never {
  if (err instanceof TerminalAttachmentNotFoundError) {
    throw new TerminalRuntimeError("terminal-attachment-not-found", err.message);
  }
  if (err instanceof TerminalAttachmentGenerationMismatchError) {
    throw new TerminalRuntimeError("terminal-generation-mismatch", err.message);
  }
  if (err instanceof TerminalNotControllerError) {
    throw new TerminalRuntimeError("terminal-not-controller", err.message);
  }
  if (err instanceof TerminalViewerCapacityExceededError) {
    throw new TerminalRuntimeError("terminal-viewer-capacity-exceeded", err.message);
  }
  throw err;
}

export class DefaultRelayTerminalRuntime implements RelayTerminalRuntime {
  private readonly registry: TerminalRegistryStore;
  private readonly driver: RmuxTerminalDriver;
  private readonly catalog: SessionResourceCatalog;
  private readonly config: RelayTerminalConfig;
  private readonly onViewerEvent: (
    event: TerminalViewerEvent,
    onFlush?: (error?: Error) => void,
  ) => void;
  private readonly clock: TerminalRuntimeClock;
  private readonly killTimeoutMs: number;
  private readonly checkpointIntervalMs: number;
  private readonly randomUUID: () => string;

  private readonly logicalLocks = new Map<string, AsyncMutex>();
  private readonly terminalLocks = new Map<string, AsyncMutex>();
  private readonly handles = new Map<string, LiveHandle>();
  private readonly recoveries = new Map<string, RecoveryLoop>();
  private readonly attachments: TerminalAttachmentRegistry;

  private started = false;
  private stopped = false;
  /** paneId lookup after adopt/create — keyed by terminalId. */
  private paneByTerminal = new Map<string, string>();
  private readonly reconciler: TerminalReconciler;
  private attachmentSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TerminalRuntimeOptions) {
    this.registry = options.registry;
    this.driver = options.driver;
    this.catalog = options.catalog;
    this.config = options.config;
    this.onViewerEvent = options.onViewerEvent;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
    this.checkpointIntervalMs =
      options.lastInputCheckpointMinIntervalMs ?? DEFAULT_LAST_INPUT_CHECKPOINT_MS;
    this.randomUUID = options.randomUUID ?? (() => randomUUID());

    this.attachments = new TerminalAttachmentRegistry({
      maxViewersPerTerminal: this.config.maxViewersPerTerminal,
      attachmentTtlMs: this.config.attachmentTtlSeconds * 1000,
      clock: this.clock,
      onEvent: (event) => this.forwardAttachmentEvent(event),
      randomId: () => this.randomUUID(),
    });

    this.reconciler = new TerminalReconcilerImpl({
      host: {
        registry: this.registry,
        driver: this.driver,
        catalog: this.catalog,
        config: this.config,
        clock: this.clock,
        withTerminalLock: (terminalId, fn) => this.withTerminalLock(terminalId, fn),
        hasLiveHandle: (terminalId) => this.handles.has(terminalId),
        onResourceAbsent: (terminalId, generation, reason) => {
          this.handles.delete(terminalId);
          this.paneByTerminal.delete(terminalId);
          void this.stopAllRecoveriesForTerminal(terminalId, { wait: false });
          this.emitExitToViewers(terminalId, generation, reason);
          for (const a of this.attachments.listByTerminal(terminalId)) {
            this.attachments.detach(a.attachmentId);
          }
        },
        onFence: (terminalId) => {
          const handle = this.handles.get(terminalId);
          if (handle) handle.leaseLost = true;
          void this.stopAllRecoveriesForTerminal(terminalId, { wait: false });
        },
        killWithTimeout: (sessionId) => this.killWithTimeout(sessionId),
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.registry.load();
    // Spec §12.4 process-owned: reap leftover registry records before hub connect.
    await this.reconciler.runOnce();
    this.started = true;
    this.reconciler.startPeriodic();
    const sweepMs = Math.max(1_000, Math.min(15_000, Math.floor(this.config.attachmentTtlSeconds * 250)));
    this.attachmentSweepTimer = setInterval(() => {
      this.sweepExpiredAttachments();
    }, sweepMs);
    this.attachmentSweepTimer.unref?.();
  }

  /** Detach attachments whose heartbeat TTL expired (best-effort Hub detach fallback). */
  sweepExpiredAttachments(): string[] {
    if (!this.started || this.stopped) return [];
    const expired = this.attachments.expireStale(this.clock.now());
    for (const attachmentId of expired) {
      void this.stopRecovery(attachmentId, { wait: false });
    }
    return expired;
  }

  /** Test/ops seam: run one mark-and-sweep pass without waiting for the timer. */
  async reconcileOnce(): Promise<void> {
    this.assertStarted();
    await this.reconciler.runOnce();
  }

  async openOrResume(input: {
    chatKey: string;
    sessionAlias: string;
    viewerId: string;
    cols: number;
    rows: number;
  }): Promise<TerminalOpenResult> {
    this.assertStarted();
    if (!this.config.enabled) {
      throw new TerminalRuntimeError("terminal-disabled");
    }

    const descriptor = await this.resolveDescriptor(input.chatKey, input.sessionAlias);
    return this.withLogicalLock(descriptor.logicalSessionId, async () => {
      // Re-check under lock — another open may have created meanwhile.
      let snap = this.registry.getSnapshot();
      const existing = findByLogical(snap.terminals, descriptor.logicalSessionId);

      if (existing?.state === "reaping") {
        throw new TerminalRuntimeError("terminal-terminating");
      }

      if (existing?.state === "live") {
        return this.withTerminalLock(existing.terminalId, async () => {
          await this.refreshIdle(existing.terminalId, true);
          return this.attachViewer(existing, input.viewerId, "resumed");
        });
      }

      if (existing?.state === "creating") {
        // Serialized opens: if we observe creating under the logical lock, the
        // creator still holds work — treat as terminating/in-progress failure
        // surface rather than starting a second create.
        throw new TerminalRuntimeError("terminal-terminating");
      }

      await this.reapExpiredForQuota();
      snap = this.registry.getSnapshot();
      const activeCount = Object.values(snap.terminals).filter(
        (t) => t.state === "live" || t.state === "creating",
      ).length;
      if (activeCount >= this.config.maxSessions) {
        throw new TerminalRuntimeError("terminal-capacity-exceeded");
      }

      const terminalId = this.randomUUID();
      const generation = this.randomUUID();
      const rmuxSessionName = buildRmuxName(snap.installationId, terminalId);
      const tags = buildTags({
        installationId: snap.installationId,
        logicalSessionId: descriptor.logicalSessionId,
        terminalId,
        generation,
      });
      const nowIso = new Date(this.clock.now()).toISOString();

      // Durable creating BEFORE driver side effect (spec §10.4).
      await this.registry.upsertCreating({
        terminalId,
        logicalSessionId: descriptor.logicalSessionId,
        internalAliasSnapshot: descriptor.internalAlias,
        rmuxSessionName,
        generation,
        createdAt: nowIso,
        lastInputAt: nowIso,
      });

      let sessionId: string | undefined;
      let paneId: string | undefined;
      try {
        const created = await this.driver.create({
          name: rmuxSessionName,
          cwd: descriptor.cwd,
          cols: input.cols,
          rows: input.rows,
          historyLimit: this.config.historyLimit,
          tags,
          ownerLeaseTtlSeconds: this.config.ownerLeaseTtlSeconds,
        });
        sessionId = created.sessionId;
        paneId = created.paneId;

        await this.registry.markLive(terminalId, {
          rmuxSessionId: created.sessionId,
        });
      } catch (err) {
        await this.compensateFailedCreate(terminalId, sessionId);
        if (err instanceof TerminalRuntimeError) throw err;
        throw new TerminalRuntimeError(
          "terminal-rmux-unavailable",
          err instanceof Error ? err.message : String(err),
        );
      }

      const live = this.registry.getSnapshot().terminals[terminalId];
      if (!live || live.state !== "live" || paneId === undefined) {
        await this.compensateFailedCreate(terminalId, sessionId);
        throw new TerminalRuntimeError("terminal-rmux-unavailable");
      }

      this.installHandle(live, paneId, this.clock.now());
      return this.withTerminalLock(terminalId, async () => this.attachViewer(live, input.viewerId, "created"));
    });
  }

  /**
   * Hub/connector already answered timeout for this open. Late success must not
   * kill a shared shell: resume → detach only; create → terminate only when this
   * generation is still live and no other viewers remain after our detach.
   */
  async compensateTimedOutOpen(result: TerminalOpenResult): Promise<void> {
    this.assertStarted();
    if (result.openKind === "resumed") {
      void this.stopRecovery(result.attachmentId, { wait: false });
      this.detach(result.attachmentId);
      return;
    }

    await this.withTerminalLock(result.terminalId, async () => {
      const snap = this.registry.getSnapshot().terminals[result.terminalId];
      if (!snap || snap.generation !== result.generation) {
        void this.stopRecovery(result.attachmentId, { wait: false });
        this.detach(result.attachmentId);
        return;
      }
      void this.stopRecovery(result.attachmentId, { wait: false });
      this.detach(result.attachmentId);
      if (this.attachments.listByTerminal(result.terminalId).length > 0) {
        // Another viewer attached after our create; keep the shared shell.
        return;
      }
      await this.terminateUnlocked(result.terminalId, result.generation, "explicit-close");
    });
  }

  async startRecovery(attachmentId: string): Promise<void> {
    this.assertStarted();
    const attachment = this.attachments.getAttachment(attachmentId);
    if (!attachment) {
      throw new TerminalRuntimeError("terminal-attachment-not-found");
    }

    await this.withTerminalLock(attachment.terminalId, async () => {
      const handle = this.requireLiveHandle(attachment.terminalId);
      if (handle.generation !== attachment.generation) {
        throw new TerminalRuntimeError("terminal-generation-mismatch");
      }
      // Restart if already running (resync path).
      await this.stopRecovery(attachmentId);

      const abort = new AbortController();
      const done = this.runRecoveryLoop({
        attachmentId,
        terminalId: attachment.terminalId,
        generation: attachment.generation,
        paneId: handle.paneId,
        signal: abort.signal,
      });
      this.recoveries.set(attachmentId, { attachmentId, abort, done });
    });
  }

  detach(attachmentId: string): void {
    void this.stopRecovery(attachmentId);
    this.attachments.detach(attachmentId);
  }

  /** Clear all viewer attachments (and their recovery streams) without touching
   *  RMUX owner leases — used when the hub WebSocket drops (spec §12.2). */
  detachAllAttachments(): void {
    const ids = this.attachments.listAll().map((a) => a.attachmentId);
    for (const id of ids) void this.stopRecovery(id, { wait: false });
    this.attachments.detachMany(ids);
  }

  peekAttachment(attachmentId: string): {
    viewerId: string;
    terminalId: string;
    generation: string;
    role: "controller" | "spectator";
  } | undefined {
    const a = this.attachments.getAttachment(attachmentId);
    if (!a) return undefined;
    return {
      viewerId: a.viewerId,
      terminalId: a.terminalId,
      generation: a.generation,
      role: a.role,
    };
  }

  heartbeat(attachmentId: string): void {
    try {
      this.attachments.heartbeat(attachmentId);
    } catch (err) {
      mapAttachmentError(err);
    }
  }

  async input(attachmentId: string, generation: string, data: Uint8Array): Promise<void> {
    this.assertStarted();
    const attachment = this.attachments.getAttachment(attachmentId);
    if (!attachment) throw new TerminalRuntimeError("terminal-attachment-not-found");

    await this.withTerminalLock(attachment.terminalId, async () => {
      try {
        this.attachments.assertCanInput(attachmentId, generation);
      } catch (err) {
        mapAttachmentError(err);
      }
      const handle = this.requireLiveHandle(attachment.terminalId);
      this.assertNotFenced(handle);
      try {
        await this.driver.input(handle.paneId, data);
      } catch (err) {
        this.handleDriverMutationError(handle, err);
      }
      await this.refreshIdle(attachment.terminalId, false);
    });
  }

  async resize(attachmentId: string, generation: string, cols: number, rows: number): Promise<void> {
    this.assertStarted();
    const attachment = this.attachments.getAttachment(attachmentId);
    if (!attachment) throw new TerminalRuntimeError("terminal-attachment-not-found");

    await this.withTerminalLock(attachment.terminalId, async () => {
      try {
        this.attachments.assertCanResize(attachmentId, generation);
      } catch (err) {
        mapAttachmentError(err);
      }
      const handle = this.requireLiveHandle(attachment.terminalId);
      this.assertNotFenced(handle);
      try {
        await this.driver.resize(handle.paneId, cols, rows);
      } catch (err) {
        this.handleDriverMutationError(handle, err);
      }
      // resize does NOT refresh idle (spec §11).
    });
  }

  async takeControl(attachmentId: string, generation: string): Promise<TerminalRoleResult> {
    this.assertStarted();
    const attachment = this.attachments.getAttachment(attachmentId);
    if (!attachment) throw new TerminalRuntimeError("terminal-attachment-not-found");

    return this.withTerminalLock(attachment.terminalId, async () => {
      const handle = this.requireLiveHandle(attachment.terminalId);
      if (handle.generation !== generation) {
        throw new TerminalRuntimeError("terminal-generation-mismatch");
      }
      let result;
      try {
        result = this.attachments.takeControl({ attachmentId, generation });
      } catch (err) {
        mapAttachmentError(err);
      }
      await this.refreshIdle(attachment.terminalId, true);
      return {
        terminalId: attachment.terminalId,
        generation,
        attachmentId: result.attachmentId,
        role: "controller" as const,
        viewerCount: result.viewerCount,
      };
    });
  }

  async resync(attachmentId: string, generation: string): Promise<void> {
    this.assertStarted();
    const attachment = this.attachments.getAttachment(attachmentId);
    if (!attachment) throw new TerminalRuntimeError("terminal-attachment-not-found");
    if (attachment.generation !== generation) {
      throw new TerminalRuntimeError("terminal-generation-mismatch");
    }
    this.attachments.resetOutboundQueue(attachmentId);
    await this.startRecovery(attachmentId);
  }

  async terminate(input: {
    terminalId: string;
    generation: string;
    reason: "explicit-close" | "archive" | "delete" | "idle" | "disabled";
  }): Promise<TerminalTerminateResult> {
    this.assertStarted();
    return this.withTerminalLock(input.terminalId, () =>
      this.terminateUnlocked(input.terminalId, input.generation, input.reason),
    );
  }

  async retireLogicalSession(
    logicalSessionId: string,
    reason: "archive" | "delete",
  ): Promise<void> {
    this.assertStarted();
    await this.withLogicalLock(logicalSessionId, async () => {
      const rec = findByLogical(this.registry.getSnapshot().terminals, logicalSessionId);
      if (!rec) return;
      if (rec.state === "reaping") return;
      await this.withTerminalLock(rec.terminalId, async () => {
        await this.terminateUnlocked(rec.terminalId, rec.generation, reason);
      });
    });
  }

  async terminateAll(reason: "disabled" | "logout"): Promise<void> {
    this.assertStarted();
    const reapReason: TerminalReapReason = reason === "logout" ? "disabled" : "disabled";
    const ids = Object.values(this.registry.getSnapshot().terminals)
      .filter((t) => t.state === "live" || t.state === "creating")
      .map((t) => ({ terminalId: t.terminalId, generation: t.generation }));
    for (const id of ids) {
      await this.withTerminalLock(id.terminalId, async () => {
        await this.terminateUnlocked(id.terminalId, id.generation, reapReason);
      });
    }
  }

  async stop(): Promise<void> {
    // Process-owned: normal shutdown kills all sessions (no cross-process adopt).
    if (this.attachmentSweepTimer) {
      clearInterval(this.attachmentSweepTimer);
      this.attachmentSweepTimer = null;
    }
    if (!this.stopped && this.started) {
      try {
        await this.terminateAll("disabled");
      } catch {
        // leave reaping tombstones for the next process startup cleanup
      }
    }
    this.stopped = true;
    await this.reconciler.stop();
    const loops = [...this.recoveries.values()];
    for (const loop of loops) loop.abort.abort();
    await Promise.allSettled(loops.map((l) => l.done));
    this.recoveries.clear();
  }

  // --- private ------------------------------------------------------------

  private assertStarted(): void {
    if (!this.started || this.stopped) {
      throw new TerminalRuntimeError("terminal-rmux-unavailable", "terminal runtime is not running");
    }
  }

  private logicalMutex(logicalSessionId: string): AsyncMutex {
    let m = this.logicalLocks.get(logicalSessionId);
    if (!m) {
      m = new AsyncMutex();
      this.logicalLocks.set(logicalSessionId, m);
    }
    return m;
  }

  private terminalMutex(terminalId: string): AsyncMutex {
    let m = this.terminalLocks.get(terminalId);
    if (!m) {
      m = new AsyncMutex();
      this.terminalLocks.set(terminalId, m);
    }
    return m;
  }

  private withLogicalLock<T>(logicalSessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.logicalMutex(logicalSessionId).run(fn);
  }

  private withTerminalLock<T>(terminalId: string, fn: () => Promise<T>): Promise<T> {
    return this.terminalMutex(terminalId).run(fn);
  }

  private async resolveDescriptor(
    chatKey: string,
    sessionAlias: string,
  ): Promise<SessionResourceDescriptor> {
    const descriptor = await this.catalog.resolve(chatKey, sessionAlias);
    if (!descriptor || descriptor.channelId !== RELAY_CHANNEL_ID) {
      throw new TerminalRuntimeError("terminal-session-not-found");
    }
    if (descriptor.archived) {
      throw new TerminalRuntimeError("terminal-session-archived");
    }
    return descriptor;
  }

  private attachViewer(
    rec: TerminalRecordV1,
    viewerId: string,
    openKind: TerminalOpenKind,
  ): TerminalOpenResult {
    let attached;
    try {
      attached = this.attachments.attach({
        viewerId,
        terminalId: rec.terminalId,
        generation: rec.generation,
      });
    } catch (err) {
      mapAttachmentError(err);
    }
    return {
      terminalId: rec.terminalId,
      generation: rec.generation,
      attachmentId: attached.attachmentId,
      role: attached.role,
      viewerCount: attached.viewerCount,
      openKind,
    };
  }

  private installHandle(rec: TerminalRecordV1, paneId: string, now: number): void {
    if (!rec.rmuxSessionId) return;
    this.handles.set(rec.terminalId, {
      terminalId: rec.terminalId,
      generation: rec.generation,
      logicalSessionId: rec.logicalSessionId,
      rmuxSessionId: rec.rmuxSessionId,
      paneId,
      lastActivityAt: now,
      leaseLost: false,
      lastCheckpointAt: now,
    });
    this.paneByTerminal.set(rec.terminalId, paneId);
  }

  private requireLiveHandle(terminalId: string): LiveHandle {
    const snap = this.registry.getSnapshot().terminals[terminalId];
    if (!snap || snap.state === "reaping") {
      throw new TerminalRuntimeError("terminal-terminating");
    }
    if (snap.state !== "live") {
      throw new TerminalRuntimeError("terminal-terminating");
    }
    const handle = this.handles.get(terminalId);
    if (!handle) {
      throw new TerminalRuntimeError("terminal-rmux-unavailable");
    }
    return handle;
  }

  private assertNotFenced(handle: LiveHandle): void {
    if (handle.leaseLost) {
      throw new TerminalRuntimeError("terminal-rmux-unavailable", "owner lease lost");
    }
  }

  private handleDriverMutationError(handle: LiveHandle, err: unknown): never {
    if (handle.leaseLost) {
      throw new TerminalRuntimeError("terminal-rmux-unavailable", "terminal fenced");
    }
    throw new TerminalRuntimeError(
      "terminal-rmux-unavailable",
      err instanceof Error ? err.message : String(err),
    );
  }

  private async refreshIdle(terminalId: string, forceCheckpoint: boolean): Promise<void> {
    const now = this.clock.now();
    const handle = this.handles.get(terminalId);
    if (handle) handle.lastActivityAt = now;

    const snap = this.registry.getSnapshot();
    const rec = snap.terminals[terminalId];
    if (!rec || rec.state !== "live") return;

    if (
      forceCheckpoint ||
      !handle ||
      now - handle.lastCheckpointAt >= this.checkpointIntervalMs
    ) {
      await this.registry.checkpointLastInputAt(terminalId, new Date(now).toISOString());
      if (handle) handle.lastCheckpointAt = now;
    }
  }

  private async reapExpiredForQuota(): Promise<void> {
    const idleMs = this.config.idleTimeoutSeconds * 1000;
    const now = this.clock.now();
    const snap = this.registry.getSnapshot();
    const expired = Object.values(snap.terminals).filter((rec) => {
      if (rec.state === "reaping") return true;
      if (rec.state !== "live") return false;
      const handle = this.handles.get(rec.terminalId);
      const last = handle?.lastActivityAt ?? Date.parse(rec.lastInputAt);
      return Number.isFinite(last) && now - last >= idleMs;
    });

    for (const rec of expired) {
      await this.withTerminalLock(rec.terminalId, async () => {
        const current = this.registry.getSnapshot().terminals[rec.terminalId];
        if (!current) return;
        if (current.state === "live") {
          await this.terminateUnlocked(current.terminalId, current.generation, "idle");
        } else if (current.state === "reaping") {
          await this.finishReap(current);
        }
      });
    }
  }

  private async compensateFailedCreate(
    terminalId: string,
    sessionId: string | undefined,
  ): Promise<void> {
    if (sessionId) {
      try {
        await this.driver.kill(sessionId);
      } catch {
        // best-effort
      }
    }
    const snap = this.registry.getSnapshot();
    const rec = snap.terminals[terminalId];
    if (!rec) return;
    if (rec.state !== "reaping") {
      await this.registry.markReaping(terminalId, "orphan");
    }
    // If kill succeeded / never created, try remove.
    if (sessionId) {
      const after = this.registry.getSnapshot();
      try {
        await this.registry.remove(terminalId);
        this.handles.delete(terminalId);
      } catch {
        // leave tombstone
      }
    }
  }

  private async terminateUnlocked(
    terminalId: string,
    generation: string,
    reason: TerminalReapReason,
  ): Promise<TerminalTerminateResult> {
    const snap = this.registry.getSnapshot();
    const rec = snap.terminals[terminalId];
    if (!rec) {
      return { status: "terminated" }; // already-gone
    }
    if (rec.generation !== generation) {
      throw new TerminalRuntimeError("terminal-generation-mismatch");
    }

    if (rec.state !== "reaping") {
      // Durable reaping FIRST (spec §10.5).
      await this.registry.markReaping(terminalId, reason);
    }

    // Abort only — never await recovery loops while holding the terminal lock
    // (a concurrent natural-exit handler would otherwise deadlock).
    await this.stopAllRecoveriesForTerminal(terminalId, { wait: false });
    this.emitExitToViewers(terminalId, generation, reason);

    return this.finishReap({ ...rec, state: "reaping", reapReason: reason });
  }

  private async finishReap(rec: TerminalRecordV1): Promise<TerminalTerminateResult> {
    const sessionId = this.handles.get(rec.terminalId)?.rmuxSessionId ?? rec.rmuxSessionId;
    if (sessionId) {
      const killed = await this.killWithTimeout(sessionId);
      if (!killed) {
        return { status: "cleanup-pending" };
      }
    }

    const snap = this.registry.getSnapshot();
    if (snap.terminals[rec.terminalId]) {
      await this.registry.remove(rec.terminalId);
    }
    this.handles.delete(rec.terminalId);
    this.paneByTerminal.delete(rec.terminalId);

    // Detach remaining viewers after resource is gone.
    for (const a of this.attachments.listByTerminal(rec.terminalId)) {
      this.attachments.detach(a.attachmentId);
    }
    return { status: "terminated" };
  }

  private async killWithTimeout(sessionId: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.driver.kill(sessionId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new TerminalRuntimeError("terminal-timeout")),
            this.killTimeoutMs,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private emitExitToViewers(terminalId: string, generation: string, reason: string, code?: number): void {
    for (const a of this.attachments.listByTerminal(terminalId)) {
      this.onViewerEvent({
        type: "exit",
        attachmentId: a.attachmentId,
        terminalId,
        generation,
        code,
        reason,
      });
    }
  }

  private async stopRecovery(
    attachmentId: string,
    opts: { wait?: boolean } = {},
  ): Promise<void> {
    const loop = this.recoveries.get(attachmentId);
    if (!loop) return;
    loop.abort.abort();
    this.recoveries.delete(attachmentId);
    if (opts.wait === false) return;
    try {
      await loop.done;
    } catch {
      // ignore
    }
  }

  private async stopAllRecoveriesForTerminal(
    terminalId: string,
    opts: { wait?: boolean } = {},
  ): Promise<void> {
    const ids = [...this.recoveries.values()]
      .filter((r) => {
        const a = this.attachments.getAttachment(r.attachmentId);
        return a?.terminalId === terminalId;
      })
      .map((r) => r.attachmentId);
    await Promise.all(ids.map((id) => this.stopRecovery(id, opts)));
  }

  private async runRecoveryLoop(input: {
    attachmentId: string;
    terminalId: string;
    generation: string;
    paneId: string;
    signal: AbortSignal;
  }): Promise<void> {
    const { attachmentId, terminalId, generation, paneId, signal } = input;
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });

    const iterator = this.driver.recover(paneId)[Symbol.asyncIterator]();
    try {
      while (!signal.aborted) {
        const step = await Promise.race([
          iterator.next().then((value) => ({ kind: "next" as const, value })),
          cancelled.then(() => ({ kind: "cancel" as const })),
        ]);
        if (step.kind === "cancel" || signal.aborted) break;
        if (step.value.done) break;
        const event = step.value.value;
        await this.dispatchRecoveryEvent(attachmentId, terminalId, generation, event);
        if (event.type === "exit") break;
      }
    } catch {
      // Sidecar/driver crash: fan out exit and durable-reap (never adopt).
      queueMicrotask(() => {
        void this.handleNaturalExit(terminalId, generation);
      });
    } finally {
      signal.removeEventListener("abort", cancel);
      // Do not await return() — some driver iterators may not wake a pending
      // next() promptly; stop()/resync must remain non-blocking.
      void iterator.return?.();
      this.recoveries.delete(attachmentId);
    }
  }

  private async dispatchRecoveryEvent(
    attachmentId: string,
    terminalId: string,
    generation: string,
    event: RmuxRecoveryEvent,
  ): Promise<void> {
    if (event.type === "rebase") {
      const totalBytes = event.keyframe.byteLength;
      if (totalBytes > 2 * 1024 * 1024) {
        this.onViewerEvent({ type: "queue-overflow", attachmentId, terminalId });
        // Never await our own recovery loop from inside it.
        await this.stopRecovery(attachmentId, { wait: false });
        return;
      }
      const chunkCount = chunkCountFor(totalBytes);
      this.onViewerEvent({
        type: "rebase-start",
        attachmentId,
        terminalId,
        generation,
        epoch: event.epoch,
        nextSequence: event.nextSequence,
        cols: event.cols,
        rows: event.rows,
        alternate: event.alternate,
        totalBytes,
        chunkCount,
      });
      for (let index = 0; index < chunkCount; index++) {
        const start = index * TERMINAL_REBASE_CHUNK_BYTES;
        const chunk = event.keyframe.subarray(start, start + TERMINAL_REBASE_CHUNK_BYTES);
        if (!this.attachments.enqueueOutbound(attachmentId, chunk)) {
          await this.stopRecovery(attachmentId, { wait: false });
          return;
        }
        this.publishOutbound(
          attachmentId,
          terminalId,
          chunk.byteLength,
          {
            type: "rebase-chunk",
            attachmentId,
            terminalId,
            generation,
            epoch: event.epoch,
            index,
            dataBase64: bytesToBase64(chunk),
          },
        );
      }
      this.onViewerEvent({
        type: "rebase-end",
        attachmentId,
        terminalId,
        generation,
        epoch: event.epoch,
      });
      return;
    }

    if (event.type === "bytes") {
      if (!this.attachments.enqueueOutbound(attachmentId, event.data)) {
        await this.stopRecovery(attachmentId, { wait: false });
        return;
      }
      this.publishOutbound(
        attachmentId,
        terminalId,
        event.data.byteLength,
        {
          type: "bytes",
          attachmentId,
          terminalId,
          generation,
          epoch: event.epoch,
          sequence: event.sequence,
          dataBase64: bytesToBase64(event.data),
        },
      );
      return;
    }

    if (event.type === "exit") {
      // Schedule outside the recovery async iterator so we never hold the
      // iterator stack while waiting on the terminal mutex.
      queueMicrotask(() => {
        void this.handleNaturalExit(terminalId, generation, event.code);
      });
    }
  }

  /** Enqueue already counted; release only after websocket flush succeeds. */
  private publishOutbound(
    attachmentId: string,
    terminalId: string,
    byteLength: number,
    event: TerminalViewerEvent,
  ): void {
    let settled = false;
    this.onViewerEvent(event, (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        this.attachments.closeOutboundQueue(attachmentId);
        this.onViewerEvent({ type: "queue-overflow", attachmentId, terminalId });
        void this.stopRecovery(attachmentId, { wait: false });
        return;
      }
      this.attachments.releaseOutbound(attachmentId, byteLength);
    });
  }

  private async handleNaturalExit(
    terminalId: string,
    generation: string,
    code?: number,
  ): Promise<void> {
    await this.withTerminalLock(terminalId, async () => {
      const snap = this.registry.getSnapshot();
      const rec = snap.terminals[terminalId];
      if (!rec) {
        this.emitExitToViewers(terminalId, generation, "exited", code);
        return;
      }
      if (rec.state !== "reaping") {
        await this.registry.markReaping(terminalId, "exited");
      }
      await this.stopAllRecoveriesForTerminal(terminalId, { wait: false });
      this.emitExitToViewers(terminalId, generation, "exited", code);
      await this.finishReap({ ...rec, state: "reaping", reapReason: "exited" });
    });
  }

  private forwardAttachmentEvent(event: TerminalAttachmentEvent): void {
    if (event.type === "role-changed") {
      this.onViewerEvent({
        type: "role-changed",
        attachmentId: event.attachmentId,
        terminalId: event.terminalId,
        role: event.role,
        viewerCount: event.viewerCount,
      });
      return;
    }
    this.onViewerEvent({
      type: "queue-overflow",
      attachmentId: event.attachmentId,
      terminalId: event.terminalId,
    });
  }
}
