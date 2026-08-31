import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeError } from "../runtime-engine";

export const RUNTIME_QUEUE_MAX_DEPTH = 20;

export interface RuntimePendingMessage {
  messageId: string;
  text: string;
  acceptedAt: string;
  mode: "queue" | "auto";
}

export interface RuntimeQueueRecord {
  schema: "xacpx.runtime-queue.v1";
  logicalSessionId: string;
  items: RuntimePendingMessage[];
}

export type QueueEnqueueResult = { status: "queued"; modeUsed: "queue"; queueItemId: string };

function queueFilePath(queueDir: string, logicalSessionId: string): string {
  // Use encodeURIComponent for safe filesystem naming, matching other xacpx conventions
  return join(queueDir, `${encodeURIComponent(logicalSessionId)}.json`);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function validateRecord(parsed: unknown, expectedLogicalSessionId?: string): RuntimeQueueRecord {
  if (!parsed || typeof parsed !== "object") throw new Error("queue record is not an object");
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== "xacpx.runtime-queue.v1") throw new Error(`unexpected schema ${String(rec.schema)}`);
  if (typeof rec.logicalSessionId !== "string") throw new Error("missing logicalSessionId");
  if (expectedLogicalSessionId && rec.logicalSessionId !== expectedLogicalSessionId) {
    throw new Error(`logicalSessionId mismatch expected ${expectedLogicalSessionId} got ${rec.logicalSessionId}`);
  }
  if (!Array.isArray(rec.items)) throw new Error("items is not an array");
  for (const item of rec.items as unknown[]) {
    if (!item || typeof item !== "object") throw new Error("queue item is not an object");
    const it = item as Record<string, unknown>;
    if (typeof it.messageId !== "string" || it.messageId.length === 0) throw new Error("invalid messageId");
    if (typeof it.text !== "string") throw new Error("invalid text");
    if (typeof it.acceptedAt !== "string") throw new Error("invalid acceptedAt");
    if (it.mode !== "queue" && it.mode !== "auto") throw new Error(`invalid mode ${String(it.mode)}`);
  }
  return parsed as RuntimeQueueRecord;
}

/**
 * Durable per-logicalSessionId FIFO queue backed by atomic journal files.
 * - Ack only after durable persist (temp -> rename -> readback validate)
 * - Corrupt/unreadable -> fail closed (never treat as empty)
 * - Duplicate messageId semantics: same id+same text => idempotent queued receipt, same id+different text => conflict fail-closed
 * - QUEUE_MAX_DEPTH parity with CLI (20)
 */
