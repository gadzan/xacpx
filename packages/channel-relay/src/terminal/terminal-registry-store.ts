import { openSync, closeSync, fsyncSync, writeSync, constants as fsConstants } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  TerminalOwnerFileV1,
  TerminalRecordV1,
  TerminalReapReason,
  TerminalRegistryFileV1,
} from "./terminal-types.js";

const OWNER_FILE = "terminal-owner.json";
const REGISTRY_FILE = "terminals.json";
const LOCK_FILE = "terminals.lock";
const FILE_MODE = 0o600;

export class TerminalRegistryRevisionMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(`terminal registry revision mismatch: expected ${expected}, actual ${actual}`);
    this.name = "TerminalRegistryRevisionMismatchError";
  }
}

export class TerminalRegistryInventoryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalRegistryInventoryUncertainError";
  }
}

export class TerminalRegistryNotLoadedError extends Error {
  constructor() {
    super("TerminalRegistryStore.getSnapshot() called before load()");
    this.name = "TerminalRegistryNotLoadedError";
  }
}

export class TerminalRegistryLockedError extends Error {
  readonly pid: number;
  constructor(pid: number) {
    super(pid > 0
      ? `terminal registry is locked by pid ${pid}`
      : "terminal registry is locked by another writer");
    this.name = "TerminalRegistryLockedError";
    this.pid = pid;
  }
}

export interface TerminalRegistrySnapshot {
  installationId: string;
  revision: number;
  terminals: Readonly<Record<string, TerminalRecordV1>>;
  inventoryUncertain: boolean;
}

export interface TerminalRegistryDraft {
  terminals: Record<string, TerminalRecordV1>;
}

export interface UpsertCreatingInput {
  terminalId: string;
  logicalSessionId: string;
  internalAliasSnapshot: string;
  rmuxSessionName: string;
  generation: string;
  createdAt?: string;
  lastInputAt?: string;
}

export interface TerminalRegistryFsDeps {
  mkdir?: (path: string, options?: { recursive?: boolean }) => Promise<string | undefined>;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  writeFile?: (path: string, data: string, options: { encoding: "utf8"; mode: number }) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  fsync?: (fd: number) => Promise<void>;
  /** Exclusive create for owner bootstrap (O_EXCL). Returns true if this call created the file. */
  writeFileExclusive?: (path: string, data: string, mode: number) => Promise<boolean>;
  unlink?: (path: string) => Promise<void>;
  randomUUID?: () => string;
  now?: () => Date;
  pid?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

export interface TerminalRegistryStoreOptions {
  /** Directory holding terminal-owner.json and terminals.json. */
  dir: string;
  deps?: TerminalRegistryFsDeps;
  /**
   * When true, `load()` takes an exclusive pid lock on `terminals.lock`.
   * Production writers (live runtime, one-shot retirement) must set this;
   * unit tests default to false so they can share a temp dir without a lock.
   */
  exclusiveWriter?: boolean;
}

type LoadedState = {
  installationId: string;
  revision: number;
  terminals: Record<string, TerminalRecordV1>;
  inventoryUncertain: boolean;
};

function defaultWriteFileExclusive(path: string, data: string, mode: number): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    writeSync(fd, data, undefined, "utf8");
    fsyncSync(fd);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: process exists but we cannot signal it. Treat as alive so we
    // never steal a live writer's lock.
    return code === "EPERM";
  }
}

function parseLockPid(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function cloneTerminals(terminals: Record<string, TerminalRecordV1>): Record<string, TerminalRecordV1> {
  const out: Record<string, TerminalRecordV1> = {};
  for (const [id, rec] of Object.entries(terminals)) {
    out[id] = { ...rec };
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOwner(raw: string): TerminalOwnerFileV1 | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.installationId !== "string" || parsed.installationId.length === 0) return null;
    return { schemaVersion: 1, installationId: parsed.installationId };
  } catch {
    return null;
  }
}

function parseRegistry(raw: string): TerminalRegistryFileV1 | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== 1) return null;
    if (typeof parsed.revision !== "number" || !Number.isInteger(parsed.revision) || parsed.revision < 0) {
      return null;
    }
    if (!isRecord(parsed.terminals)) return null;
    const terminals: Record<string, TerminalRecordV1> = {};
    for (const [key, value] of Object.entries(parsed.terminals)) {
      if (!isValidRecord(value) || value.terminalId !== key) return null;
      terminals[key] = value;
    }
    return { schemaVersion: 1, revision: parsed.revision, terminals };
  } catch {
    return null;
  }
}

