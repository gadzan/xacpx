import { access, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { coreHomeDir } from "../../runtime/core-home";

import { deleteAcpxSessionFiles, resolveAcpxHomeDir } from "../../transport/acpx-session-files";
import type {
  AgentSessionListResult,
  SessionEffortState,
} from "../../transport/types";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { BridgeEngine, EngineInjectInput, EngineListInput, EnginePromptInput, EnginePromptStreamEvent, EngineSessionInput } from "./bridge-engine";
import type { PlanEntry, ToolUseEvent, ToolUseKind, ToolUseStatus } from "../../channels/types.js";
import { formatToolUseEventForText } from "../../transport/tool-use-text-format.js";
import { readImageFileBounded } from "../../transport/prompt-media.js";
import { parseSessionEffortRecord } from "../../transport/session-effort.js";
import type { PromptMediaInput } from "../../transport/types.js";
import { mapRuntimeError, type XacpxRuntimeEvent, type XacpxTurnResult, type RuntimeBridgeErrorCode } from "./runtime/runtime-contract";
import { WorkerCrashError, WorkerRpcError, WorkerBootstrapError } from "./runtime/runtime-worker-client";
import type { RuntimeWorkerClient, RuntimeWorkerClientDeps } from "./runtime/runtime-worker-client";
import { RuntimeWorkerManager, WorkerTeardownPendingError } from "./runtime/runtime-worker-manager";
import { RuntimeQueueStore } from "./runtime/runtime-queue";
import type { RuntimeQueueRecord } from "./runtime/runtime-queue";
import { isEligibleForRuntime, parseXacpxPermissionPolicy } from "./runtime/runtime-permission-policy";
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

export type RecordLookupResult =
  | { kind: "found"; recordId: string }
  | { kind: "absent" }
  | { kind: "failed"; error: Error };

/**
 * Scans the sessions directory for an acpx record matching the session name (plan §39).
 * Fails closed if the directory or any candidate file is unreadable (G4).
 */
export type IdentityMatch = "match" | "no-match" | "indeterminate";

export interface SessionRecordMatchCriteria {
  name: string;
  cwd?: string;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
}

export interface DeleteTombstoneRecord {
  logicalSessionId?: string;
  name: string;
  cwd?: string;
  agentCommand?: string;
  recordId: string;
}

function normalizePathForComparison(p?: string): string | undefined {
  if (!p) return undefined;
  const resolved = resolvePath(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function matchSessionRecord(
  parsed: Record<string, unknown>,
  criteria: SessionRecordMatchCriteria,
): IdentityMatch {
  if (typeof parsed.name !== "string" || parsed.name !== criteria.name) {
    return "no-match";
  }
  if (typeof parsed.acpx_record_id !== "string" || !parsed.acpx_record_id) {
    return "indeterminate";
  }

  // Cwd matching: if criteria specifies cwd, candidate MUST prove matching cwd
  if (criteria.cwd) {
    if (typeof parsed.cwd !== "string" || !parsed.cwd) {
      return "indeterminate"; // required identity field missing -> fail closed
    }
    const criteriaCwd = normalizePathForComparison(criteria.cwd);
    const parsedCwd = normalizePathForComparison(parsed.cwd);
    if (criteriaCwd !== parsedCwd) {
      return "no-match";
    }
  }

  // Agent matching: build accepted identities set
  const acceptedAgents = new Set(
    [criteria.agentCommand, criteria.rawCommand, criteria.acpxAgent].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
  );
  if (acceptedAgents.size > 0) {
    if (typeof parsed.agent_command !== "string" || !parsed.agent_command) {
      return "indeterminate"; // required agent identity missing -> fail closed
    }
    if (!acceptedAgents.has(parsed.agent_command)) {
      return "no-match";
    }
  }

  return "match";
}

/**
 * Scans the sessions directory for an acpx record matching the session criteria (plan §39).
 * Fails closed if the directory or any candidate file is unreadable, if any candidate identity
 * is indeterminate, or if multiple matching records exist on disk (G4).
 */
export async function findAcpxRecordIdFromDisk(
  criteria: string | SessionRecordMatchCriteria,
  sessionsDir = join(resolveAcpxHomeDir(), ".acpx", "sessions"),
): Promise<RecordLookupResult> {
  const matchCriteria: SessionRecordMatchCriteria =
    typeof criteria === "string" ? { name: criteria } : criteria;

  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (error) {
    if (isEnoent(error)) {
      return { kind: "absent" };
    }
    return {
      kind: "failed",
      error: new Error(`failed to scan sessions directory "${sessionsDir}": ${error instanceof Error ? error.message : String(error)}`),
    };
  }

  const matches: Array<{ recordId: string; file: string }> = [];
  const indeterminateCandidates: string[] = [];

  for (const file of entries) {
    if (!file.endsWith(".json") || file === "index.json" || file.startsWith(".xacpx-delete-tombstone-")) continue;
    try {
      const content = await readFile(join(sessionsDir, file), "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const matchResult = matchSessionRecord(parsed, matchCriteria);
      if (matchResult === "match") {
        matches.push({ recordId: parsed.acpx_record_id as string, file });
      } else if (matchResult === "indeterminate") {
        indeterminateCandidates.push(file);
      }
    } catch (error) {
      if (!isEnoent(error)) {
        return {
          kind: "failed",
          error: new Error(`cannot read candidate session record "${file}" in "${sessionsDir}": ${error instanceof Error ? error.message : String(error)}`),
        };
      }
    }
  }

  // Fail closed if any candidate was indeterminate (G4: cannot prove identity != identity matches)
  if (indeterminateCandidates.length > 0) {
    return {
      kind: "failed",
      error: new Error(
        `cannot prove session record identity for candidate(s) in "${sessionsDir}" (${indeterminateCandidates.join(", ")}): missing required identity fields (cwd / agent_command); fail closed`,
      ),
    };
  }

  if (matches.length === 0) {
    return { kind: "absent" };
  }
  if (matches.length === 1 && matches[0]) {
    return { kind: "found", recordId: matches[0].recordId };
  }
  return {
    kind: "failed",
    error: new Error(
      `ambiguous session record resolution for session "${matchCriteria.name}": found ${matches.length} matching records on disk (${matches.map((m) => m.file).join(", ")})`,
    ),
  };
}

function tombstonePath(sessionsDir: string, safeId: string): string {
  return join(sessionsDir, `.xacpx-delete-tombstone-${safeId}.json`);
}

async function writeTombstoneStrict(sessionsDir: string, safeId: string, record: DeleteTombstoneRecord): Promise<void> {
  const target = tombstonePath(sessionsDir, safeId);
  const tmp = join(sessionsDir, `.xacpx-delete-tombstone-${safeId}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
    await rename(tmp, target);
    // Strict verify: ensure the tombstone is actually readable on disk
    const content = await readFile(target, "utf8");
    const parsed = JSON.parse(content) as DeleteTombstoneRecord;
    if (parsed.recordId !== record.recordId) {
      throw new Error("tombstone content mismatch after atomic write");
    }
  } catch (error) {
    try { await unlink(tmp); } catch {}
    throw new RuntimeError(
      "RUNTIME_INIT_FAILED",
      `failed to persist delete tombstone for record "${record.recordId}" in "${sessionsDir}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function removeTombstoneStrict(sessionsDir: string, safeId: string): Promise<void> {
  const target = tombstonePath(sessionsDir, safeId);
  try {
    await unlink(target);
  } catch (error) {
    if (isEnoent(error)) return; // genuinely gone
    throw new RuntimeError(
      "RUNTIME_INIT_FAILED",
      `failed to remove delete tombstone "${target}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await access(target);
    // Still accessible -> unlink did not take
    throw new RuntimeError("RUNTIME_INIT_FAILED", `delete tombstone "${target}" still exists after unlink`);
  } catch (error) {
    if (isEnoent(error)) return; // verified gone
    throw error;
  }
}

export function matchTombstoneRecord(
  parsed: DeleteTombstoneRecord,
  criteria: {
    logicalSessionId?: string;
    name: string;
    cwd?: string;
    agentCommand?: string;
    rawCommand?: string;
    acpxAgent?: string;
  },
): IdentityMatch {
  // G4: Any candidate tombstone MUST prove a non-empty physical recordId
  if (typeof parsed.recordId !== "string" || !parsed.recordId) {
    return "indeterminate";
  }

  // 1. Immutable logicalSessionId exact match (highest priority, plan §48)
  if (criteria.logicalSessionId && parsed.logicalSessionId) {
    return parsed.logicalSessionId === criteria.logicalSessionId ? "match" : "no-match";
  }

  // 2. Name must match
  if (parsed.name !== criteria.name) return "no-match";
  // 3. Normalized cwd match: if criteria specifies cwd, candidate MUST have valid matching cwd
  if (criteria.cwd) {
    if (typeof parsed.cwd !== "string" || !parsed.cwd) {
      return "indeterminate";
    }
    const criteriaCwd = normalizePathForComparison(criteria.cwd);
    const parsedCwd = normalizePathForComparison(parsed.cwd);
    if (criteriaCwd !== parsedCwd) {
      return "no-match";
    }
  }

  // 4. Agent match: build accepted identities set
  const acceptedAgents = new Set(
    [criteria.agentCommand, criteria.rawCommand, criteria.acpxAgent].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
  );
  if (acceptedAgents.size > 0) {
    if (typeof parsed.agentCommand !== "string" || !parsed.agentCommand) {
      return "indeterminate";
    }
    if (!acceptedAgents.has(parsed.agentCommand)) {
      return "no-match";
    }
  }

  return "match";
}

async function findTombstoneRecordId(
  criteria: {
    logicalSessionId?: string;
    name: string;
    cwd?: string;
    agentCommand?: string;
    rawCommand?: string;
    acpxAgent?: string;
  },
  sessionsDir: string,
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw new RuntimeError(
      "RUNTIME_INIT_FAILED",
      `failed to scan sessions directory for tombstones in "${sessionsDir}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const matchingTombstones: Array<{ recordId: string; file: string }> = [];
  const indeterminateTombstones: string[] = [];

  for (const file of entries) {
    if (!file.startsWith(".xacpx-delete-tombstone-") || !file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(sessionsDir, file), "utf8");
      const parsed = JSON.parse(content) as DeleteTombstoneRecord;
      const matchResult = matchTombstoneRecord(parsed, criteria);
      if (matchResult === "match") {
        matchingTombstones.push({ recordId: parsed.recordId, file });
      } else if (matchResult === "indeterminate") {
        indeterminateTombstones.push(file);
      }
    } catch (error) {
      if (!isEnoent(error)) {
        throw new RuntimeError(
          "RUNTIME_INIT_FAILED",
          `cannot read candidate delete tombstone "${file}" in "${sessionsDir}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (indeterminateTombstones.length > 0) {
    throw new RuntimeError(
      "RUNTIME_INIT_FAILED",
      `cannot prove delete tombstone identity for candidate(s) in "${sessionsDir}" (${indeterminateTombstones.join(", ")}): missing required identity fields; fail closed`,
    );
  }

  if (matchingTombstones.length === 0) return undefined;
  if (matchingTombstones.length === 1 && matchingTombstones[0]) return matchingTombstones[0].recordId;

  // Ambiguous tombstones: fail closed!
  throw new RuntimeError(
    "RUNTIME_INIT_FAILED",
    `ambiguous delete tombstone resolution for session "${criteria.name}": found ${matchingTombstones.length} matching tombstones on disk`,
  );
}

export interface RuntimeEngineOptions {
  /** Resolved worker entry; defaults to the bundled dist output. */
  workerEntryPath?: string;
  /**
   * Override for the acpx sessions directory (tests / isolated daemons).
   * CONTRACT: this is the SESSIONS directory — the directory whose basename
   * MUST be "sessions" (upstream acpx hard-codes `stateRoot + "/sessions"`
   * inside createRuntimeStore, and xacpx disk helpers scan the same path).
   * The Runtime store root is derived as dirname(this) and validated in
   * runtimeStateRoot(); a non-"sessions" basename fails closed.
   */
  stateDir?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  /** Idle TTL in seconds for warm worker processes (plan §16). Set to 0 to disable. */
  queueOwnerTtlSeconds?: number;
  idleTtlMs?: number;
  /** Optional dependency overrides for tests (e.g. Windows termination / identity mocks). */
  workerClientDeps?: RuntimeWorkerClientDeps;
  /** Override for the durable worker-ownership fence directory (tests). Defaults to `<state root>/worker-fences`. */
  fenceDir?: string;
  /** Override for the durable runtime queue directory (tests). Defaults to `<state root>/runtime-queue`. */
  queueDir?: string;
}
export function defaultWorkerEntryCandidates(fromUrl = import.meta.url): string[] {
  const here = dirname(fileURLToPath(fromUrl));
  return [
    // 1. When bundled into dist/bridge/bridge-main.js -> dist/bridge/engine/runtime/runtime-worker-main.js
    resolvePath(here, "./engine/runtime/runtime-worker-main.js"),
    // 2. When evaluated from dist/bridge/engine/ -> dist/bridge/engine/runtime/runtime-worker-main.js
    resolvePath(here, "./runtime/runtime-worker-main.js"),
    // 3. When evaluated directly from source at src/bridge/engine/runtime-engine.ts
    resolvePath(here, "../../../dist/bridge/engine/runtime/runtime-worker-main.js"),
    // 4. When evaluated from root / testing directory
    resolvePath(process.cwd(), "dist/bridge/engine/runtime/runtime-worker-main.js"),
  ];
}

export function defaultWorkerEntry(fromUrl?: string): string {
  const candidates = defaultWorkerEntryCandidates(fromUrl);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return candidates[0]!;
}

export class RuntimeEngine implements BridgeEngine {
  readonly kind = "runtime" as const;
  private readonly manager?: RuntimeWorkerManager;
  private readonly activeTurns = new Map<string, number>();
  private hasActiveTurn(key: string): boolean { return (this.activeTurns.get(key) ?? 0) > 0; }
  private hasAnyActiveTurn(): boolean { for (const v of this.activeTurns.values()) if (v > 0) return true; return false; }
  private incActiveTurn(key: string): void { this.activeTurns.set(key, (this.activeTurns.get(key) ?? 0) + 1); }
  private decActiveTurn(key: string): void { const n = (this.activeTurns.get(key) ?? 0) - 1; if (n <= 0) this.activeTurns.delete(key); else this.activeTurns.set(key, n); }
  private clearActiveTurn(key: string): void { this.activeTurns.delete(key); }
  private async waitForNoActiveTurn(key: string, timeoutMs = 8_000): Promise<void> {
    const start = Date.now();
    while (this.hasActiveTurn(key) && Date.now() - start < timeoutMs) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    }
    if (this.hasActiveTurn(key)) {
      throw new RuntimeError(
        "RUNTIME_WORKER_TEARDOWN_PENDING",
        `cannot hard delete session "${key}" while turn active`,
      );
    }
  }
  private readonly coolPending = new Set<string>();
  /** In-flight worker acquisitions (fence discharge + spawn), keyed by session. */
  private readonly acquiring = new Map<string, Promise<RuntimeWorkerClient>>();
  private readonly recordIds = new Map<string, string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTtlMs: number;
  private policyTransitionLock?: Promise<void>;
  private policyLockRelease?: () => void;
  private permissionGeneration = 0;
  private queueStore?: RuntimeQueueStore;
  private readonly draining = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  private readonly deleteGenerations = new Map<string, number>();
  private shuttingDown = false;
  /** Authoritative session catalog for bridge restart recovery (logicalSessionId -> input). */
  private sessionCatalog = new Map<string, EngineSessionInput>();
  private readonly lastMcpIdentity = new Map<string, { mcpCoordinatorSession?: string; mcpSourceHandle?: string }>();
  private readonly turnLeases = new Map<string, Promise<void>>();
  private readonly queueSuspended = new Set<string>();
  private readonly staleAfterTurn = new Set<string>();

  constructor(private readonly options: RuntimeEngineOptions) {
    this.idleTtlMs = options.idleTtlMs ?? (options.queueOwnerTtlSeconds !== undefined ? options.queueOwnerTtlSeconds * 1000 : 60_000);
    const entry = options.workerEntryPath ?? defaultWorkerEntryCandidates().find(fileExists);
    if (entry && fileExists(entry)) {
      const stateDirValid = this.options.stateDir ? this.options.stateDir.split(/[\\/]/).pop() === "sessions" : false;
      const fenceDir: string | (() => string) | undefined = this.options.fenceDir ?? (stateDirValid ? () => join(this.runtimeStateRoot(), "worker-fences") : undefined);
      this.manager = new RuntimeWorkerManager({
        entryPath: entry,
        clientDeps: options.workerClientDeps,
        ...(fenceDir ? { fenceDir } : {}),
      });
    }
    if (options.queueDir) {
      this.queueStore = new RuntimeQueueStore(options.queueDir);
    } else if (options.stateDir) {
      try {
        this.queueStore = new RuntimeQueueStore(join(this.runtimeStateRoot(), "runtime-queue"));
      } catch {}
    } else {
      try {
        this.queueStore = new RuntimeQueueStore(join(this.xacpxRuntimeDir(), "runtime-queue"));
      } catch {}
    }
  }

  private workerKey(input: EngineSessionInput): string {
    return input.logicalSessionId ?? input.name;
  }

  private xacpxRuntimeDir(): string {
    return join(coreHomeDir(homedir()), "runtime");
  }

  private sessionsDir(): string {
    return this.options.stateDir ?? join(resolveAcpxHomeDir(), ".acpx", "sessions");
  }

  private queueDir(): string {
    if (this.options.queueDir) return this.options.queueDir;
    if (this.options.stateDir) return join(this.runtimeStateRoot(), "runtime-queue");
    return join(this.xacpxRuntimeDir(), "runtime-queue");
  }

  private getQueueStore(): RuntimeQueueStore {
    if (this.queueStore) return this.queueStore;
    const dir = this.queueDir();
    this.queueStore = new RuntimeQueueStore(dir);
    return this.queueStore;
  }

  /**
   * acpx Runtime store root: createRuntimeStore internally joins "sessions"
   * onto stateDir, so the root is the parent of the sessions dir. Because the
   * sessions dir basename is a hard contract (see RuntimeEngineOptions.stateDir),
   * a non-"sessions" basename would silently misalign disk helpers and the
   * Runtime store — fail closed instead.
   */
  private runtimeStateRoot(): string {
    const sessions = this.sessionsDir();
    if (sessions.split(/[\\/]/).pop() !== "sessions") {
      throw new RuntimeError(
        "RUNTIME_INIT_FAILED",
        `RuntimeEngineOptions.stateDir must end in "sessions" (got "${sessions}") — upstream acpx createRuntimeStore hard-codes stateRoot + "/sessions"`,
      );
    }
    return dirname(sessions);
  }
  private scheduleIdleTtl(key: string, client: RuntimeWorkerClient): void {
    const existing = this.idleTimers.get(key);
    if (existing) clearTimeout(existing);
    if (this.idleTtlMs <= 0) return;
    const timer = setTimeout(async () => {
      this.idleTimers.delete(key);
      if (this.hasActiveTurn(key)) return;
      // PR6: durable queue gates idle cool — if pending queue non-empty, drain instead of shutting down
      try {
        if (this.queueStore && await this.queueStore.hasPending(key)) {
          const catalogInput = this.sessionCatalog.get(key);
          if (catalogInput) {
            this.kickDrain(catalogInput).catch(() => {});
          }
          return;
        }
      } catch {
        // fail closed: if queue unreadable, do not cool — keep worker and surface on next operation
        return;
      }
      if (client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready") && !this.hasActiveTurn(key)) {
        try {
          await client.shutdown();
        } catch {
          // ignore background idle shutdown failures
        }
      }
    }, this.idleTtlMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  /** PR6: shared turn executor for direct prompt and queue drain — single turn lifecycle. */
  private async executeRuntimeTurn(
    input: EngineSessionInput,
    text: string,
    options: { onEvent?: (event: EnginePromptStreamEvent) => void; media?: PromptMediaInput; toolEventMode?: string; toolEvents?: boolean },
  ): Promise<{ text: string }> {
    const key = this.workerKey(input);
    const toolEventMode = options.toolEventMode ?? (options.toolEvents ? "structured" : "text");
    const renderText = toolEventMode === "text" || toolEventMode === "both";
    const renderStructured = toolEventMode === "structured" || toolEventMode === "both" || options.toolEvents === true;
    const textRenderState = { emittedToolCallIds: new Set<string>() };
    return await this.withWorker(input, async (client) => {
      client.lifecycle = "busy";
      await this.ensureSessionHandle(input, client);
      try {
        const attachments = await buildRuntimeAttachments(options.media);
        const outcome = await client.request<{ result: XacpxTurnResult; finalText: string }>(
          "prompt",
          { text, ...(attachments.length > 0 ? { attachments } : {}) },
          {
            onEvent: (payload) => {
              const event = payload as XacpxRuntimeEvent;
              const sink = options.onEvent;
              if (!sink) return;
              if (event.type === "text_delta") {
                sink(event.stream === "thought" ? { type: "prompt.thought", text: event.text } : { type: "prompt.segment", text: event.text });
              } else if (event.type === "tool_call") {
                const toolEvent = mapRuntimeToolEvent(event);
                if (renderStructured) sink({ type: "prompt.tool_event", event: toolEvent });
                if (renderText) {
                  const formatted = formatToolUseEventForText(toolEvent, textRenderState);
                  if (formatted) sink({ type: "prompt.segment", text: formatted + "\n" });
                }
              } else if (event.type === "status") {
                if ((event as { tag?: string }).tag === "plan") {
                  sink({ type: "prompt.segment", text: `${event.text}\n` });
                  return;
                }
                if (typeof event.used === "number" && typeof event.size === "number") {
                  sink({ type: "prompt.usage", used: event.used, size: event.size, ...(event.cost ? { cost: event.cost as never } : {}), ...(event.breakdown ? { breakdown: event.breakdown as never } : {}) });
                }
                if (event.availableCommands && event.availableCommands.length > 0) {
                  sink({ type: "prompt.commands", commands: event.availableCommands.map((c) => ({ name: c.name, description: c.description })) as never });
                }
              }
            },
          },
        );
        if (outcome.result.status === "cancelled") {
          throw new RuntimeError("RUNTIME_TURN_CANCELLED", outcome.result.stopReason || "turn was cancelled");
        }
        if (outcome.result.status === "failed") {
          const err = new Error(outcome.result.error.message);
          if (outcome.result.error.code) (err as { code?: string }).code = outcome.result.error.code;
          const mapped = mapRuntimeError(err);
          throw new RuntimeError(mapped.code, mapped.message);
        }
        return { text: outcome.finalText };
      } finally {
        client.lifecycle = "idle";
      }
    });
  }

  private kickDrain(input: EngineSessionInput): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const key = this.workerKey(input);
    if (this.queueSuspended.has(key)) return Promise.resolve();
    const existing = this.draining.get(key);
    if (existing) return existing;
    const p = this.drainLoop(input).finally(() => {
      if (this.draining.get(key) === p) this.draining.delete(key);
    });
    this.draining.set(key, p);
    return p;
  }

  private async consumeSuspendCool(key: string): Promise<void> {
    if (!this.coolPending.has(key)) return;
    if (this.hasActiveTurn(key)) return;
    this.coolPending.delete(key);
    const c = this.manager?.get(key);
    if (!c) return;
    await c.terminate().catch((error) => { throw toTeardownError(key, error); });
    c.lifecycle = "stopped";
    await this.manager?.release(key, c).catch((error) => { throw toTeardownError(key, error); });
  }

  private async drainLoop(input: EngineSessionInput): Promise<void> {
    const key = this.workerKey(input);
    if (this.queueSuspended.has(key)) {
      await this.consumeSuspendCool(key);
      return;
    }
    const store = this.getQueueStore();
    while (true) {
      if (this.shuttingDown) return;
      if (this.deleting.has(key)) return;
      if (this.queueSuspended.has(key)) {
        await this.consumeSuspendCool(key);
        return;
      }
      let rec: RuntimeQueueRecord | undefined;
      try {
        rec = await store.load(key);
      } catch (err) {
        // Corrupt journal -> fail closed, do not loop, surface on next enqueue/prompt
        throw toStableRuntimeError(err);
      }
      const head = rec?.items[0];
      if (!head) {
        // Queue empty — schedule TTL for normal idle cool
        const client = this.manager?.get(key);
        if (client && client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready")) {
          this.scheduleIdleTtl(key, client);
        }
        return;
      }
      // Per-head MCP identity: each queued message carries its own launch identity.
      // Legacy items lack per-head discriminator (mcpIdentityKnown) — missing means
      // "unknown" and MUST fail closed rather than silently executing as "none"
      // or guessing the catalog's current MCP. v2 items with mcpIdentityKnown=true
      // carry explicit per-head fields (absence = intentional none), so they are safe.
      const baseCatalog = this.sessionCatalog.get(key) ?? input;
      if (head.mcpIdentityKnown !== true) {
        // Keep head for operator clear; no automatic migration — clearing will also drop subsequent known heads (FIFO cannot skip).
        throw new RuntimeError("RUNTIME_INIT_FAILED", `queue journal for "${key}" contains identity-unknown head "${head.messageId}" (legacy v1 or pre-discriminator); operator clear required — no automatic migration`);
      }
      const headMcp = { mcpCoordinatorSession: head.mcpCoordinatorSession, mcpSourceHandle: head.mcpSourceHandle };
      const catalogInput: EngineSessionInput = {
        ...baseCatalog,
        mcpCoordinatorSession: head.mcpCoordinatorSession,
        mcpSourceHandle: head.mcpSourceHandle,
      };
      // If this head's identity differs from last, rotate before marking active
      const lastMcp = this.lastMcpIdentity.get(key);
      const isHeadStale = this.isMcpStale(lastMcp, headMcp);
      if (isHeadStale) {
        const cl = this.manager?.get(key);
        if (cl) {
          if (this.isStaleActiveForDrain(cl)) {
            this.staleAfterTurn.add(key);
            // Active turn will handle teardown; schedule a bounded retry in case the active
            // is a non-prompt business op (e.g. setMode) whose finally must re-kick.
            if (!this.shuttingDown) {
              const timer = setTimeout(() => {
                if (this.shuttingDown) return;
                if (this.deleting.has(key)) return;
                const latest = this.sessionCatalog.get(key) ?? input;
                this.kickDrain(latest).catch(() => {});
              }, 200);
              timer.unref?.();
            }
            return;
          }
          await cl.shutdown().catch((e) => { throw toTeardownError(key, e); });
          if (cl.lifecycle === "stopped") await this.manager?.release(key, cl).catch((e) => { throw toTeardownError(key, e); });
          else throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
          this.lastMcpIdentity.delete(key);
          this.staleAfterTurn.delete(key);
        }
      }
      this.incActiveTurn(key);
      const _deleteGenAtStart = this.deleteGenerations.get(key) ?? 0;
      let releaseTurn: (() => void) | undefined;
      try {
        releaseTurn = await this.acquireTurnLease(key);
      } catch (e) {
        this.decActiveTurn(key);
        throw e;
      }
      if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _deleteGenAtStart) {
        this.decActiveTurn(key);
        releaseTurn?.();
        return;
      }
      let turnError: unknown;
      let isTerminal = false;
      try {
        await this.executeRuntimeTurn(catalogInput, head.text, {});
        isTerminal = true;
      } catch (err) {
        turnError = err;
        // Only terminal turn results should dequeue (no acked loss). Crash/ambiguous (no terminal result) must keep head for replay.
        if (err instanceof RuntimeError) {
          const code = err.code;
          if (code === "RUNTIME_TURN_CANCELLED" || code === "RUNTIME_TURN_FAILED" || code === "RUNTIME_PERMISSION_DENIED") {
            isTerminal = true;
          } else {
            isTerminal = false;
          }
        } else {
          // Unknown error type -> treat as non-terminal (conservative, keep for replay)
          isTerminal = false;
        }
      } finally {
        try {
          this.decActiveTurn(key);
        } finally {
          releaseTurn?.();
        }
      }
      if (!isTerminal) {
        if (this.shuttingDown) return;
        if (this.queueSuspended.has(key)) {
          await this.consumeSuspendCool(key);
          return;
        }
        setTimeout(() => {
          if (this.shuttingDown) return;
          const latest = this.sessionCatalog.get(key) ?? input;
          this.kickDrain(latest).catch(() => {});
        }, 200);
        return;
      }
      // Terminal head must be dequeued even when suspended — suspend only blocks next head admission (at-least-once replay only for crash/ambiguity, not for deterministic terminal)
      // Atomically remove head from journal ONLY after terminal settlement (at-least-once, possible replay on crash before remove)
      let _dequeuedHead: import("./runtime/runtime-queue").RuntimePendingMessage | undefined;
      try {
        _dequeuedHead = await store.dequeueHead(key);
        // If dequeue returned undefined but we expected head, journal may have been concurrently cleared (e.g. delete) — stop
        if (!_dequeuedHead) return;
        // Verify head id matches (detect concurrent mutation)
        // If mismatch, we still continue — at-least-once ensures no loss, possible replay is acceptable per spec
      } catch (err) {
        // Dequeue persist failure -> head remains on disk for retry on next drain, do not lose acked message
        throw toStableRuntimeError(err);
      }
      if (this.queueSuspended.has(key)) {
        await this.consumeSuspendCool(key);
        return;
      }
    }
  }
  private isRuntimeEligible(): boolean {
    try {
      const policy = this.options.permissionPolicy !== undefined ? parseXacpxPermissionPolicy(this.options.permissionPolicy) : undefined;
      return isEligibleForRuntime(policy, this.options.nonInteractivePermissions);
    } catch {
      return false;
    }
  }

  private isMcpStale(last: { mcpCoordinatorSession?: string; mcpSourceHandle?: string } | undefined, requested: { mcpCoordinatorSession?: string; mcpSourceHandle?: string }): boolean {
    if (!last) return false;
    return (last.mcpCoordinatorSession ?? null) !== (requested.mcpCoordinatorSession ?? null) || (last.mcpSourceHandle ?? null) !== (requested.mcpSourceHandle ?? null);
  }

  private isStaleActiveForDrain(client: RuntimeWorkerClient | undefined): boolean {
    if (!client) return false;
    return client.lifecycle === "busy" || !!client.hasInFlight;
  }

  private isStaleActiveForInjectOrCheck(key: string, client: RuntimeWorkerClient | undefined, excludeCurrentTurn = false): boolean {
    const activeCount = this.activeTurns.get(key) ?? 0;
    const hasActive = excludeCurrentTurn ? activeCount > 1 : activeCount > 0;
    if (hasActive || this.draining.has(key)) return true;
    if (!client) return false;
    return client.lifecycle === "busy" || !!client.hasInFlight;
  }

  private async checkMcpStaleAndRotate(input: EngineSessionInput, forPromptActiveCheck: boolean): Promise<boolean> {
    const key = this.workerKey(input);
    const requestedMcp = { mcpCoordinatorSession: input.mcpCoordinatorSession, mcpSourceHandle: input.mcpSourceHandle };
    const lastMcp = this.lastMcpIdentity.get(key);
    const isMcpStale = this.isMcpStale(lastMcp, requestedMcp);
    if (!isMcpStale) return false;
    const existingClient = this.manager?.get(key);
    if (!existingClient) {
      this.lastMcpIdentity.delete(key);
      return true;
    }
    const isActive = this.isStaleActiveForInjectOrCheck(key, existingClient, forPromptActiveCheck);
    if (isActive) {
      this.staleAfterTurn.add(key);
      throw new RuntimeError("RUNTIME_MCP_STALE", `MCP identity changed for session "${key}" while turn active; will rotate after settle`);
    }
    await existingClient.shutdown().catch((e) => { throw toTeardownError(key, e); });
    if (existingClient.lifecycle === "stopped") await this.manager?.release(key, existingClient).catch((e) => { throw toTeardownError(key, e); });
    else throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
    this.lastMcpIdentity.delete(key);
    this.staleAfterTurn.delete(key);
    return true;
  }

  private async ensureWorker(input: EngineSessionInput): Promise<RuntimeWorkerClient> {
    if (!this.isRuntimeEligible()) {
      throw new RuntimeError("RUNTIME_ENGINE_UNSUPPORTED", "runtime ineligible: nonInteractivePermissions=fail or escalate policy requires CLI");
    }
    if (!this.manager) {
      throw new WorkerUnavailableError("RuntimeEngine has no worker manager (worker entry not built)");
    }
    // Fence-aware acquire (plan §43 / G10): discharges any undischarged
    // durable ownership fence BEFORE a fresh owner can spawn. The acquire
    // window is tracked so a concurrent policy transition fails closed
    // instead of racing an unregistered worker.
    const key = this.workerKey(input);
    const existing = this.acquiring.get(key);
    if (existing) return existing;
    const acquire = this.manager.acquire(key);
    this.acquiring.set(key, acquire);
    try {
      return await acquire;
    } finally {
      this.acquiring.delete(key);
    }
  }
  private async withWorker<T>(input: EngineSessionInput, run: (client: RuntimeWorkerClient) => Promise<T>): Promise<T> {
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
        await this.checkMcpStaleAndRotate(input, false);
    const existingTimer = this.idleTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.idleTimers.delete(key);
    }
    let client: RuntimeWorkerClient;
    try {
      client = await this.ensureWorker(input);
      this.lastMcpIdentity.set(key, { mcpCoordinatorSession: input.mcpCoordinatorSession, mcpSourceHandle: input.mcpSourceHandle });
    } catch (error) {
      if (error instanceof WorkerTeardownPendingError) {
        // Worker is still in cooling/teardown. Wait briefly for manager to release the previous generation (archive coolPending's immediate terminate).
        // For a normal archive, the previous generation is terminated and released within ~50ms. We poll briefly; if still cooling after 300ms we fail-closed.
        const start = Date.now();
        while (Date.now() - start < 300) {
          const existing = this.manager?.get(key);
          if (!existing || (existing.lifecycle !== "cooling" && existing.lifecycle !== "failed")) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const still = this.manager?.get(key);
        if (still && (still.lifecycle === "cooling" || still.lifecycle === "failed")) {
          throw new RuntimeError(error.code, error.message);
        }
        try {
          client = await this.ensureWorker(input);
          this.lastMcpIdentity.set(key, { mcpCoordinatorSession: input.mcpCoordinatorSession, mcpSourceHandle: input.mcpSourceHandle });
        } catch (retryError) {
          if (retryError instanceof WorkerTeardownPendingError) {
            throw new RuntimeError(retryError.code, retryError.message);
          }
          throw new WorkerUnavailableError(retryError instanceof Error ? retryError.message : String(retryError));
        }
      } else {
        throw new WorkerUnavailableError(error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const result = await run(client);
      if (client.lifecycle === "starting" && client.isBootstrapVerified) {
        client.lifecycle = "ready";
      }
      return result;
    } catch (error) {
      if (error instanceof WorkerCrashError) {
        // Do not clear activeTurns here: prompt/drain own their refcounts.
        // Clearing would wipe concurrent waiter counts and allow plan §32 to be bypassed after crash.
        client.lifecycle = "failed";
      }
      throw toStableRuntimeError(error);
    } finally {
      // Converged stale teardown for business ops (setMode etc.) that are not prompt's activeTurn.
      // Prompt handles stale in its own finally; this covers direct withWorker callers.
      // Ensure queue re-kick still runs even if teardown throws.
      let staleError: unknown;
      if (!this.hasActiveTurn(key) && this.staleAfterTurn.has(key)) {
        this.staleAfterTurn.delete(key);
        const staleClient = this.manager?.get(key);
        if (staleClient) {
          try {
            await staleClient.shutdown();
          } catch (e) {
            staleError = toTeardownError(key, e);
          }
          if (!staleError) {
            if (staleClient.lifecycle === "stopped") {
              try {
                await this.manager?.release(key, staleClient);
              } catch (e) {
                staleError = toTeardownError(key, e);
              }
            } else {
              staleError = new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
            }
          }
          if (!staleError) this.lastMcpIdentity.delete(key);
        }
      }
      // Queue re-kick for any business op that unblocked a stale drain (TTL=0 would otherwise stall).
      try {
        if (this.queueStore && await this.queueStore.hasPending(key)) {
          const latest = this.sessionCatalog.get(key) ?? input;
          if (latest) this.kickDrain(latest).catch(() => {});
        } else if (client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready") && !this.hasActiveTurn(key)) {
          this.scheduleIdleTtl(key, client);
        }
      } catch {}
      if (staleError) throw staleError;
    }
  }
  private buildEnsureParams(input: EngineSessionInput, options?: { resumeSessionId?: string }) {
    // Exact structured argv / raw command (plan §35 / G8): when xacpx resolved an explicit
    // argv or raw command string, runtimeAgentName (acpxAgent ?? agent) is the registry alias.
    const runtimeAgentName = input.acpxAgent ?? input.agent;
    const overrideValue =
      input.agentArgv && input.agentArgv.length > 0
        ? [...input.agentArgv]
        : input.rawCommand
          ? input.rawCommand
          : undefined;
    return {
      sessionKey: input.name,
      agent: runtimeAgentName,
      cwd: input.cwd,
      stateDir: this.runtimeStateRoot(),
      permissionMode: this.options.permissionMode,
      ...(this.options.permissionPolicy !== undefined ? { permissionPolicy: this.options.permissionPolicy } : {}),
      ...(overrideValue !== undefined ? { agentOverrides: { [runtimeAgentName]: overrideValue } } : {}),
      ...(this.options.nonInteractivePermissions ? { nonInteractivePermissions: this.options.nonInteractivePermissions } : {}),
      ...(options?.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(this.permissionGeneration > 0 ? { permissionGeneration: this.permissionGeneration } : {}),
      ...(input.mcpCoordinatorSession ? { mcpCoordinatorSession: input.mcpCoordinatorSession } : {}),
      ...(input.mcpSourceHandle ? { mcpSourceHandle: input.mcpSourceHandle } : {}),
    };
  }

  /**
   * Ensures the session and caches the REAL acpx record id resolved by the
   * runtime (plan §9.1). This binding metadata is the ONLY acceptable identity
   * for hard-delete — the logical session id is never a record id.
   */
  private async ensureSessionHandle(
    input: EngineSessionInput,
    client: RuntimeWorkerClient,
    options?: { resumeSessionId?: string },
  ): Promise<{ acpxRecordId?: string }> {
    const handle = await client.request<{ sessionKey: string; acpxRecordId?: string; agentSessionId?: string }>(
      "ensure",
      this.buildEnsureParams(input, options),
    );
    if (handle.acpxRecordId) {
      this.recordIds.set(this.workerKey(input), handle.acpxRecordId);
    }
    return handle;
  }

  async hasSession(input: EngineSessionInput): Promise<{ exists: boolean }> {
    // Record lookup must NOT heat a cold session (plan §39).
    const key = this.workerKey(input);
    if (this.manager?.isWarm(key)) {
      return { exists: true };
    }
    if (this.recordIds.has(key)) {
      return { exists: true };
    }
    const lookup = await findAcpxRecordIdFromDisk(input, this.sessionsDir());
    if (lookup.kind === "found") {
      this.recordIds.set(key, lookup.recordId);
      return { exists: true };
    }
    if (lookup.kind === "failed") {
      // I/O uncertainty is NOT absence — /session attach must not be told
      // "session not found" when the filesystem is unreadable.
      throw new RuntimeError(
        "RUNTIME_INIT_FAILED",
        `cannot determine session existence for "${input.name}": ${lookup.error.message}`,
      );
    }
    return { exists: false };
  }

  async tailSessionHistory(input: EngineSessionInput & { lines: number }): Promise<{ text: string }> {
    const recordId = await this.resolveRecordId(input);
    if (!recordId) {
      return { text: "" };
    }
    const sessionsDir = this.sessionsDir();
    const safeId = encodeURIComponent(recordId);

    // 1. Authoritative conversation messages from main session record (matches CLI sessions history)
    try {
      const mainContent = await readFile(join(sessionsDir, `${safeId}.json`), "utf8");
      const record = JSON.parse(mainContent) as Record<string, unknown>;
      const history = extractConversationEntries(record);
      if (history.length > 0) {
        const visible = input.lines === 0 ? history : history.slice(Math.max(0, history.length - input.lines));
        const text = visible.map((entry) => entry.textPreview).join("\n");
        return { text };
      }
    } catch (error) {
      if (!isEnoent(error)) {
        // Corrupt or unreadable record: surface the failure instead of
        // pretending there is no history.
        throw new RuntimeError(
          "RUNTIME_INIT_FAILED",
          `cannot read session history for record "${recordId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // ENOENT: main record not yet written — fall through to stream reading.
    }

    // 2. Stream files fallback if record has not synced messages
    const entries: string[] = await readdir(sessionsDir).catch(() => {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `cannot read sessions directory "${sessionsDir}" for history lookup`);
    });
    const numberedStreams = entries
      .filter((file) => file.startsWith(`${safeId}.stream.`) && file.endsWith(".ndjson") && file !== `${safeId}.stream.ndjson`)
      .sort((a, b) => {
        const numA = parseInt(a.slice(`${safeId}.stream.`.length, -".ndjson".length), 10) || 0;
        const numB = parseInt(b.slice(`${safeId}.stream.`.length, -".ndjson".length), 10) || 0;
        return numB - numA;
      });
    const activeStream: string[] = entries.includes(`${safeId}.stream.ndjson`) ? [`${safeId}.stream.ndjson`] : [];
    const streamFiles: string[] = [...numberedStreams, ...activeStream];

    const streamLines: string[] = [];
    for (const file of streamFiles) {
      try {
        const content = await readFile(join(sessionsDir, file), "utf8");
        for (const line of content.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const texts = extractTextFromAcpMessage(parsed);
            for (const t of texts) {
              if (t) streamLines.push(t);
            }
          } catch {
            streamLines.push(line);
          }
        }
      } catch (error) {
        if (!isEnoent(error)) {
          throw new RuntimeError(
            "RUNTIME_INIT_FAILED",
            `cannot read session history stream "${file}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const text = streamLines.slice(-input.lines).join("\n");
    return { text };
  }

  async listAgentSessions(_input: EngineListInput): Promise<AgentSessionListResult | undefined> {
    // Agent-level discovery stays on the CLI utility (plan §38); router never routes it here.
    throw new Error("listAgentSessions must be served by the CLI utility");
  }

  async ensureSession(input: EngineSessionInput): Promise<Record<string, never>> {
    this.sessionCatalog.set(this.workerKey(input), input);
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      return {};
    });
    // PR6: after ensure, if durable queue has pending items (bridge restart recovery), kick drain
    try {
      if (this.queueStore && await this.queueStore.hasPending(this.workerKey(input))) {
        this.kickDrain(input).catch(() => {});
      }
    } catch {}
    return {};
  }

  async resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }): Promise<Record<string, never>> {
    this.sessionCatalog.set(this.workerKey(input), input);
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client, { resumeSessionId: input.agentSessionId });
      return {};
    });
    return {};
  }
  async prompt(
    input: EnginePromptInput,
    onEvent?: (event: EnginePromptStreamEvent) => void,
  ): Promise<{ text: string }> {
    if (this.shuttingDown) throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    // Mark the turn active IMMEDIATELY so preflight on concurrent policy
    // updates detects the in-flight turn and fails closed (plan §32).
    // Must be before any await so the busy flag is synchronously visible to concurrent updatePermissionPolicy.
    this.incActiveTurn(key);
    this.sessionCatalog.set(key, input);
    // Archive suspend: a direct prompt resumes a suspended durable queue (first post-archive use).
    // G6: persist first, then memory. Fail-closed on persist error.
    try {
      await this.getQueueStore().setSuspended(key, false);
      this.queueSuspended.delete(key);
      await this.checkMcpStaleAndRotate(input, true);
    } catch (err) {
      this.decActiveTurn(key);
      throw err;
    }
    const _deleteGenAtStart = this.deleteGenerations.get(key) ?? 0;
    let releaseTurn: (() => void) | undefined;
    try {
      releaseTurn = await this.acquireTurnLease(key);
    } catch (e) {
      this.decActiveTurn(key);
      throw e;
    }
    if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _deleteGenAtStart) {
      this.decActiveTurn(key);
      releaseTurn?.();
      throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
    }
    try {
      const result = await this.executeRuntimeTurn(input, input.text, { onEvent, media: input.media, toolEventMode: input.toolEventMode, toolEvents: input.toolEvents });
      return result;
    } finally {
      try {
        this.decActiveTurn(key);
      // PR8: retire stale MCP worker after the active turn has truly settled (activeTurns cleared) — fail-closed on teardown uncertainty
      if (this.staleAfterTurn.has(key)) {
        this.staleAfterTurn.delete(key);
        const staleClient = this.manager?.get(key);
        if (staleClient) {
          await staleClient.shutdown().catch((e) => { throw toTeardownError(key, e); });
          if (staleClient.lifecycle === "stopped") await this.manager?.release(key, staleClient).catch((e) => { throw toTeardownError(key, e); });
          else throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
          this.lastMcpIdentity.delete(key);
        }
      }
      // Check queue before coolPending — even if no client, need to drain B
      let hasPending = false;
      try {
        hasPending = !!(this.queueStore && await this.queueStore.hasPending(key));
      } catch {}
      if (hasPending) {
        const latest = this.sessionCatalog.get(key) ?? input;
        this.kickDrain(latest).catch(() => {});
      } else {
        const client = this.manager?.get(key);
        if (client) {
          if (this.coolPending.has(key)) {
          this.coolPending.delete(key);
          await client.terminate().catch((error) => {
            throw toTeardownError(key, error);
          });
          client.lifecycle = "stopped";
          await this.manager?.release(key, client);
        } else if (client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready")) {
          this.scheduleIdleTtl(key, client);
        }
      }
    }
      } finally {
        releaseTurn?.();
      }
    }
  }

  async injectMessage(input: EngineInjectInput): Promise<{ status: "queued"; modeUsed: "queue"; queueItemId: string }> {
    if (this.shuttingDown) throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    // Steer/interrupt remain unsupported until same-turn behavior is proven
    if (input.mode === "steer" || input.mode === "interrupt") {
      throw new RuntimeError(
        "RUNTIME_ENGINE_UNSUPPORTED",
        `injectMessage mode "${input.mode}" is not supported by the runtime engine yet`,
      );
    }
    const mode: "queue" | "auto" = input.mode === "auto" ? "auto" : "queue";
    // Always refresh catalog with latest MCP identity (not just when absent) — otherwise A then B uses A drain
    this.sessionCatalog.set(key, {
      ...(this.sessionCatalog.get(key) ?? {}),
      name: input.name ?? (input as unknown as EngineSessionInput).name ?? key,
      logicalSessionId: input.logicalSessionId ?? key,
      cwd: input.cwd ?? (input as unknown as EngineSessionInput).cwd,
      agent: (input as unknown as EngineSessionInput).agent ?? "codex",
      mcpCoordinatorSession: (input as unknown as EngineSessionInput).mcpCoordinatorSession,
      mcpSourceHandle: (input as unknown as EngineSessionInput).mcpSourceHandle,
    } as EngineSessionInput);
    // PR8: stale MCP check for inject — never execute B on A worker (converged via isMcpStale)
    {
      const lastMcp = this.lastMcpIdentity.get(key);
      const reqMcp = { mcpCoordinatorSession: (input as unknown as EngineSessionInput).mcpCoordinatorSession, mcpSourceHandle: (input as unknown as EngineSessionInput).mcpSourceHandle };
      const isStale = this.isMcpStale(lastMcp, reqMcp);
      if (isStale) {
        const cl = this.manager?.get(key);
        const isActive = this.isStaleActiveForInjectOrCheck(key, cl);
        if (isActive) {
          this.staleAfterTurn.add(key);
        } else if (cl) {
          await cl.shutdown().catch((e) => { throw toTeardownError(key, e); });
          if (cl.lifecycle === "stopped") await this.manager?.release(key, cl).catch((e) => { throw toTeardownError(key, e); });
          else throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
          this.lastMcpIdentity.delete(key);
          this.staleAfterTurn.delete(key);
        }
      }
    }
    const catalogInput = this.sessionCatalog.get(key)!;
    const store = this.getQueueStore();
    const receipt = await store.enqueue(key, { messageId: input.messageId, text: input.text, mode, mcpCoordinatorSession: (input as unknown as EngineSessionInput).mcpCoordinatorSession, mcpSourceHandle: (input as unknown as EngineSessionInput).mcpSourceHandle }, {
      isDeleting: (k) => this.deleting.has(k),
      isCoolPending: (k) => this.coolPending.has(k),
    });
    this.kickDrain(catalogInput).catch(() => {});
    return receipt;
  }

  async setMode(input: EngineSessionInput & { modeId: string }) {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      await client.request("setMode", { mode: input.modeId });
      return {};
    });
    return {};
  }

  async setModel(input: EngineSessionInput & { modelId: string }) {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      await client.request("setConfigOption", { key: "model", value: input.modelId });
      return {};
    });
    return {};
  }

  async getSessionModel(input: EngineSessionInput): Promise<{ current?: string; available: string[] }> {
    return await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      const status = (await client.request<{ models?: { currentModelId?: string; availableModelIds: string[] } }>("status")) ?? {};
      return {
        current: status.models?.currentModelId,
        available: status.models?.availableModelIds ?? [],
      };
    });
  }

  async setSessionEffort(input: EngineSessionInput & { effort: string }): Promise<Record<string, never>> {
    return await this.applyConfigOption(input, "effort", input.effort);
  }

  private async applyConfigOption(input: EngineSessionInput, key: string, value: string): Promise<Record<string, never>> {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      await client.request("setConfigOption", { key, value });
      return {};
    });
    return {};
  }

  async getSessionEffort(input: EngineSessionInput): Promise<SessionEffortState> {
    return await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      // Public acpx Runtime exposes config options via status.details.configOptions
      // (same shape as the CLI record's acpx.config_options) — reuse the shared
      // CLI effort resolver instead of a fabricated top-level field.
      const status = (await client.request<{
        details?: { configOptions?: unknown };
        models?: { currentModelId?: string; availableModelIds?: string[] };
      }>("status")) ?? {};
      const rawConfig = JSON.stringify({
        acpx: { config_options: status.details?.configOptions ?? [] },
      });
      const parsed = parseSessionEffortRecord(rawConfig);
      return {
        current: parsed?.current,
        available: parsed?.available ?? [],
      };
    });
  }
  async cancel(input: EngineSessionInput): Promise<{ cancelled: boolean; message: string }> {
    // Admission gate: wait for any in-flight policy transition (plan §32)
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    this.sessionCatalog.set(key, input);
    const client = this.manager?.get(key);
    let cancelledActive = false;
    if (client && client.alive) {
      try {
        const result = await client.request<{ cancelled: boolean }>("cancel");
        cancelledActive = result.cancelled === true;
      } catch {}
    }
    // PR6: cancel is active-turn only for now — pending queue remains (parity with CLI where cancel does not clear queue)
    // After active cancel settles, if queue has pending, kick drain so queue does not stall
    try {
      if (this.queueStore && await this.queueStore.hasPending(key)) {
        // Only kick drain if no active turn remains (cancel may still be draining)
        if (!this.hasActiveTurn(key)) {
          this.kickDrain(input).catch(() => {});
        }
      }
    } catch {}
    if (cancelledActive) return { cancelled: true, message: "cancel delivered to runtime worker" };
    if (!client || !client.alive) return { cancelled: false, message: "no active runtime worker for session" };
    return { cancelled: false, message: "cancel delivered to runtime worker" };
  }
  async removeSession(input: EngineSessionInput): Promise<Record<string, never>> {
    // Plan §20: close() semantics differ between engines. Until parity is proven,
    // fail loudly instead of silently diverging from CLI `sessions close`.
    throw new RuntimeError(
      "RUNTIME_ENGINE_UNSUPPORTED",
      "removeSession on a runtime-bound session requires close-parity validation; use deleteSession for a hard delete",
    );
  }

  async deleteSession(input: EngineSessionInput): Promise<Record<string, never>> {
    if (this.shuttingDown) throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    // Admission gate: wait for any in-flight policy transition
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    // PR6: mark deleting so new enqueue is rejected (lifecycle boundary)
    this.deleting.add(key);
    this.deleteGenerations.set(key, (this.deleteGenerations.get(key) ?? 0) + 1);
    try {
      let client: ReturnType<NonNullable<typeof this.manager>["get"]> = this.manager?.get(key);

      // 1. Resolve REAL record id (plan §19 order). Never fallback to logicalSessionId.
      const recordId = await this.resolveRecordId(input, client);

      // 2. If no record exists on disk or memory, idempotent success (G4) — but still terminate warm worker.
      // G4: must not return success while turn still active and journal still there. Wait for active turn to settle.
      if (!recordId) {
        if (this.hasActiveTurn(key)) {
          await this.waitForNoActiveTurn(key);
          // Refresh client after wait (prompt finally may have terminated it)
          const refreshed = this.manager?.get(key);
          // Re-assert no new turn slipped in between wait and terminate (deleting still true, new prompt inc->lease->rejected, but inc window exists)
          if (this.hasActiveTurn(key)) {
            throw new RuntimeError(
              "RUNTIME_WORKER_TEARDOWN_PENDING",
              `cannot hard delete session "${key}" while turn active`,
            );
          }
          if (refreshed) {
            // client is refreshed for below, but we are in no-record branch so we handle it here
            if (!refreshed.alive && refreshed.lifecycle !== "stopped") {
              throw new RuntimeError(
                "RUNTIME_WORKER_TEARDOWN_PENDING",
                `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
              );
            }
            if (refreshed.alive) {
              if (this.hasActiveTurn(key)) {
                throw new RuntimeError(
                  "RUNTIME_WORKER_TEARDOWN_PENDING",
                  `cannot hard delete session "${key}" while turn active`,
                );
              }
              await refreshed.request("close").catch(() => {});
              await refreshed.terminate().catch((error) => {
                throw toTeardownError(key, error);
              });
              if (refreshed.lifecycle === "stopped") {
                await this.manager?.release(key, refreshed);
              }
            } else {
              this.manager?.deleteWorker(key, refreshed);
            }
          }
        } else if (client) {
          if (!client.alive && client.lifecycle !== "stopped") {
            throw new RuntimeError(
              "RUNTIME_WORKER_TEARDOWN_PENDING",
              `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
            );
          }
          if (client.alive) {
            if (this.hasActiveTurn(key)) {
              throw new RuntimeError(
                "RUNTIME_WORKER_TEARDOWN_PENDING",
                `cannot hard delete session "${key}" while turn active`,
              );
            }
            await client.request("close").catch(() => {});
            await client.terminate().catch((error) => {
              throw toTeardownError(key, error);
            });
            if (client.lifecycle === "stopped") {
              await this.manager?.release(key, client);
            }
          } else {
            this.manager?.deleteWorker(key, client);
          }
        }
        this.clearActiveTurn(key);
        this.coolPending.delete(key);
        this.recordIds.delete(key);
        await this.getQueueStore().removeJournal(key);
        this.sessionCatalog.delete(key);
        this.deleteGenerations.delete(key);
        return {};
      }

    const safeId = encodeURIComponent(recordId);
    const sessionsDir = this.sessionsDir();

    // 3. STRICT TRANSACTION BOUNDARY (G4): persist delete intent BEFORE any destructive operations!
    // If tombstone write fails, deleteSession aborts immediately without touching worker or files.
    await writeTombstoneStrict(sessionsDir, safeId, {
      logicalSessionId: input.logicalSessionId,
      name: input.name,
      cwd: input.cwd,
      agentCommand: input.agentCommand ?? input.rawCommand ?? input.acpxAgent,
      recordId,
    });

    // 4. Terminate live worker (close with discard) — if active turn, wait for settle (fail-closed).
    // G4: do not delete record/journal while turn still active.
    // Note: tombstone already persisted before this wait; on timeout we leave tombstone for retry (G4).
    if (this.hasActiveTurn(key)) {
      await this.waitForNoActiveTurn(key);
      // Refresh client after wait (prompt finally may have terminated it)
      const refreshed = this.manager?.get(key);
      if (refreshed !== undefined) client = refreshed;
      if (this.hasActiveTurn(key)) {
        throw new RuntimeError(
          "RUNTIME_WORKER_TEARDOWN_PENDING",
          `cannot hard delete session "${key}" while turn active`,
        );
      }
    }
    if (client) {
      if (!client.alive && client.lifecycle !== "stopped") {
        throw new RuntimeError(
          "RUNTIME_WORKER_TEARDOWN_PENDING",
          `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
        );
      }
      if (client.alive) {
        if (this.hasActiveTurn(key)) {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `cannot hard delete session "${key}" while turn active`,
          );
        }
        await client.request("close").catch(() => {});
        await client.terminate().catch((error) => {
          throw toTeardownError(key, error);
        });
        if (client.lifecycle === "stopped") {
          await this.manager?.release(key, client);
        }
      } else {
        this.manager?.deleteWorker(key, client);
      }
    }
    this.clearActiveTurn(key);
    this.coolPending.delete(key);

    try {
      await this.deleteRecordFilesStrict(recordId);
      await removeTombstoneStrict(sessionsDir, safeId);
      this.recordIds.delete(key);
      // 6. PR6: only after record deletion verified successful, delete runtime queue journal fail-closed
      await this.getQueueStore().removeJournal(key);
      this.sessionCatalog.delete(key);
      this.deleteGenerations.delete(key);
    } catch (error) {
      throw error;
    } finally {
      this.deleting.delete(key);
      this.queueSuspended.delete(key);
    }

    return {};
    } finally {
      this.deleting.delete(key);
      this.queueSuspended.delete(key);
    }
  }

  async freeWarmProcess(input: EngineSessionInput): Promise<Record<string, never>> {
    const key = this.workerKey(input);
    this.sessionCatalog.set(key, input);
    const timer = this.idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }
    // PR6: archive suspend — if durable queue has pending, suspend draining and allow cool (queue remains durable until next direct prompt)
    // G6/G11: durable suspend must be fail-closed — persist first, then memory.
    try {
      if (this.queueStore && await this.queueStore.hasPending(key)) {
        await this.getQueueStore().setSuspended(key, true);
        this.queueSuspended.add(key);
      }
    } catch (err) {
      // Persist failed or unreadable queue -> fail closed, do not cool and do not leave memory suspend without durable flag
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError("RUNTIME_INIT_FAILED", `failed to persist archive suspend for "${key}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // A concurrently in-flight acquire must settle first: coolPending has to
    // attach to the registered client, not race its registration.
    const inflight = this.acquiring.get(key);
    if (inflight) await inflight.catch(() => {});
    const client = this.manager?.get(key);
    if (!client) return {};
    if (!client.alive && client.lifecycle !== "stopped") {
      // Dead but unverified owner: ownership cleanup was never proven — the
      // Engine MUST NOT report success for a cleanup that did not happen.
      // Archive may catch this best-effort, but the bridge RPC must reject.
      throw new RuntimeError(
        "RUNTIME_WORKER_TEARDOWN_PENDING",
        `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing freeWarmProcess`,
      );
    }
    if (this.hasActiveTurn(key)) {
      // Active turn in flight: mark for cool-after-settle, never kill mid-turn (plan §14).
      this.coolPending.add(key);
      return {};
    }
    await client.shutdown().catch((error) => {
      throw toTeardownError(key, error);
    });
    if (client.lifecycle === "stopped") {
      await this.manager?.release(key, client);
    }
    return {};
  }

  async isSessionWarm(input: EngineSessionInput): Promise<{ warm: boolean }> {
    const key = this.workerKey(input);
    return { warm: this.manager?.isWarm(key) === true };
  }

  /** PR6: Bridge restart recovery — enumerate queue journals and kick drain for authoritative runtime-bound sessions. Fail-closed on corrupt/unreadable. */
  async primeQueuesFromCatalog(sessions: EngineSessionInput[]): Promise<void> {
    for (const s of sessions) this.sessionCatalog.set(this.workerKey(s), s);
    if (!this.queueStore) return;
    const ids = await this.queueStore.listLogicalSessionIds();
    for (const id of ids) {
      const input = this.sessionCatalog.get(id);
      if (!input) continue;
      try {
        if (await this.queueStore.isSuspended(id)) {
          this.queueSuspended.add(id);
        }
      } catch {}
      if (await this.queueStore.hasPending(id)) {
        if (this.queueSuspended.has(id)) continue;
        this.kickDrain(input).catch(() => {});
      }
    }
  }

  /** Obtains the real acpx record id without creating phantom records on cold delete. */
  private async resolveRecordId(input: EngineSessionInput, client?: RuntimeWorkerClient): Promise<string | undefined> {
    const key = this.workerKey(input);
    const cached = this.recordIds.get(key);
    if (cached) return cached;
    // Live worker: ask status directly.
    if (client && client.alive) {
      try {
        const status = (await client.request<{ acpxRecordId?: string }>("status")) ?? {};
        if (status.acpxRecordId) {
          this.recordIds.set(key, status.acpxRecordId);
          return status.acpxRecordId;
        }
      } catch {
        // ignore, fall through to disk lookup
      }
    }

    // Check for active tombstones from previous partial delete attempts
    const tombstoneId = await findTombstoneRecordId(
      {
        logicalSessionId: input.logicalSessionId,
        name: input.name,
        cwd: input.cwd,
        agentCommand: input.agentCommand,
        rawCommand: input.rawCommand,
        acpxAgent: input.acpxAgent,
      },
      this.sessionsDir(),
    );
    if (tombstoneId) {
      this.recordIds.set(key, tombstoneId);
      return tombstoneId;
    }

    // Cold worker / post-restart: scan on-disk sessions without spawning a worker.
    const lookup = await findAcpxRecordIdFromDisk(
      {
        name: input.name,
        cwd: input.cwd,
        agentCommand: input.agentCommand,
        acpxAgent: input.acpxAgent,
        rawCommand: input.rawCommand,
      },
      this.sessionsDir(),
    );
    if (lookup.kind === "found") {
      this.recordIds.set(key, lookup.recordId);
      return lookup.recordId;
    }
    if (lookup.kind === "failed") {
      throw new RuntimeError(
        "RUNTIME_INIT_FAILED",
        `failed to resolve acpx record id for delete (disk verification failed): ${lookup.error.message}`,
      );
    }

    return undefined;
  }
  /**
   * Strict delete (G4): verified complete eradication of all record and history artifacts.
   * Unlinks the main .json record AND all stream/history files matching the record id.
   * Every retry iteration re-enumerates the directory; success is returned ONLY when
   * zero matching artifacts remain on disk.
   */
  private async acquireTurnLease(key: string): Promise<() => void> {
    const prior = this.turnLeases.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prior.then(() => next, () => next);
    this.turnLeases.set(key, tail);
    await prior;
    if (this.shuttingDown) {
      release();
      if (this.turnLeases.get(key) === tail) this.turnLeases.delete(key);
      throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    }
    return () => {
      release();
      if (this.turnLeases.get(key) === tail) this.turnLeases.delete(key);
    };
  }

  private async deleteRecordFilesStrict(recordId: string): Promise<void> {
    const dir = this.sessionsDir();
    const safeId = encodeURIComponent(recordId);
    const mainJson = `${safeId}.json`;
    const deadline = Date.now() + 5_000;

    for (;;) {
      await deleteAcpxSessionFiles({ acpxRecordId: recordId, sessionsDir: dir }).catch(() => {});

      let remaining: string[] = [];
      try {
        const entries = await readdir(dir);
        // Match ALL artifacts for this session: the index json and any stream segments
        const matching = entries.filter((name) => name === mainJson || name.startsWith(`${safeId}.stream.`));
        for (const file of matching) {
          await unlink(join(dir, file)).catch(() => {});
        }
        // Re-read directory to verify whether any artifacts remain on disk
        const afterEntries = await readdir(dir);
        remaining = afterEntries.filter((name) => name === mainJson || name.startsWith(`${safeId}.stream.`));
      } catch (error) {
        if (isEnoent(error)) {
          return; // sessions dir is genuinely gone -> zero artifacts remain
        }
        if (Date.now() >= deadline) {
          throw new RuntimeError(
            "RUNTIME_INIT_FAILED",
            `cannot verify deletion of acpx session record "${recordId}": readdir("${dir}") failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await sleep(100);
        continue;
      }
      if (remaining.length === 0) {
        return; // Complete verification: zero record or history artifacts remain on disk.
      }

      if (Date.now() >= deadline) {
        throw new RuntimeError(
          "RUNTIME_INIT_FAILED",
          `acpx session record "${recordId}" has ${remaining.length} artifact(s) still remaining after delete deadline: ${remaining.join(", ")}`,
        );
      }
      await sleep(100);
    }
  }

  async getAgentSessionId(input: EngineSessionInput): Promise<{ agentSessionId: string | undefined }> {
    return await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      const status = (await client.request<{ acpxRecordId?: string; agentSessionId?: string }>("status")) ?? {};
      return { agentSessionId: status.agentSessionId };
    });
  }

  private async acquirePolicyLock(): Promise<void> {
    while (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.policyTransitionLock = promise;
    this.policyLockRelease = resolve;
  }

  private releasePolicyLock(): void {
    this.policyLockRelease?.();
    this.policyTransitionLock = undefined;
    this.policyLockRelease = undefined;
  }
  /**
   * Transactional prepare (plan §32):
   * 1. Acquire transition lock to serialize updates and block new prompts.
   * 2. Preflight: if ANY session is active/busy, fail closed immediately.
   * 3. Rotation: terminate all idle warm workers so no worker running the old
   *    policy survives. (Workers exit cleanly without closing the session record).
   */
  async preparePolicyTransition(): Promise<void> {
    await this.acquirePolicyLock();
    try {
      // Global fail-closed preflight (plan §32): an active turn or an
      // in-flight worker acquisition on ANY session races the policy
      // rotation — the transition must not cross that boundary.
      if (this.hasAnyActiveTurn()) {
        throw new RuntimeError(
          "RUNTIME_PERMISSION_BUSY",
          `cannot update permission policy while session(s) "${[...this.activeTurns.keys()].join(", ")}" have in-flight turns (fail closed)`,
        );
      }
      if (this.acquiring.size > 0) {
        throw new RuntimeError(
          "RUNTIME_PERMISSION_BUSY",
          `cannot update permission policy while worker acquisition(s) for session(s) "${[...this.acquiring.keys()].join(", ")}" are in flight (fail closed)`,
        );
      }
      const live = this.manager?.workers() ?? [];
      for (const worker of live) {
        if (worker.lifecycle === "busy" || worker.hasInFlight) {
          throw new RuntimeError(
            "RUNTIME_PERMISSION_BUSY",
            `cannot update permission policy while session "${worker.ref.logicalSessionId}" has in-flight operations (fail closed)`,
          );
        }
      }
      // Do NOT terminate healthy idle workers — next commit will live-update them
    } catch (error) {
      this.releasePolicyLock();
      throw error;
    }
  }

  /** Transactional commit: live-update all workers without rotation (PR7). */
  async commitPolicyTransition(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<void> {
    try {
      if (policy.permissionPolicy !== undefined) {
        const { parseXacpxPermissionPolicy } = await import("./runtime/runtime-permission-policy");
        parseXacpxPermissionPolicy(policy.permissionPolicy);
      }
    } catch (err) {
      this.releasePolicyLock();
      throw new RuntimeError("RUNTIME_INIT_FAILED", `invalid permission policy: ${err instanceof Error ? err.message : String(err)}`);
    }
    const nextGeneration = this.permissionGeneration + 1;
    const live = this.manager?.workers() ?? [];
    this.options.permissionMode = policy.permissionMode;
    this.options.nonInteractivePermissions = policy.nonInteractivePermissions;
    this.options.permissionPolicy = policy.permissionPolicy;
    this.permissionGeneration = nextGeneration;
    if (live.length === 0) {
      this.releasePolicyLock();
      return;
    }
    const results = await Promise.allSettled(
      live.map((w) =>
        w.request<{ generation: number; accepted: boolean }>("permission.update", {
          generation: nextGeneration,
          permissionMode: policy.permissionMode,
          nonInteractivePermissions: policy.nonInteractivePermissions,
          ...(policy.permissionPolicy !== undefined ? { permissionPolicy: policy.permissionPolicy } : { permissionPolicy: null, clearPermissionPolicy: true }),
        }),
      ),
    );
    const failedWorkers: typeof live = [];
    for (let i = 0; i < live.length; i++) {
      const r = results[i];
      const w = live[i]!;
      if (r && r.status === "fulfilled" && (r.value as { accepted?: boolean }).accepted === true) continue;
      failedWorkers.push(w);
    }
    if (failedWorkers.length > 0) {
      const termResults = await Promise.allSettled(failedWorkers.map((w) => w.terminate()));
      for (let i = 0; i < failedWorkers.length; i++) {
        const tr = termResults[i];
        const w = failedWorkers[i]!;
        if (tr && tr.status === "fulfilled") {
          if (w.lifecycle === "stopped") await this.manager?.release(w.ref.logicalSessionId, w).catch(() => {});
        } else {
          this.releasePolicyLock();
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `permission update failed for session "${w.ref.logicalSessionId}" and worker teardown also failed: ${tr && tr.status === "rejected" ? String((tr as PromiseRejectedResult).reason) : "unknown"}`,
          );
        }
      }
    }
    this.releasePolicyLock();
  }

  /** Transactional rollback: release lock without committing when CLI update fails. */
  async rollbackPolicyTransition(): Promise<void> {
    this.releasePolicyLock();
  }

  async updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>> {
    await this.preparePolicyTransition();
    await this.commitPolicyTransition(policy);
    return {};
  }
  async shutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true;
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    this.coolPending.clear();
    if (this.draining.size > 0) {
      let _shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const _shutdownTimeout = new Promise<void>((resolve) => {
        _shutdownTimer = setTimeout(resolve, 8_000);
        _shutdownTimer.unref?.();
      });
      try {
        await Promise.race([Promise.allSettled([...this.draining.values()]), _shutdownTimeout]);
      } finally {
        if (_shutdownTimer) clearTimeout(_shutdownTimer);
      }
    }
    await this.manager?.shutdownAll();
    return {};
  }
}
export class RuntimeError extends Error {
  constructor(readonly code: RuntimeBridgeErrorCode | string, message: string) {
    super(message);
  }
}

export class WorkerUnavailableError extends RuntimeError {
  constructor(message: string) {
    super("RUNTIME_ENGINE_UNSUPPORTED", message);
  }
}

/**
 * Single stable error boundary (plan §42/§43): EVERY error escaping the
 * RuntimeEngine carries a stable RuntimeBridgeErrorCode, so the BridgeServer
 * error boundary never flattens a typed worker failure into
 * BRIDGE_INTERNAL_ERROR.
 */
export function toStableRuntimeError(error: unknown): Error {
  if (error instanceof RuntimeError) return error;
  if (error instanceof WorkerRpcError) {
    // Worker RPC errors are already mapped to contract codes worker-side
    // (mapRuntimeError in runtime-worker-main) — carry the code 1:1.
    return new RuntimeError(error.code, error.message);
  }
  if (error instanceof WorkerCrashError) {
    return new RuntimeError("RUNTIME_WORKER_CRASHED", error.message);
  }
  if (error instanceof WorkerBootstrapError) {
    return new RuntimeError("RUNTIME_INIT_FAILED", error.message);
  }
  if (error instanceof WorkerTeardownPendingError) {
    return new RuntimeError(error.code, error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Wraps a teardown/terminate failure: the worker tree was NOT verifiably
 * discharged, so the RPC must reject with the stable teardown-pending code —
 * never leak a raw process-tree error into BRIDGE_INTERNAL_ERROR.
 */
function toTeardownError(key: string, error: unknown): RuntimeError {
  const stable = toStableRuntimeError(error);
  if (stable instanceof RuntimeError && stable.code === "RUNTIME_WORKER_TEARDOWN_PENDING") return stable;
  return new RuntimeError(
    "RUNTIME_WORKER_TEARDOWN_PENDING",
    `runtime worker for session "${key}" teardown did not verify: ${stable.message}`,
  );
}

// Re-exported so callers can instanceof without importing two modules.
export { WorkerCrashError };
const MAX_RUNTIME_IMAGE_BYTES = 100 * 1024 * 1024;

/** PR4: convert xacpx prompt media into ACP binary attachments (image/audio)
 *  plus a text attachment for non-binary files, matching CLI behavior. */
async function buildRuntimeAttachments(
  media?: PromptMediaInput,
): Promise<Array<{ mediaType: string; data: string }>> {
  if (!media) return [];
  const mediaList = Array.isArray(media) ? media : [media];
  const attachments: Array<{ mediaType: string; data: string }> = [];
  for (const item of mediaList) {
    if (item.type === "image") {
      const imageData = await readImageFileBounded(item.filePath, MAX_RUNTIME_IMAGE_BYTES);
      attachments.push({
        mediaType: item.mimeType || "image/png",
        data: imageData.toString("base64"),
      });
      continue;
    }
    if (item.type === "audio") {
      const audioData = await readImageFileBounded(item.filePath, MAX_RUNTIME_IMAGE_BYTES);
      attachments.push({ mediaType: item.mimeType || "audio/mpeg", data: audioData.toString("base64") });
      continue;
    }
    // video/file: pinned acpx 0.13.1 public Runtime maps ONLY image/* and
    // audio/* attachments to ACP content blocks. Silently dropping them would
    // make the agent unaware an attachment exists — fail closed instead
    // (CLI lane remains available for these types).
    throw new RuntimeError(
      "RUNTIME_ENGINE_UNSUPPORTED",
      `Runtime engine does not support ${item.type} attachments (pinned acpx Runtime only forwards image/audio); use the CLI engine for this session`,
    );
  }
  return attachments;
}

// Plan parity gate: pinned acpx 0.13.1 public Runtime flattens plan events to a
// single status text ("plan: <first entry content>") — full entries and real
// statuses are lost upstream. Fabricating a PlanEntry would feed the上层 wrong
// data, so the plan side-channel is explicitly unsupported until a public
// Runtime version exposes structured plan entries (plan §41 gate).

export function mapRuntimeToolEvent(event: {
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}): ToolUseEvent {
  const toolCallId = event.toolCallId || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const title = (event.title ?? "").trim();
  const toolName = title || "Tool";
  const statusRaw = (event.status ?? "").toLowerCase();
  const status: ToolUseStatus =
    statusRaw === "completed" || statusRaw === "success"
      ? "success"
      : statusRaw === "failed" || statusRaw === "error"
        ? "error"
        : "running";
  const validKinds = new Set(["read", "search", "execute", "edit", "think", "other"]);
  const kind: ToolUseKind =
    typeof event.kind === "string" && validKinds.has(event.kind.toLowerCase())
      ? (event.kind.toLowerCase() as ToolUseKind)
      : "other";

  return {
    toolCallId,
    toolName,
    kind,
    status,
    ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
    ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
  };
}
function userContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content !== "object" || content === null) return "";
  const c = content as Record<string, unknown>;
  if ("Text" in c && typeof c.Text === "string") return c.Text;
  if ("text" in c && typeof c.text === "string") return c.text;
  if ("Mention" in c && typeof (c.Mention as { content?: string })?.content === "string") return (c.Mention as { content: string }).content;
  if ("Image" in c) return (c.Image as { source?: string })?.source || "[image]";
  if ("Audio" in c) return `[audio] ${(c.Audio as { mime_type?: string })?.mime_type || "audio"}`;
  return "";
}

function agentContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content !== "object" || content === null) return "";
  const c = content as Record<string, unknown>;
  if ("Text" in c && typeof c.Text === "string") return c.Text;
  if ("text" in c && typeof c.text === "string") return c.text;
  if ("Thinking" in c && typeof (c.Thinking as { text?: string })?.text === "string") return (c.Thinking as { text: string }).text;
  if ("RedactedThinking" in c) return "[redacted_thinking]";
  if ("ToolUse" in c && typeof (c.ToolUse as { name?: string })?.name === "string") return `[tool:${(c.ToolUse as { name: string }).name}]`;
  return "";
}

