import { access, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
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
import { RuntimePermissionResolver, type RuntimePermissionRequest } from "./runtime/runtime-permission-resolver";
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
  /** Override for the durable worker-ownership fence directory (tests). Defaults to `<durable root>/worker-fences`. */
  fenceDir?: string;
  /** Override for the durable runtime queue directory (tests). Defaults to `<durable root>/runtime-queue`. */
  queueDir?: string;
  /**
   * Override for the xacpx-owned durable root that hosts the queue and fence
   * directories (tests / isolated daemons). Defaults to
   * `<xacpx home>/runtime` (via coreHomeDir). This is deliberately NOT the
   * acpx sessions root: queue journals and worker fences are xacpx-private
   * coordination state and must never live inside upstream acpx internals.
   */
  durableRootDir?: string;
  /** Quiescence timeout in ms for deleteSession / worker shutdown (tests). Defaults to 8,000. */
  workerQuiescenceTimeoutMs?: number;
  /**
   * PR9-A: Host-side UI handler for interactive permission requests.
   * If not provided, the engine falls back to local resolver (autoDeny/autoApprove) + fail-closed.
   * Tests should inject a mock that can delay/abort/malform to verify fail-closed.
   */
  onPermissionRequest?: (payload: { logicalSessionId: string; sessionKey: string; requestId: string; toolCallId: string; title?: string; kind?: string; rawInput?: unknown; policyGeneration: number; workerGeneration: string }) => Promise<{ outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" }>;
  /**
   * True only if a real channel/human UI interaction channel exists to prompt
   * the user. Having an RPC callback (onPermissionRequest) merely means the
   * transport bridge exists; without a real human UI, interactiveAvailable
   * is false and policies requiring escalation must be judged Runtime-ineligible
   * and routed to CLI. Defaults to false.
   */
  permissionInteractionAvailable?: boolean;
  /**
   * PR9-C: Host-side handler for elicitation requests (acpx/runtime onElicitation).
   * If not provided, elicitation fails closed (cancel).
   */
  onElicitationRequest?: (payload: { logicalSessionId: string; sessionKey: string; requestId: string; elicitationId: string; mode: string; message: unknown; policyGeneration: number; workerGeneration: string }) => Promise<{ action: "submit" | "cancel"; data?: unknown }>;
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
/**
 * Deterministic physical session fence key (G2). Hash of the normalized
 * physical acpx identity — sessionKey (transport name), cwd, and the
 * launch agent identity. Same before/after record creation and same for
 * two logical aliases that share the same physical session, so the durable
 * fence file is stable across crash+restart and shared-physical aliases
 * correctly contend for the single physical fence. Exported so tests seed
 * residual fences in the real physical namespace.
 */
export function physicalFenceKeyForSession(input: EngineSessionInput): string {
  const normalizedCwd = normalizePathForComparison(input.cwd) ?? input.cwd ?? "";
  // Agent identity: prefer the exact launch identity the Runtime will use.
  // EngineSessionInput carries the resolved launch fields (agentCommand /
  // acpxAgent / rawCommand / agentArgv) from SessionService.toResolvedSession,
  // so the hash is stable for a given physical session.
  const agentId =
    (typeof input.agentCommand === "string" && input.agentCommand.length > 0 ? input.agentCommand : undefined) ??
    (typeof input.rawCommand === "string" && input.rawCommand.length > 0 ? input.rawCommand : undefined) ??
    (typeof input.acpxAgent === "string" && input.acpxAgent.length > 0 ? input.acpxAgent : undefined) ??
    (Array.isArray(input.agentArgv) && input.agentArgv.length > 0 ? input.agentArgv.join(String.fromCharCode(0)) : undefined) ??
    input.agent ??
    "";
  const sessionKey = input.name ?? "";
  const sep = String.fromCharCode(0);
  const raw = `${sessionKey}${sep}${normalizedCwd}${sep}${agentId}`;
  // 32 hex chars (128-bit) is enough to avoid collisions for fence namespace.
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

export class RuntimeEngine implements BridgeEngine {
  readonly kind = "runtime" as const;
  private readonly manager?: RuntimeWorkerManager;
  private readonly activeTurns = new Map<string, number>();
  private readonly inFlightBusinessOps = new Map<string, number>();
  private hasActiveTurn(key: string): boolean { return (this.activeTurns.get(key) ?? 0) > 0; }
  private hasAnyActiveTurn(): boolean { for (const v of this.activeTurns.values()) if (v > 0) return true; return false; }
  private hasAnyBusinessOp(): boolean { for (const v of this.inFlightBusinessOps.values()) if (v > 0) return true; return false; }
  private incActiveTurn(key: string): void { this.activeTurns.set(key, (this.activeTurns.get(key) ?? 0) + 1); }
  private decActiveTurn(key: string): void { const n = (this.activeTurns.get(key) ?? 0) - 1; if (n <= 0) this.activeTurns.delete(key); else this.activeTurns.set(key, n); }
  private incBusinessOp(key: string): void { this.inFlightBusinessOps.set(key, (this.inFlightBusinessOps.get(key) ?? 0) + 1); }
  private decBusinessOp(key: string): void { const n = (this.inFlightBusinessOps.get(key) ?? 0) - 1; if (n <= 0) this.inFlightBusinessOps.delete(key); else this.inFlightBusinessOps.set(key, n); }
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
  private assertLifecycleEpoch(key: string, expectedEpoch: number): void {
    if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== expectedEpoch) {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
    }
  }
  private async waitForAcquiringQuiescence(key: string, timeoutMs = 8_000): Promise<void> {
    const start = Date.now();
    while (this.acquiring.has(key)) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        throw new RuntimeError(
          "RUNTIME_WORKER_TEARDOWN_PENDING",
          `cannot hard delete session "${key}" while worker acquisition in flight`,
        );
      }
      const pending = this.acquiring.get(key)!;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), remaining);
        timeoutHandle.unref?.();
      });
      // Wrap pending to never leave unhandled rejection when timeout wins
      const pendingHandled = pending.then(
        () => ({ status: "done" as const }),
        (error) => ({ status: "rejected" as const, error }),
      );
      const timeoutHandled = timeoutPromise.then(() => ({ status: "timeout" as const }));
      const result = await Promise.race([pendingHandled, timeoutHandled]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (result.status === "timeout") {
        // Attach handler to pending to avoid unhandled rejection if it later rejects
        pending.catch(() => {});
        throw new RuntimeError(
          "RUNTIME_WORKER_TEARDOWN_PENDING",
          `cannot hard delete session "${key}" while worker acquisition in flight`,
        );
      }
      if (result.status === "rejected") {
        const err = (result as { status: "rejected"; error: unknown }).error;
        if (err instanceof WorkerTeardownPendingError) {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `cannot hard delete session "${key}" while worker acquisition failed: ${err.message}`,
          );
        }
        if (err instanceof RuntimeError && err.code === "RUNTIME_WORKER_TEARDOWN_PENDING") throw err;
        throw new RuntimeError(
          "RUNTIME_WORKER_TEARDOWN_PENDING",
          `cannot hard delete session "${key}" while worker acquisition in flight: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // done — loop again to check for new acquiring
    }
  }
  private async waitForWorkerQuiescence(
    logicalKey: string,
    physicalKey: string,
    timeoutMs = this.options.workerQuiescenceTimeoutMs ?? 8_000,
  ): Promise<void> {
    // G4: ensure no worker, no acquiring, no retained fence — all part of same ownership transaction
    const start = Date.now();
    while (true) {
      const hasAcquiring = this.acquiring.has(logicalKey);
      let ownershipError: unknown | undefined;
      if (this.manager) {
        try {
          await this.manager.assertOwnershipQuiescent(logicalKey, physicalKey);
        } catch (err) {
          ownershipError = err;
        }
      }

      if (!hasAcquiring && !ownershipError) return;

      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) {
        if (ownershipError instanceof WorkerTeardownPendingError) {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `cannot hard delete session "${logicalKey}" while worker ownership not quiesced: ${ownershipError.message}`,
          );
        }
        if (ownershipError instanceof RuntimeError) throw ownershipError;
        if (ownershipError) {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `cannot hard delete session "${logicalKey}" while worker ownership not quiesced: ${ownershipError instanceof Error ? ownershipError.message : String(ownershipError)}`,
          );
        }
        if (hasAcquiring) {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `cannot hard delete session "${logicalKey}" while worker acquisition in flight`,
          );
        }
      }

      // If acquiring exists, race it; otherwise poll
      if (hasAcquiring) {
        const pending = this.acquiring.get(logicalKey)!;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<{ status: "timeout" }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ status: "timeout" }), Math.min(remaining, 200));
          timeoutHandle.unref?.();
        });
        const pendingHandled: Promise<{ status: "done" } | { status: "rejected"; error: unknown }> = pending.then(
          () => ({ status: "done" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        pendingHandled.catch(() => {});
        const result = await Promise.race([pendingHandled, timeoutPromise]);
        clearTimeout(timeoutHandle);
        if (result.status === "timeout") {
          pendingHandled.catch(() => {});
          continue;
        }
        if (result.status === "rejected") {
          const err = result.error;
          if (err instanceof WorkerTeardownPendingError || (err instanceof RuntimeError && err.code === "RUNTIME_WORKER_TEARDOWN_PENDING")) {
            throw new RuntimeError(
              "RUNTIME_WORKER_TEARDOWN_PENDING",
              `cannot hard delete session "${logicalKey}" while worker acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          throw err;
        }
        // done -> loop again to re-evaluate
        continue;
      } else {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, Math.min(20, Math.max(1, remaining)));
        await promise;
      }
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
  /**
   * Explicit fail-closed latch for the permission plane. Set when a policy
   * fan-out observed a worker on the new generation but that worker's
   * teardown could not be verified: some live process may still enforce the
   * unpublished policy, so no new turn or transition is admitted until a
   * daemon restart re-establishes a single known policy. This is the
   * "explicit global fail-closed" terminal state — never a silent mixed
   * plane where config says old and a worker enforces new.
   */
  private permissionPoisoned?: string;
  /**
   * Fail-closed gate for everything that would execute under, or change,
   * the live permission policy. Delete/remove/freeWarm/shutdown stay
   * available (recovery paths must never be fenced).
   */
  private assertPermissionPlaneHealthy(): void {
    if (this.permissionPoisoned !== undefined) {
      throw new RuntimeError(
        "RUNTIME_WORKER_TEARDOWN_PENDING",
        `runtime permission plane is failed closed (${this.permissionPoisoned}); restart the daemon to re-establish a single known policy`,
      );
    }
  }
  private poisonPermissionPlane(reason: string): void {
    this.permissionPoisoned ??= reason;
  }
  private queueStore?: RuntimeQueueStore;
  private lastStagedPrevSnapshot?: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions | undefined;
    permissionPolicy?: string;
    generation: number;
  };
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
      const fenceDir: string | (() => string) | undefined = this.options.fenceDir ?? (() => join(this.durableRoot(), "worker-fences"));
      const permissionDeps: RuntimeWorkerClientDeps = {
        ...(options.workerClientDeps ?? {}),
        resolvePermissionRequest: (payload) => this.handlePermissionRequest(payload),
        resolveElicitationRequest: (payload) => this.handleElicitationRequest(payload),
      };
      this.manager = new RuntimeWorkerManager({
        entryPath: entry,
        clientDeps: permissionDeps,
        ...(fenceDir ? { fenceDir } : {}),
      });
    }
    if (options.queueDir) {
      this.queueStore = new RuntimeQueueStore(options.queueDir);
    } else {
      try {
        this.queueStore = new RuntimeQueueStore(join(this.durableRoot(), "runtime-queue"));
      } catch {}
    }
  }

  private durableRoot(): string {
    return this.options.durableRootDir ?? join(coreHomeDir(homedir()), "runtime");
  }

  private workerKey(input: EngineSessionInput): string {
    return input.logicalSessionId ?? input.name;
  }

  private sessionsDir(): string {
    return this.options.stateDir ?? join(resolveAcpxHomeDir(), ".acpx", "sessions");
  }

  private queueDir(): string {
    if (this.options.queueDir) return this.options.queueDir;
    return join(this.durableRoot(), "runtime-queue");
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
    this.assertPermissionPlaneHealthy();
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
                if (event.availableCommands !== undefined) {
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
      const _epochAtLoopTop = this.deleteGenerations.get(key) ?? 0;
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
      if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _epochAtLoopTop) return;
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
          if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _epochAtLoopTop) {
            if (cl.lifecycle === "stopped") {
              await this.manager?.release(key, cl).catch((e) => { throw toTeardownError(key, e); });
            } else {
              throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
            }
            return;
          }
          if (cl.lifecycle === "stopped") await this.manager?.release(key, cl).catch((e) => { throw toTeardownError(key, e); });
          else throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `stale MCP worker for "${key}" did not reach stopped after shutdown`);
          this.lastMcpIdentity.delete(key);
          this.staleAfterTurn.delete(key);
        }
      }
      if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _epochAtLoopTop) return;
      this.incActiveTurn(key);
      const _deleteGenAtStart = _epochAtLoopTop;
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
      // Archive suspend admission: check after lease (cancel may have kicked drain before suspend persisted)
      if (this.queueSuspended.has(key)) {
        this.decActiveTurn(key);
        releaseTurn?.();
        await this.consumeSuspendCool(key);
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
      const interactiveAvailable = this.options.permissionInteractionAvailable === true;
      return isEligibleForRuntime(policy, this.options.nonInteractivePermissions, interactiveAvailable);
    } catch {
      return false;
    }
  }
  private async handlePermissionRequest(payload: { logicalSessionId: string; sessionKey: string; requestId: string; toolCallId: string; title?: string; kind?: string; rawInput?: unknown; policyGeneration: number; workerGeneration: string }): Promise<{ outcome: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancel" }> {
    const key = payload.logicalSessionId;
    if (this.deleting.has(key) || this.shuttingDown) return { outcome: "reject_once" };
    if (payload.policyGeneration !== this.permissionGeneration) return { outcome: "reject_once" };
    const worker = this.manager?.get(key);
    if (!worker || !worker.alive) return { outcome: "reject_once" };
    if (payload.workerGeneration !== worker.ref.generation) return { outcome: "reject_once" };
    if (this.options.onPermissionRequest) {
      try {
        const res = await Promise.race([
          this.options.onPermissionRequest(payload),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("permission UI timeout")), 8_000).unref?.()),
        ]);
        // Re-check fencing after await (G → G+1 race)
        if (this.deleting.has(key) || this.shuttingDown) return { outcome: "reject_once" };
        if (payload.policyGeneration !== this.permissionGeneration) return { outcome: "reject_once" };
        const curWorker = this.manager?.get(key);
        if (!curWorker || curWorker.ref.generation !== payload.workerGeneration) return { outcome: "reject_once" };
        const outcome = res?.outcome;
        if (outcome !== "allow_once" && outcome !== "allow_always" && outcome !== "reject_once" && outcome !== "reject_always" && outcome !== "cancel") {
          return { outcome: "reject_once" };
        }
        return { outcome };
      } catch {
        return { outcome: "reject_once" };
      }
    }
    try {
      const policy = this.options.permissionPolicy !== undefined ? parseXacpxPermissionPolicy(this.options.permissionPolicy) : undefined;
      const resolver = new RuntimePermissionResolver();
      const cfg = {
        generation: this.permissionGeneration,
        permissionMode: this.options.permissionMode as "approve-all" | "approve-reads" | "deny-all",
        nonInteractivePermissions: (this.options.nonInteractivePermissions ?? "deny") as "deny" | "fail",
        ...(policy ? { permissionPolicy: policy } : {}),
      };
      const req = { sessionId: key, raw: { toolCall: { title: payload.title, kind: payload.kind, name: payload.title?.split(":")[0], input: payload.rawInput } }, inferredKind: payload.kind } as unknown as RuntimePermissionRequest;
      return resolver.safeResolve(cfg, req);
    } catch {
      return { outcome: "reject_once" };
    }
  }

  private async handleElicitationRequest(payload: { logicalSessionId: string; sessionKey: string; requestId: string; elicitationId: string; mode: string; message: unknown; policyGeneration: number; workerGeneration: string }): Promise<{ action: "submit" | "cancel"; data?: unknown }> {
    const key = payload.logicalSessionId;
    if (this.deleting.has(key) || this.shuttingDown) return { action: "cancel" };
    if (payload.policyGeneration !== this.permissionGeneration) return { action: "cancel" };
    const worker = this.manager?.get(key);
    if (!worker || !worker.alive) return { action: "cancel" };
    if (payload.workerGeneration !== worker.ref.generation) return { action: "cancel" };
    if (this.options.onElicitationRequest) {
      try {
        const res = await Promise.race([
          this.options.onElicitationRequest(payload),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("elicitation UI timeout")), 30_000).unref?.()),
        ]);
        if (this.deleting.has(key) || this.shuttingDown) return { action: "cancel" };
        if (payload.policyGeneration !== this.permissionGeneration) return { action: "cancel" };
        const curWorker = this.manager?.get(key);
        if (!curWorker || curWorker.ref.generation !== payload.workerGeneration) return { action: "cancel" };
        const action = (res as { action?: unknown })?.action;
        if (action !== "submit" && action !== "cancel") return { action: "cancel" };
        if (action === "submit") return { action: "submit", data: (res as { data?: unknown }).data };
        return { action: "cancel" };
      } catch {
        return { action: "cancel" };
      }
    }
    return { action: "cancel" };
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
    // G2 physical single-owner (plan §43 / review G2): STABLE physical fence key.
    // The durable ownership fence MUST be stable across:
    //   - before vs after acpx record creation (R does not exist yet → R exists)
    //   - two logical aliases sharing the same physical acpx session
    // Using `recordId` when found and `logicalKey` when absent caused a
    // namespace drift: Host A claims L.json, creates R, crashes; Host B
    // looks up R → claims R.json and spawns a second owner while A's
    // adapter tree is still unverified. Fix: hash the normalized physical
    // identity (sessionKey + cwd + agentCommand) — computable before the
    // record exists and identical after.
    const logicalKey = this.workerKey(input);
    const existing = this.acquiring.get(logicalKey);
    if (existing) return existing;

    // Fail-closed validation: any unreadable/corrupt/ambiguous record on disk
    // blocks spawn (G4). This runs before claim so we never spawn over
    // unverifiable ownership evidence.
    const recordLookup = await findAcpxRecordIdFromDisk(input, this.sessionsDir());
    if (recordLookup.kind === "failed") {
      throw new RuntimeError(
        "RUNTIME_INIT_FAILED",
        `cannot verify physical session identity on disk: ${recordLookup.error.message}`,
      );
    }
    const physicalFenceKey = this.physicalFenceKeyForInput(input);

    const acquire = this.manager.acquire(logicalKey, physicalFenceKey);
    this.acquiring.set(logicalKey, acquire);
    try {
      const client = await acquire;
      if (recordLookup.kind === "found") {
        this.recordIds.set(logicalKey, recordLookup.recordId);
      }
      return client;
    } finally {
      this.acquiring.delete(logicalKey);
    }
  }
  /**
   * Deterministic physical session fence key (G2); delegates to the exported
   * physicalFenceKeyForSession so tests use the identical namespace.
   */
  private physicalFenceKeyForInput(input: EngineSessionInput): string {
    return physicalFenceKeyForSession(input);
  }
  private async withWorker<T>(input: EngineSessionInput, run: (client: RuntimeWorkerClient) => Promise<T>): Promise<T> {
    const key = this.workerKey(input);
    const _lifecycleEpochAtEntry = this.deleteGenerations.get(key) ?? 0;
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    this.assertLifecycleEpoch(key, _lifecycleEpochAtEntry);
    this.incBusinessOp(key);
    let client: RuntimeWorkerClient | undefined;
    try {
      try {
        await this.checkMcpStaleAndRotate(input, false);
        this.assertLifecycleEpoch(key, _lifecycleEpochAtEntry);
        const existingTimer = this.idleTimers.get(key);
        if (existingTimer) {
          clearTimeout(existingTimer);
          this.idleTimers.delete(key);
        }
        this.assertLifecycleEpoch(key, _lifecycleEpochAtEntry);
        client = await this.ensureWorker(input);
        if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
          try {
            await client.terminate().catch((e) => { throw toTeardownError(key, e); });
            if (client.lifecycle === "stopped") {
              await this.manager?.release(key, client).catch((e) => { throw toTeardownError(key, e); });
            } else {
              throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `ghost worker for "${key}" did not reach stopped after terminate`);
            }
          } catch (termErr) {
            if (termErr instanceof RuntimeError && termErr.code === "RUNTIME_WORKER_TEARDOWN_PENDING") throw termErr;
            throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `ghost worker teardown failed for "${key}": ${termErr instanceof Error ? termErr.message : String(termErr)}`);
          }
          throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
        }
        this.lastMcpIdentity.set(key, { mcpCoordinatorSession: input.mcpCoordinatorSession, mcpSourceHandle: input.mcpSourceHandle });
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        if (error instanceof WorkerTeardownPendingError) {
          this.assertLifecycleEpoch(key, _lifecycleEpochAtEntry);
          const start = Date.now();
          while (Date.now() - start < 300) {
            const existing = this.manager?.get(key);
            if (!existing || (existing.lifecycle !== "cooling" && existing.lifecycle !== "failed")) break;
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 20);
            await promise;
          }
          const still = this.manager?.get(key);
          if (still && (still.lifecycle === "cooling" || still.lifecycle === "failed")) {
            throw new RuntimeError(error.code, error.message);
          }
          this.assertLifecycleEpoch(key, _lifecycleEpochAtEntry);
          try {
            client = await this.ensureWorker(input);
            if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
              try {
                await client.terminate().catch((e) => { throw toTeardownError(key, e); });
                if (client.lifecycle === "stopped") {
                  await this.manager?.release(key, client).catch((e) => { throw toTeardownError(key, e); });
                } else {
                  throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `ghost worker for "${key}" did not reach stopped after terminate`);
                }
              } catch (termErr) {
                if (termErr instanceof RuntimeError && termErr.code === "RUNTIME_WORKER_TEARDOWN_PENDING") throw termErr;
                throw new RuntimeError("RUNTIME_WORKER_TEARDOWN_PENDING", `ghost worker teardown failed for "${key}": ${termErr instanceof Error ? termErr.message : String(termErr)}`);
              }
              throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
            }
            this.lastMcpIdentity.set(key, { mcpCoordinatorSession: input.mcpCoordinatorSession, mcpSourceHandle: input.mcpSourceHandle });
          } catch (retryError) {
            if (retryError instanceof RuntimeError) throw retryError;
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
        client.lifecycle = "busy";
        const result = await run(client);
        return result;
      } catch (error) {
        if (error instanceof WorkerCrashError) {
          if (client) client.lifecycle = "failed";
        }
        throw toStableRuntimeError(error);
      } finally {
        if (client && client.lifecycle === "busy") {
          client.lifecycle = client.isBootstrapVerified ? "ready" : "starting";
        }
      }
    } finally {
      this.decBusinessOp(key);
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
      try {
        if (this.queueStore && await this.queueStore.hasPending(key)) {
          const latest = this.sessionCatalog.get(key) ?? input;
          if (latest) this.kickDrain(latest).catch(() => {});
        } else if (client && client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready") && !this.hasActiveTurn(key)) {
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
      logicalSessionId: this.workerKey(input),
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
      {
        ...this.buildEnsureParams(input, options),
        workerGeneration: client.ref.generation,
      },
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
    const key = this.workerKey(input);
    const _lifecycleEpochAtEntry = this.deleteGenerations.get(key) ?? 0;
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
    }
    // Mark the turn active IMMEDIATELY so preflight on concurrent policy
    // updates detects the in-flight turn and fails closed (plan §32).
    // Must be before any await so the busy flag is synchronously visible to concurrent updatePermissionPolicy.
    this.incActiveTurn(key);
    this.sessionCatalog.set(key, input);
    // Archive suspend: a direct prompt resumes a suspended durable queue (first post-archive use).
    // G6: persist first, then memory. Fail-closed on persist error.
    try {
      await this.getQueueStore().setSuspended(key, false);
      if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
        throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
      }
      this.queueSuspended.delete(key);
      await this.checkMcpStaleAndRotate(input, true);
      if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
        throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
      }
    } catch (err) {
      this.decActiveTurn(key);
      throw err;
    }
    const _deleteGenAtStart = _lifecycleEpochAtEntry;
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
    this.assertPermissionPlaneHealthy();
    if (this.shuttingDown) throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    const key = this.workerKey(input);
    const _lifecycleEpochAtEntry = this.deleteGenerations.get(key) ?? 0;
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
    }
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
    if (this.deleting.has(key) || (this.deleteGenerations.get(key) ?? 0) !== _lifecycleEpochAtEntry) {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `session "${key}" is being deleted`);
    }
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
    // PR6: cancel is active-turn only — pending queue remains. Do NOT kick drain here;
    // drainLoop and direct prompt's finally will re-kick when appropriate. Kicking from cancel
    // would wake a queue that archive just suspended (suspend must win).
    if (cancelledActive) return { cancelled: true, message: "cancel delivered to runtime worker" };
    if (!client || !client.alive) return { cancelled: false, message: "no active runtime worker for session" };
    return { cancelled: false, message: "cancel delivered to runtime worker" };
  }
  async removeSession(input: EngineSessionInput): Promise<Record<string, never>> {
    // Soft close (CLI `sessions close` parity, proven in runtime-close-parity.test.ts):
    // terminate the warm worker, mark the persistent record closed (history
    // preserved, journal preserved), and verify physical ownership quiesced.
    // Unlike deleteSession this never unlinks record files or the tombstone
    // namespace, and never bumps the delete generation.
    if (this.shuttingDown) throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    const physicalFenceKey = this.physicalFenceKeyForInput(input);
    try {
      await this.waitForAcquiringQuiescence(key);
      const client = this.manager?.get(key);
      const recordId = await this.resolveRecordId(input, client);
      if (client) {
        if (!client.alive && client.lifecycle !== "stopped") {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing soft close`,
          );
        }
        if (client.alive) {
          if (this.hasActiveTurn(key)) {
            await this.waitForNoActiveTurn(key);
          }
          if (this.hasActiveTurn(key)) {
            throw new RuntimeError(
              "RUNTIME_WORKER_TEARDOWN_PENDING",
              `cannot soft close session "${key}" while turn active`,
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
      if (recordId) {
        const sessionFile = join(this.sessionsDir(), `${encodeURIComponent(recordId)}.json`);
        try {
          const content = await readFile(sessionFile, "utf8");
          const record = JSON.parse(content) as Record<string, unknown>;
          record.closed = true;
          record.closed_at = new Date().toISOString();
          delete record.pid;
          const tmp = join(this.sessionsDir(), `.${encodeURIComponent(recordId)}.tmp-${Date.now()}`);
          await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
          await rename(tmp, sessionFile);
        } catch (err) {
          if (!isEnoent(err)) {
            throw new RuntimeError("RUNTIME_INIT_FAILED", `failed to soft-close record "${recordId}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      await this.waitForWorkerQuiescence(key, physicalFenceKey);
      this.clearActiveTurn(key);
      this.coolPending.delete(key);
      this.recordIds.delete(key);
      this.sessionCatalog.delete(key);
      return {};
    } catch (error) {
      throw toStableRuntimeError(error);
    }
  }

  async deleteSession(input: EngineSessionInput): Promise<Record<string, never>> {
    if (this.shuttingDown) throw new RuntimeError("RUNTIME_INIT_FAILED", "runtime engine is shutting down");
    // Admission gate: wait for any in-flight policy transition
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    const physicalFenceKey = this.physicalFenceKeyForInput(input);
    try {
      // PR6: mark deleting so new enqueue is rejected (lifecycle boundary) — inside try so finally always clears
      this.deleting.add(key);
      this.deleteGenerations.set(key, (this.deleteGenerations.get(key) ?? 0) + 1);
      // G4: establishment barrier — prevent old-epoch waiters from starting new acquisitions after bump,
      // and wait for any in-flight acquisitions (fence discharge + spawn) to settle before destructive ops.
      await this.waitForAcquiringQuiescence(key);
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
            // Wait briefly for ghost worker to reach stopped if it's in transitional not-alive state
            if (!refreshed.alive && (refreshed.lifecycle as string) !== "stopped") {
              const start = Date.now();
              while (!refreshed.alive && (refreshed.lifecycle as string) !== "stopped" && Date.now() - start < 500) {
                const { promise, resolve } = Promise.withResolvers<void>();
                setTimeout(resolve, 20);
                await promise;
              }
              if (!refreshed.alive && (refreshed.lifecycle as string) !== "stopped") {
                throw new RuntimeError(
                  "RUNTIME_WORKER_TEARDOWN_PENDING",
                  `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
                );
              }
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
          if (!client.alive && (client.lifecycle as string) !== "stopped") {
            const start2 = Date.now();
            while (!client.alive && (client.lifecycle as string) !== "stopped" && Date.now() - start2 < 500) {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, 20);
              await promise;
            }
            if (!client.alive && (client.lifecycle as string) !== "stopped") {
              throw new RuntimeError(
                "RUNTIME_WORKER_TEARDOWN_PENDING",
                `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
              );
            }
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
        await this.waitForWorkerQuiescence(key, physicalFenceKey);
        this.clearActiveTurn(key);
        this.coolPending.delete(key);
        this.recordIds.delete(key);
        await this.getQueueStore().removeJournal(key);
        this.sessionCatalog.delete(key);
        // Keep deleteGenerations monotonic — do not delete epoch, old waiters must still see generation change
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
      if (!client.alive && (client.lifecycle as string) !== "stopped") {
        const start = Date.now();
        while (!client.alive && (client.lifecycle as string) !== "stopped" && Date.now() - start < 500) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 20);
          await promise;
        }
        if (!client.alive && (client.lifecycle as string) !== "stopped") {
          throw new RuntimeError(
            "RUNTIME_WORKER_TEARDOWN_PENDING",
            `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
          );
        }
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
    // Final G4 ownership quiescence: hard delete success must imply no worker, no acquiring, no fence
    await this.waitForWorkerQuiescence(key, physicalFenceKey);
    this.clearActiveTurn(key);
    this.coolPending.delete(key);

    try {
      await this.deleteRecordFilesStrict(recordId);
      await removeTombstoneStrict(sessionsDir, safeId);
      this.recordIds.delete(key);
      // 6. PR6: only after record deletion verified successful, delete runtime queue journal fail-closed
      await this.getQueueStore().removeJournal(key);
      this.sessionCatalog.delete(key);
      // Keep deleteGenerations monotonic for lifecycle epoch
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
    this.assertPermissionPlaneHealthy();
    await this.acquirePolicyLock();
    try {
      // Global fail-closed preflight (plan §32): an active turn or an
      // in-flight worker acquisition on ANY session races the policy
      // rotation — the transition must not cross that boundary.
      if (this.hasAnyActiveTurn() || this.hasAnyBusinessOp()) {
        throw new RuntimeError(
          "RUNTIME_PERMISSION_BUSY",
          `cannot update permission policy while operations are in flight (fail closed)`,
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
        if (
          (worker.lifecycle !== "idle" && worker.lifecycle !== "ready") ||
          worker.hasInFlight ||
          !worker.isBootstrapVerified
        ) {
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
  /**
   * Fence every worker that may have observed the unpublished new policy:
   * verified-terminate ALL currently live workers, then restore the previous
   * global snapshot. Returns the workers whose teardown could NOT be
   * verified — the caller must poison the permission plane for those.
   * The transition lock is NOT released here (caller owns it).
   */
  private async fenceWorkersOnNewPolicy(
    prev: { permissionMode: PermissionMode; nonInteractivePermissions: NonInteractivePermissions | undefined; permissionPolicy?: string; generation: number },
  ): Promise<RuntimeWorkerClient[]> {
    const targets = this.manager?.workers() ?? [];
    const termResults = await Promise.allSettled(targets.map((w) => w.terminate()));
    const unverified: RuntimeWorkerClient[] = [];
    for (let i = 0; i < targets.length; i++) {
      const w = targets[i]!;
      const tr = termResults[i]!;
      if (tr.status === "fulfilled" && !w.alive && w.lifecycle === "stopped") {
        await this.manager?.release(w.ref.logicalSessionId, w).catch(() => {});
      } else {
        unverified.push(w);
      }
    }
    // Restore the previous global snapshot so nothing subsequently spawned
    // or resolved can observe the unpublished policy. Generation is restored
    // too: every witness is dead (verified above) or fenced by the poison
    // latch below, so no live generation-N+1 observer remains.
    this.options.permissionMode = prev.permissionMode;
    this.options.nonInteractivePermissions = prev.nonInteractivePermissions;
    this.options.permissionPolicy = prev.permissionPolicy;
    this.permissionGeneration = prev.generation;
    return unverified;
  }
  /**
   * Transactional commit: live-update all workers without rotation (PR7).
   * End states: all-ACKed (new policy live everywhere, outer publishes the
   * new config — all-new, never mixed); partially rejected with every
   * rejector verified-terminated (ACKed workers stay warm on the new policy
   * the outer layer publishes — still all-new); or, when a rejector's
   * teardown cannot be verified, all-old globals plus the explicit
   * failed-closed latch (no new turns until restart). The lock is always
   * released before returning or throwing.
   */
  async commitPolicyTransition(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<void> {
    this.assertPermissionPlaneHealthy();
    try {
      if (policy.permissionPolicy !== undefined) {
        const { parseXacpxPermissionPolicy } = await import("./runtime/runtime-permission-policy");
        parseXacpxPermissionPolicy(policy.permissionPolicy);
      }
    } catch (err) {
      this.releasePolicyLock();
      throw new RuntimeError("RUNTIME_INIT_FAILED", `invalid permission policy: ${err instanceof Error ? err.message : String(err)}`);
    }
    const prev = {
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      ...(this.options.permissionPolicy !== undefined ? { permissionPolicy: this.options.permissionPolicy } : {}),
      generation: this.permissionGeneration,
    };
    const nextGeneration = this.permissionGeneration + 1;
    const live = this.manager?.workers() ?? [];
    this.options.permissionMode = policy.permissionMode;
    this.options.nonInteractivePermissions = policy.nonInteractivePermissions;
    this.options.permissionPolicy = policy.permissionPolicy;
    this.permissionGeneration = nextGeneration;
    // Remember the staged snapshot so a later abort (CLI commit failed
    // downstream) can restore exact all-old even after success here.
    this.lastStagedPrevSnapshot = prev;
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
    const failed = live.filter((w, i) => {
      const r = results[i];
      return !(r && r.status === "fulfilled" && (r.value as { accepted?: boolean }).accepted === true);
    });
    if (failed.length === 0) {
      this.releasePolicyLock();
      return;
    }
    // Partial fan-out. An ACKed worker runs the new policy, which stays
    // consistent: the outer layer publishes the new config on success, so
    // the end state is all-new (never mixed). Only workers that REJECTED
    // the update are fenced here. If any of those cannot be
    // verified-terminated, an unverified process may enforce the new policy
    // while everything else must stay old — that forks to the explicit
    // failed-closed latch below (all-old globals + no new turns).
    const termResults = await Promise.allSettled(failed.map((w) => w.terminate()));
    const failedUnverified = failed.filter((w, i) => {
      const tr = termResults[i];
      return !(tr && tr.status === "fulfilled" && !w.alive && w.lifecycle === "stopped");
    });
    for (const w of failed) {
      if (!failedUnverified.includes(w)) {
        await this.manager?.release(w.ref.logicalSessionId, w).catch(() => {});
      }
    }
    if (failedUnverified.length === 0) {
      this.releasePolicyLock();
      return;
    }
    const stillUnverified = await this.fenceWorkersOnNewPolicy(prev);
    this.lastStagedPrevSnapshot = undefined;
    this.releasePolicyLock();
    this.poisonPermissionPlane(
      `policy fan-out failed for ${failed.map((w) => `"${w.ref.logicalSessionId}"`).join(", ")} and teardown is unverified for ${stillUnverified.map((w) => `"${w.ref.logicalSessionId}"`).join(", ")}`,
    );
    throw new RuntimeError(
      "RUNTIME_WORKER_TEARDOWN_PENDING",
      `permission update failed for session(s) ${failed.map((w) => `"${w.ref.logicalSessionId}"`).join(", ")} and worker teardown is unverified; runtime permission plane is failed closed`,
    );
  }
  /**
   * Post-commit abort: the Runtime commit succeeded but a downstream commit
   * (CLI engine) failed, so the new policy must never go live anywhere.
   * Restores the snapshot staged by the last successful commit and fences
   * every live worker (a worker spawned after the commit also inherited the
   * unpublished policy). Unverified teardown poisons the plane. Lock-free:
   * commit already released the lock; abort never re-acquires it.
   */
  private async abortStagedPolicyTransition(): Promise<void> {
    const prev = this.lastStagedPrevSnapshot;
    this.lastStagedPrevSnapshot = undefined;
    if (!prev) return;
    const unverified = await this.fenceWorkersOnNewPolicy(prev);
    if (unverified.length > 0) {
      this.poisonPermissionPlane(
        `post-commit abort left unverified teardown for ${unverified.map((w) => `"${w.ref.logicalSessionId}"`).join(", ")}`,
      );
      throw new RuntimeError(
        "RUNTIME_WORKER_TEARDOWN_PENDING",
        `post-commit abort left unverified worker teardown; runtime permission plane is failed closed`,
      );
    }
  }
  /**
   * Transactional rollback: release the lock without committing when the
   * CLI update fails BEFORE the Runtime commit (legacy no-commit path), or
   * fully abort an already-committed Runtime snapshot (post-commit path).
   * Either way the end state is exact all-old, or — only when a worker
   * teardown cannot be verified — the explicit failed-closed latch.
   */
  async rollbackPolicyTransition(): Promise<void> {
    try {
      await this.abortStagedPolicyTransition();
    } finally {
      this.releasePolicyLock();
    }
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