export class RuntimeQueueStore {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly queueDir: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.queueDir, { recursive: true });
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(key, prior.then(() => next).catch(() => next));
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) {
        // Keep the chain but allow GC when no waiters; we already released, next will resolve.
        // Remove if no further waiters chained behind.
        setTimeout(() => {
          if (this.locks.get(key) === next) this.locks.delete(key);
        }, 0);
      }
    }
  }

  async load(logicalSessionId: string): Promise<RuntimeQueueRecord | undefined> {
    const file = queueFilePath(this.queueDir, logicalSessionId);
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (err) {
      if (isEnoent(err)) return undefined;
      throw new RuntimeError("RUNTIME_INIT_FAILED", `cannot read runtime queue journal for "${logicalSessionId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `corrupt runtime queue journal for "${logicalSessionId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      return validateRecord(parsed, logicalSessionId);
    } catch (err) {
      throw new RuntimeError("RUNTIME_INIT_FAILED", `invalid runtime queue journal for "${logicalSessionId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async save(record: RuntimeQueueRecord): Promise<void> {
    await this.ensureDir();
    const target = queueFilePath(this.queueDir, record.logicalSessionId);
    const tmp = join(this.queueDir, `.${encodeURIComponent(record.logicalSessionId)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    try {
      await writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
      await rename(tmp, target);
      const verify = await readFile(target, "utf8");
      const parsed = JSON.parse(verify) as RuntimeQueueRecord;
      validateRecord(parsed, record.logicalSessionId);
      if (parsed.items.length !== record.items.length) {
        throw new Error("queue verify length mismatch");
      }
    } catch (err) {
      try { await unlink(tmp); } catch {}
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError("RUNTIME_INIT_FAILED", `failed to persist runtime queue journal for "${record.logicalSessionId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async enqueue(logicalSessionId: string, input: { messageId: string; text: string; mode: "queue" | "auto" }): Promise<QueueEnqueueResult> {
    if (!input.messageId || typeof input.messageId !== "string") {
      throw new RuntimeError("RUNTIME_QUEUE_CONFLICT", "messageId must be a non-empty string");
    }
    return this.withLock(logicalSessionId, async () => {
      const existing = await this.load(logicalSessionId);
      const items = existing?.items ?? [];
      const dup = items.find((it) => it.messageId === input.messageId);
      if (dup) {
        if (dup.text === input.text) {
          // Idempotent: same id+same payload => return existing receipt without duplicate append
          return { status: "queued", modeUsed: "queue", queueItemId: dup.messageId };
        }
        throw new RuntimeError("RUNTIME_QUEUE_CONFLICT", `duplicate messageId "${input.messageId}" with conflicting payload`);
      }
      if (items.length >= RUNTIME_QUEUE_MAX_DEPTH) {
        throw new RuntimeError("RUNTIME_QUEUE_OVERFLOW", `runtime queue for "${logicalSessionId}" is full (${RUNTIME_QUEUE_MAX_DEPTH})`);
      }
      const next: RuntimePendingMessage = {
        messageId: input.messageId,
        text: input.text,
        acceptedAt: new Date().toISOString(),
        mode: input.mode,
      };
      const record: RuntimeQueueRecord = {
        schema: "xacpx.runtime-queue.v1",
        logicalSessionId,
        items: [...items, next],
      };
      await this.save(record);
      return { status: "queued", modeUsed: "queue", queueItemId: next.messageId };
    });
  }

  async dequeueHead(logicalSessionId: string): Promise<RuntimePendingMessage | undefined> {
    return this.withLock(logicalSessionId, async () => {
      const rec = await this.load(logicalSessionId);
      if (!rec || rec.items.length === 0) return undefined;
      const [head, ...rest] = rec.items;
      if (rest.length === 0) {
        // Remove file when empty to avoid stale empty journals
        const file = queueFilePath(this.queueDir, logicalSessionId);
        try { await unlink(file); } catch (err) { if (!isEnoent(err)) throw new RuntimeError("RUNTIME_INIT_FAILED", `failed to remove empty queue journal for "${logicalSessionId}": ${err instanceof Error ? err.message : String(err)}`); }
        // Verify gone
        try { await access(file); throw new RuntimeError("RUNTIME_INIT_FAILED", `queue journal still exists after dequeue for "${logicalSessionId}"`); } catch (err) { if (!isEnoent(err)) throw err; }
      } else {
        await this.save({ schema: "xacpx.runtime-queue.v1", logicalSessionId, items: rest });
      }
      return head;
    });
  }

  async peek(logicalSessionId: string): Promise<RuntimePendingMessage | undefined> {
    const rec = await this.load(logicalSessionId);
    return rec?.items[0];
  }

  async hasPending(logicalSessionId: string): Promise<boolean> {
    const rec = await this.load(logicalSessionId);
    return !!rec && rec.items.length > 0;
  }

  async queueLength(logicalSessionId: string): Promise<number> {
    const rec = await this.load(logicalSessionId);
    return rec ? rec.items.length : 0;
  }

  async removeJournal(logicalSessionId: string): Promise<void> {
    const file = queueFilePath(this.queueDir, logicalSessionId);
    try { await unlink(file); } catch (err) { if (!isEnoent(err)) throw new RuntimeError("RUNTIME_INIT_FAILED", `failed to remove runtime queue journal for "${logicalSessionId}": ${err instanceof Error ? err.message : String(err)}`); }
    try { await access(file); throw new RuntimeError("RUNTIME_INIT_FAILED", `queue journal still exists after remove for "${logicalSessionId}"`); } catch (err) { if (!isEnoent(err)) throw err; }
  }

  async listLogicalSessionIds(): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.queueDir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw new RuntimeError("RUNTIME_INIT_FAILED", `cannot read queue dir "${this.queueDir}": ${err instanceof Error ? err.message : String(err)}`);
    }
    return files
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => decodeURIComponent(f.slice(0, -".json".length)));
  }

  async getQueueDir(): Promise<string> { return this.queueDir; }
}
