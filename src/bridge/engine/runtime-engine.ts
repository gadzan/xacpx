import { access, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  private readonly activeTurns = new Set<string>();
  private readonly coolPending = new Set<string>();
  /** Sessions with a worker acquisition (fence discharge + spawn) in flight. */
  private readonly acquiring = new Set<string>();
  private readonly recordIds = new Map<string, string>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleTtlMs: number;
  private policyTransitionLock?: Promise<void>;
  private policyLockRelease?: () => void;
  private permissionGeneration = 0;

  constructor(private readonly options: RuntimeEngineOptions) {
    this.idleTtlMs = options.idleTtlMs ?? (options.queueOwnerTtlSeconds !== undefined ? options.queueOwnerTtlSeconds * 1000 : 60_000);
    const entry = options.workerEntryPath ?? defaultWorkerEntryCandidates().find(fileExists);
    if (entry && fileExists(entry)) {
      this.manager = new RuntimeWorkerManager({
        entryPath: entry,
        clientDeps: options.workerClientDeps,
        // Durable worker-ownership fences (plan §43 / G10): default under the
        // acpx state root, overridable for tests. The supplier form keeps
        // stateDir validation lazy (operation-time, not construction).
        fenceDir: options.fenceDir ?? ((): string => join(this.runtimeStateRoot(), "worker-fences")),
      });
    }
  }

  private workerKey(input: EngineSessionInput): string {
    return input.logicalSessionId ?? input.name;
  }

  private sessionsDir(): string {
    return this.options.stateDir ?? join(resolveAcpxHomeDir(), ".acpx", "sessions");
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
      if (client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready") && !this.activeTurns.has(key)) {
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

  private async ensureWorker(input: EngineSessionInput): Promise<RuntimeWorkerClient> {
    if (!this.manager) {
      throw new WorkerUnavailableError("RuntimeEngine has no worker manager (worker entry not built)");
    }
    // Fence-aware acquire (plan §43 / G10): discharges any undischarged
    // durable ownership fence BEFORE a fresh owner can spawn. The acquire
    // window is tracked so a concurrent policy transition fails closed
    // instead of racing an unregistered worker.
    const key = this.workerKey(input);
    this.acquiring.add(key);
    try {
      return await this.manager.acquire(key);
    } finally {
      this.acquiring.delete(key);
    }
  }
  private async withWorker<T>(input: EngineSessionInput, run: (client: RuntimeWorkerClient) => Promise<T>): Promise<T> {
    // Await in-flight policy transition so prompts don't cross transition boundary
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    const existingTimer = this.idleTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.idleTimers.delete(key);
    }
    let client: RuntimeWorkerClient;
    try {
      client = await this.ensureWorker(input);
    } catch (error) {
      if (error instanceof WorkerTeardownPendingError) {
        throw new RuntimeError(error.code, error.message);
      }
      throw new WorkerUnavailableError(error instanceof Error ? error.message : String(error));
    }
    try {
      const result = await run(client);
      if (client.lifecycle === "starting" && client.isBootstrapVerified) {
        client.lifecycle = "ready";
      }
      return result;
    } catch (error) {
      if (error instanceof WorkerCrashError) {
        this.activeTurns.delete(key);
        client.lifecycle = "failed";
      }
      // Stable error boundary (plan §42/§43): worker-typed failures leave the
      // engine with a stable RuntimeBridgeErrorCode, never a raw typed error
      // that BridgeServer would flatten to BRIDGE_INTERNAL_ERROR.
      throw toStableRuntimeError(error);
    } finally {
      if (client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready") && !this.activeTurns.has(key)) {
        this.scheduleIdleTtl(key, client);
      }
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
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      return {};
    });
    return {};
  }

  async resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }): Promise<Record<string, never>> {
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
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    // Mark the turn active IMMEDIATELY so preflight on concurrent policy
    // updates detects the in-flight turn and fails closed (plan §32).
    this.activeTurns.add(key);
    const toolEventMode = input.toolEventMode ?? (input.toolEvents ? "structured" : "text");
    const renderText = toolEventMode === "text" || toolEventMode === "both";
    const renderStructured = toolEventMode === "structured" || toolEventMode === "both" || input.toolEvents === true;
    const textRenderState = { emittedToolCallIds: new Set<string>() };
    try {
      return await this.withWorker(input, async (client) => {
        client.lifecycle = "busy";
        await this.ensureSessionHandle(input, client);
        try {
          // PR4: forward prompt media as ACP binary attachments (image/audio);
          // non-image files ride along as a text attachment summary (CLI parity).
          const attachments = await buildRuntimeAttachments(input.media);
          const outcome = await client.request<{ result: XacpxTurnResult; finalText: string }>(
            "prompt",
            { text: input.text, ...(attachments.length > 0 ? { attachments } : {}) },
            // forwarded to the bridge sink the moment it arrives.
            {
              onEvent: (payload) => {
                const event = payload as XacpxRuntimeEvent;
                if (!onEvent) return;
                if (event.type === "text_delta") {
                  onEvent(event.stream === "thought"
                    ? { type: "prompt.thought", text: event.text }
                    : { type: "prompt.segment", text: event.text });
                } else if (event.type === "tool_call") {
                  const toolEvent = mapRuntimeToolEvent(event);
                  if (renderStructured) {
                    onEvent({ type: "prompt.tool_event", event: toolEvent });
                  }
                  if (renderText) {
                    const formatted = formatToolUseEventForText(toolEvent, textRenderState);
                    if (formatted) {
                      onEvent({ type: "prompt.segment", text: formatted + "\n" });
                    }
                  }
                } else if (event.type === "status") {
                  // Plan parity gate: upstream flattens plan events to a single
                  // status text (first entry content only). Fabricating entries
                  // would deliver wrong data to channels, so plan is surfaced
                  // as plain text until a public Runtime exposes structured plans.
                  if ((event as { tag?: string }).tag === "plan") {
                    onEvent({ type: "prompt.segment", text: `${event.text}\n` });
                    return;
                  }
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
                    onEvent({ type: "prompt.commands", commands: event.availableCommands.map((c) => ({ name: c.name, description: c.description })) as never });
                  }
                }
              },
            },
          );
          if (outcome.result.status === "cancelled") {
            throw new RuntimeError(
              "RUNTIME_TURN_CANCELLED",
              outcome.result.stopReason || "turn was cancelled",
            );
          }
          if (outcome.result.status === "failed") {
            const err = new Error(outcome.result.error.message);
            if (outcome.result.error.code) {
              (err as { code?: string }).code = outcome.result.error.code;
            }
            const mapped = mapRuntimeError(err);
            throw new RuntimeError(mapped.code, mapped.message);
          }
          return { text: outcome.finalText };
        } finally {
          client.lifecycle = "idle";
        }
      });
    } finally {
      this.activeTurns.delete(key);
      const client = this.manager?.get(key);
      if (client) {
        if (this.coolPending.has(key)) {
          this.coolPending.delete(key);
          await client.terminate().catch((error) => {
            throw toTeardownError(key, error);
          });
          client.lifecycle = "stopped";
          await this.manager?.release(key, client);
        } else if (client.alive && (client.lifecycle === "idle" || client.lifecycle === "ready") && !this.activeTurns.has(key)) {
          this.scheduleIdleTtl(key, client);
        }
      }
    }
  }

  async injectMessage(input: EngineInjectInput): Promise<never> {
    // Queue mode arrives with the durable queue PR (plan PR6); steer stays off
    // until same-turn behavior is proven (plan §25).
    throw new RuntimeError(
      "RUNTIME_ENGINE_UNSUPPORTED",
      `injectMessage mode "${input.mode}" is not supported by the runtime engine yet`,
    );
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
    const client = this.manager?.get(key);
    if (!client || !client.alive) {
      // Cold session: do NOT spawn a worker just to cancel an idle state (plan §24).
      return { cancelled: false, message: "no active runtime worker for session" };
    }
    const result = await client.request<{ cancelled: boolean }>("cancel");
    return { cancelled: result.cancelled === true, message: "cancel delivered to runtime worker" };
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
    // Admission gate: wait for any in-flight policy transition
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    const client = this.manager?.get(key);

    // 1. Resolve REAL record id (plan §19 order). Never fallback to logicalSessionId.
    const recordId = await this.resolveRecordId(input, client);

    // 2. If no record exists on disk or memory, idempotent success (G4).
    if (!recordId) {
      this.recordIds.delete(key);
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

    // 4. Terminate live worker (cancel active turn first, close with discard).
    if (client) {
      if (!client.alive && client.lifecycle !== "stopped") {
        // Dead but unverified owner (crash cleanup failed / never proven): the worker's
        // adapter descendants could not be proven gone — hard delete MUST fail closed
        // instead of silently skipping ownership cleanup (plan §19 / single-owner).
        throw new RuntimeError(
          "RUNTIME_WORKER_TEARDOWN_PENDING",
          `runtime worker for session "${key}" crashed and ownership cleanup was never verified; refusing hard delete`,
        );
      }
      if (client.alive) {
        if (this.activeTurns.has(key)) {
          await client.request("cancel").catch(() => {});
        }
        await client.request("close").catch(() => {});
        await client.terminate().catch((error) => {
          throw toTeardownError(key, error);
        });
        if (client.lifecycle === "stopped") {
          await this.manager?.release(key, client);
        }
      } else {
        // dead + stopped: verified tree cleanup already completed
        this.manager?.deleteWorker(key, client);
      }
    }
    this.activeTurns.delete(key);
    this.coolPending.delete(key);

    try {
      // 5. Strict deletion with post-verification and retry.
      await this.deleteRecordFilesStrict(recordId);
      // Clean up tombstone & memory cache ONLY after all artifacts are verified gone (G4).
      await removeTombstoneStrict(sessionsDir, safeId);
      this.recordIds.delete(key);
    } catch (error) {
      // Deletion did not complete (e.g. stubborn stream file or tombstone unlink failure).
      // Keep memory cache AND tombstone on disk so retries still know recordId!
      throw error;
    }

    return {};
  }

  async freeWarmProcess(input: EngineSessionInput): Promise<Record<string, never>> {
    const key = this.workerKey(input);
    const timer = this.idleTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(key);
    }
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
    if (this.activeTurns.has(key)) {
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
      if (this.activeTurns.size > 0) {
        throw new RuntimeError(
          "RUNTIME_PERMISSION_BUSY",
          `cannot update permission policy while session(s) "${[...this.activeTurns].join(", ")}" have in-flight turns (fail closed)`,
        );
      }
      if (this.acquiring.size > 0) {
        throw new RuntimeError(
          "RUNTIME_PERMISSION_BUSY",
          `cannot update permission policy while worker acquisition(s) for session(s) "${[...this.acquiring].join(", ")}" are in flight (fail closed)`,
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
      // Deliberate termination: rotation does NOT consume crash budget (plan §43)
      await Promise.all(live.map((w) => w.terminate()));
      for (const w of live) {
        if (!w.alive && w.lifecycle === "stopped") {
          await this.manager?.release(w.ref.logicalSessionId, w);
        }
      }
    } catch (error) {
      this.releasePolicyLock();
      throw error;
    }
  }

  /** Transactional commit: snapshot new policy into RuntimeEngine; next spawns use it. */
  async commitPolicyTransition(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<void> {
    try {
      this.options.permissionMode = policy.permissionMode;
      this.options.nonInteractivePermissions = policy.nonInteractivePermissions;
      this.options.permissionPolicy = policy.permissionPolicy;
      this.permissionGeneration++;
    } finally {
      this.releasePolicyLock();
    }
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
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
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