export function extractConversationEntries(record: Record<string, unknown>): Array<{ role: string; textPreview: string }> {
  const entries: Array<{ role: string; textPreview: string }> = [];
  if (Array.isArray(record.messages)) {
    for (const message of record.messages) {
      if (message === "Resume") continue;
      if (typeof message !== "object" || message === null) continue;
      if ("User" in message && message.User) {
        const userContent = Array.isArray(message.User.content) ? message.User.content : [message.User.content];
        const text = userContent.map(userContentToText).join(" ").trim();
        if (text) entries.push({ role: "user", textPreview: text });
      } else if ("Agent" in message && message.Agent) {
        const agentContent = Array.isArray(message.Agent.content) ? message.Agent.content : [message.Agent.content];
        const text = agentContent.map(agentContentToText).join(" ").trim();
        if (text) entries.push({ role: "assistant", textPreview: text });
      } else if ("role" in message && typeof message.role === "string") {
        const text = typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((b: unknown) => typeof b === "string" ? b : typeof (b as { text?: string })?.text === "string" ? (b as { text: string }).text : "").join(" ").trim()
            : typeof (message as { text?: string }).text === "string" ? (message as { text: string }).text : "";
        if (text) entries.push({ role: message.role, textPreview: text });
      }
    }
  }
  return entries;
}