function isValidRecord(value: unknown): value is TerminalRecordV1 {
  if (!isRecord(value)) return false;
  const states = new Set(["creating", "live", "reaping"]);
  return typeof value.terminalId === "string"
    && typeof value.logicalSessionId === "string"
    && typeof value.internalAliasSnapshot === "string"
    && typeof value.rmuxSessionName === "string"
    && (value.rmuxSessionId === undefined || typeof value.rmuxSessionId === "string")
    && typeof value.generation === "string"
    && typeof value.state === "string"
    && states.has(value.state)
    && typeof value.createdAt === "string"
    && typeof value.lastInputAt === "string"
    && (value.reapReason === undefined || typeof value.reapReason === "string");
}

/**
 * Durable owner + terminal resource registry.
 *
 * Write contract (spec §10.2): mutations are serialized; each mutation builds a
 * copy-on-write snapshot, writes a unique same-dir temp with mode 0600, fsyncs,
 * atomically renames, then publishes the in-memory snapshot. Failures leave
 * memory unchanged. Reconciler must use revision-fenced mutate/helpers — never
 * poke internal maps.
 */
export class TerminalRegistryStore {
  private readonly dir: string;
  private readonly deps: Required<TerminalRegistryFsDeps>;
  private readonly exclusiveWriter: boolean;
  private state: LoadedState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lockHeld = false;