export function extractTextFromAcpMessage(parsed: Record<string, unknown>): string[] {
  const results: string[] = [];
  const update = (parsed.params as { update?: Record<string, unknown> } | undefined)?.update;
  if (update) {
    if (typeof update.text === "string" && update.text) {
      results.push(update.text);
    }
    if (typeof update.content === "string" && update.content) {
      results.push(update.content);
    } else if (Array.isArray(update.content)) {
      for (const item of update.content) {
        if (typeof item === "string" && item) results.push(item);
        else if (item && typeof (item as { text?: string }).text === "string" && (item as { text: string }).text) {
          results.push((item as { text: string }).text);
        }
      }
    } else if (update.content && typeof (update.content as { text?: string }).text === "string") {
      results.push((update.content as { text: string }).text);
    }
    if (update.delta && typeof (update.delta as { text?: string }).text === "string") {
      results.push((update.delta as { text: string }).text);
    }
  }
  if (results.length === 0) {
    if (typeof parsed.text === "string" && parsed.text) {
      results.push(parsed.text);
    } else if (typeof parsed.content === "string" && parsed.content) {
      results.push(parsed.content);
    }
  }
  return results;
}

function emitPromptEvent(event: XacpxRuntimeEvent, onEvent?: (event: EnginePromptStreamEvent) => void): void {
  if (!onEvent) return;
  if (event.type === "text_delta") {
    onEvent(event.stream === "thought"
      ? { type: "prompt.thought", text: event.text }
      : { type: "prompt.segment", text: event.text });
  } else if (event.type === "tool_call") {
    onEvent({ type: "prompt.tool_event", event: mapRuntimeToolEvent(event) });
  } else if (event.type === "status") {
    // G9: missing usage means unknown, NOT zero. Never fabricate 0 for undefined fields.
    if (typeof event.used === "number" && typeof event.size === "number") {
      onEvent({
        type: "prompt.usage",
        used: event.used,
        size: event.size,
        ...(event.cost ? { cost: event.cost as never } : {}),
        ...(event.breakdown ? { breakdown: event.breakdown as never } : {}),
      });
    }
    if (event.availableCommands && event.availableCommands.length > 0) {
      onEvent({ type: "prompt.commands", commands: event.availableCommands.map((command) => ({ name: command.name, description: command.description })) as never });
    }
  }
}