  constructor(options: TerminalRegistryStoreOptions) {
    this.dir = options.dir;
    this.exclusiveWriter = options.exclusiveWriter === true;
    const d = options.deps ?? {};
    this.deps = {
      mkdir: d.mkdir ?? ((p, o) => mkdir(p, o)),
      readFile: d.readFile ?? ((p, enc) => readFile(p, enc)),
      writeFile: d.writeFile ?? ((p, data, o) => writeFile(p, data, o)),
      rename: d.rename ?? ((from, to) => rename(from, to)),
      chmod: d.chmod ?? ((p, mode) => chmod(p, mode)),
      fsync: d.fsync ?? (async (fd) => {
        fsyncSync(fd);
      }),
      writeFileExclusive: d.writeFileExclusive
        ?? (async (p, data, mode) => defaultWriteFileExclusive(p, data, mode)),
      unlink: d.unlink ?? ((p) => unlink(p)),
      randomUUID: d.randomUUID ?? (() => randomUUID()),
      now: d.now ?? (() => new Date()),
      pid: d.pid ?? (() => process.pid),
      isPidAlive: d.isPidAlive ?? defaultIsPidAlive,
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async load(): Promise<TerminalRegistrySnapshot> {
    return this.enqueue(() => this.loadUnlocked());
  }

  /** Release `terminals.lock` if this instance acquired it. Safe to call twice. */
  async close(): Promise<void> {
    return this.enqueue(() => this.releaseWriterLock());
  }

  getSnapshot(): TerminalRegistrySnapshot {
    if (!this.state) throw new TerminalRegistryNotLoadedError();
    return this.publishSnapshot(this.state);
  }

  async mutate(
    expectedRevision: number,
    fn: (draft: TerminalRegistryDraft) => void,
  ): Promise<{ revision: number }> {
    return this.enqueue(() => this.mutateUnlocked(expectedRevision, fn));
  }

  /**
   * Apply a mutation against the latest in-memory revision inside the
   * serialization queue. Preferred for runtime paths: per-terminal locks do
   * not serialize the global registry revision, so callers must not CAS on a
   * stale snapshot taken outside the queue.
   */
  async apply(fn: (draft: TerminalRegistryDraft) => void): Promise<{ revision: number }> {
    return this.enqueue(() => this.applyUnlocked(fn));
  }

  async upsertCreating(input: UpsertCreatingInput): Promise<{ revision: number }> {
    const nowIso = this.deps.now().toISOString();
    return this.apply((draft) => {
      draft.terminals[input.terminalId] = {
        terminalId: input.terminalId,
        logicalSessionId: input.logicalSessionId,
        internalAliasSnapshot: input.internalAliasSnapshot,
        rmuxSessionName: input.rmuxSessionName,
        generation: input.generation,
        state: "creating",
        createdAt: input.createdAt ?? nowIso,
        lastInputAt: input.lastInputAt ?? nowIso,
      };
    });
  }

  async markLive(
    terminalId: string,
    extras?: { rmuxSessionId?: string },
  ): Promise<{ revision: number }> {
    return this.apply((draft) => {
      const rec = draft.terminals[terminalId];
      if (!rec) throw new Error(`unknown terminalId: ${terminalId}`);
      if (rec.state === "reaping") {
        throw new Error(`terminal already reaping: ${terminalId}`);
      }
      draft.terminals[terminalId] = {
        ...rec,
        state: "live",
        ...(extras?.rmuxSessionId !== undefined ? { rmuxSessionId: extras.rmuxSessionId } : {}),
      };
    });
  }

  async markReaping(terminalId: string, reason: TerminalReapReason): Promise<{ revision: number }> {
    return this.apply((draft) => {
      const rec = draft.terminals[terminalId];
      if (!rec) throw new Error(`unknown terminalId: ${terminalId}`);
      draft.terminals[terminalId] = {
        ...rec,
        state: "reaping",
        reapReason: reason,
      };
    });
  }

  async remove(terminalId: string): Promise<{ revision: number }> {
    return this.apply((draft) => {
      delete draft.terminals[terminalId];
    });
  }

  async checkpointLastInputAt(
    terminalId: string,
    lastInputAt?: string,
  ): Promise<{ revision: number }> {
    const stamp = lastInputAt ?? this.deps.now().toISOString();
    return this.apply((draft) => {
      const rec = draft.terminals[terminalId];
      if (!rec) throw new Error(`unknown terminalId: ${terminalId}`);
      draft.terminals[terminalId] = { ...rec, lastInputAt: stamp };
    });
  }

  private publishSnapshot(state: LoadedState): TerminalRegistrySnapshot {
    return {
      installationId: state.installationId,
      revision: state.revision,
      terminals: cloneTerminals(state.terminals),
      inventoryUncertain: state.inventoryUncertain,
    };
  }

  private async loadUnlocked(): Promise<TerminalRegistrySnapshot> {
    await this.deps.mkdir(this.dir, { recursive: true });
    await this.acquireWriterLock();

    const ownerPath = join(this.dir, OWNER_FILE);
    const registryPath = join(this.dir, REGISTRY_FILE);

    const registryRead = await this.tryRead(registryPath);
    const ownerRead = await this.tryRead(ownerPath);

    // Classify registry presence/emptiness/corruption before deciding owner policy.
    let registryParsed: TerminalRegistryFileV1 | null = null;
    let registryCorrupt = false;
    let registryNonEmpty = false;

    if (registryRead === null) {
      // Fresh install path when owner is also missing.
    } else if (registryRead.trim() === "") {
      registryCorrupt = true;
    } else {
      registryParsed = parseRegistry(registryRead);
      if (!registryParsed) {
        registryCorrupt = true;
      } else if (Object.keys(registryParsed.terminals).length > 0) {
        registryNonEmpty = true;
      }
    }

    const ownerParsed = ownerRead === null ? null : parseOwner(ownerRead);
    const ownerMissingOrCorrupt = ownerRead === null || ownerParsed === null;

    // Fail closed: cannot mint a new owner namespace when cleanup evidence exists
    // (non-empty registry) or when the registry itself is corrupt/unreadable as
    // a non-empty evidence file (empty/garbage file with no owner).
    if (ownerMissingOrCorrupt && (registryNonEmpty || (registryCorrupt && registryRead !== null))) {
      throw new TerminalRegistryInventoryUncertainError(
        "terminal owner missing/corrupt while registry evidence is present; refusing to mint a new installationId",
      );
    }

    let installationId: string;
    if (ownerParsed) {
      installationId = ownerParsed.installationId;
    } else {
      // Fresh install (no registry / empty valid registry): create owner exclusively.
      installationId = await this.ensureOwnerExclusive(ownerPath);
    }

    let inventoryUncertain = false;
    let revision = 0;
    let terminals: Record<string, TerminalRecordV1> = {};

    if (registryCorrupt) {
      inventoryUncertain = true;
      await this.bestEffortCorruptBackup(registryPath);
      // Do not pretend the registry was empty — leave terminals empty in memory
      // but flag inventoryUncertain so reconciler stays fail-closed.
    } else if (registryParsed) {
      revision = registryParsed.revision;
      terminals = cloneTerminals(registryParsed.terminals);
    }
    // registryAbsent: keep revision 0 / empty terminals (fresh install).

    this.state = {
      installationId,
      revision,
      terminals,
      inventoryUncertain,
    };
    return this.publishSnapshot(this.state);
  }

  private async ensureOwnerExclusive(ownerPath: string): Promise<string> {
    // Race-safe: try exclusive create; if another process won, read their ID.
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = this.deps.randomUUID();
      const payload = JSON.stringify(
        { schemaVersion: 1, installationId: candidate } satisfies TerminalOwnerFileV1,
        null,
        2,
      );
      const created = await this.deps.writeFileExclusive(ownerPath, payload, FILE_MODE);
      if (created) {
        try {
          await this.deps.chmod(ownerPath, FILE_MODE);
        } catch {
          // best-effort
        }
        return candidate;
      }
      const existing = await this.tryRead(ownerPath);
      if (existing !== null) {
        const parsed = parseOwner(existing);
        if (parsed) return parsed.installationId;
      }
      // Brief yield then retry if the winner's write is still in flight / corrupt mid-write.
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
    }
    throw new TerminalRegistryInventoryUncertainError(
      "failed to create or read terminal-owner.json after concurrent startup races",
    );
  }

  private async bestEffortCorruptBackup(registryPath: string): Promise<void> {
    const stamp = this.deps.now().getTime();
    const backupPath = `${registryPath}.corrupt-${stamp}`;
    try {
      await this.deps.rename(registryPath, backupPath);
    } catch {
      // Best-effort: leave original in place; inventoryUncertain still set by caller.
    }
  }

  private async mutateUnlocked(
    expectedRevision: number,
    fn: (draft: TerminalRegistryDraft) => void,
  ): Promise<{ revision: number }> {
    if (!this.state) throw new TerminalRegistryNotLoadedError();
    if (this.state.revision !== expectedRevision) {
      throw new TerminalRegistryRevisionMismatchError(expectedRevision, this.state.revision);
    }
    return this.applyUnlocked(fn);
  }

  private async applyUnlocked(
    fn: (draft: TerminalRegistryDraft) => void,
  ): Promise<{ revision: number }> {
    if (!this.state) throw new TerminalRegistryNotLoadedError();

    const draftTerminals = cloneTerminals(this.state.terminals);
    fn({ terminals: draftTerminals });

    const nextRevision = this.state.revision + 1;
    const nextFile: TerminalRegistryFileV1 = {
      schemaVersion: 1,
      revision: nextRevision,
      terminals: draftTerminals,
    };

    await this.atomicWriteRegistry(nextFile);

    this.state = {
      installationId: this.state.installationId,
      revision: nextRevision,
      terminals: draftTerminals,
      inventoryUncertain: this.state.inventoryUncertain,
    };
    return { revision: nextRevision };
  }

  private async atomicWriteRegistry(file: TerminalRegistryFileV1): Promise<void> {
    await this.deps.mkdir(this.dir, { recursive: true });
    const target = join(this.dir, REGISTRY_FILE);
    const tmp = join(this.dir, `${REGISTRY_FILE}.tmp-${this.deps.randomUUID()}`);
    const payload = JSON.stringify(file, null, 2);

    try {
      await this.deps.writeFile(tmp, payload, { encoding: "utf8", mode: FILE_MODE });
      try {
        await this.deps.chmod(tmp, FILE_MODE);
      } catch {
        // best-effort; mode was already requested at write
      }
      await this.fsyncPath(tmp);
      await this.deps.rename(tmp, target);
      try {
        await this.deps.chmod(target, FILE_MODE);
      } catch {
        // best-effort
      }
    } catch (err) {
      try {
        await this.deps.unlink(tmp);
      } catch {
        // ignore cleanup failure
      }
      throw err;
    }
  }

  private async fsyncPath(path: string): Promise<void> {
    // Prefer injectable fsync; open the temp file to get an fd when using defaults.
    const handle = await open(path, "r+");
    try {
      await this.deps.fsync(handle.fd);
    } finally {
      await handle.close();
    }
  }

  private async acquireWriterLock(): Promise<void> {
    if (!this.exclusiveWriter || this.lockHeld) return;
    const lockPath = join(this.dir, LOCK_FILE);
    const pid = this.deps.pid();
    for (let attempt = 0; attempt < 8; attempt++) {
      const created = await this.deps.writeFileExclusive(lockPath, `${pid}\n`, FILE_MODE);
      if (created) {
        this.lockHeld = true;
        return;
      }
      const existing = await this.tryRead(lockPath);
      const existingPid = existing === null ? null : parseLockPid(existing);
      if (existingPid !== null && this.deps.isPidAlive(existingPid)) {
        throw new TerminalRegistryLockedError(existingPid);
      }
      try {
        await this.deps.unlink(lockPath);
      } catch {
        // Lost the steal race; retry exclusive create.
      }
    }
    throw new TerminalRegistryLockedError(0);
  }

  private async releaseWriterLock(): Promise<void> {
    if (!this.lockHeld) return;
    const lockPath = join(this.dir, LOCK_FILE);
    try {
      const existing = await this.tryRead(lockPath);
      const existingPid = existing === null ? null : parseLockPid(existing);
      if (existingPid === this.deps.pid()) {
        await this.deps.unlink(lockPath);
      }
    } catch {
      // best-effort; do not throw from close()
    }
    this.lockHeld = false;
  }

  private async tryRead(path: string): Promise<string | null> {
    try {
      return await this.deps.readFile(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw err;
    }
  }
}
