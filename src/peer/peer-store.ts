import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PeerRequest } from "./peer-types";

/**
 * Durable peer-request store. Records live in a JSON file next to the
 * daemon's state file (same directory as `state.json`), so a daemon restart
 * never loses the request ↔ receipt correspondence: completion backfill
 * must not depend on in-memory state.
 *
 * All operations are serialized through a promise chain so concurrent
 * approve / watch / complete calls cannot lose each other's writes.
 * Writes go to a temp file + rename, so a crash never leaves a half-written
 * record file behind.
 */
export class PeerStore {
  private readonly queue: { current: Promise<void> } = { current: Promise.resolve() };

  constructor(private readonly filePath: string) {}

  async get(requestId: string): Promise<PeerRequest | null> {
    const records = await this.readAll();
    return records.find((record) => record.requestId === requestId) ?? null;
  }

  async list(): Promise<PeerRequest[]> {
    return await this.readAll();
  }

  async upsert(record: PeerRequest): Promise<PeerRequest> {
    return await this.withLock(async () => {
      const records = await this.readAll();
      const index = records.findIndex((item) => item.requestId === record.requestId);
      if (index >= 0) {
        records[index] = record;
      } else {
        records.push(record);
      }
      await this.writeAll(records);
      return record;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.queue.current;
    this.queue.current = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async readAll(): Promise<PeerRequest[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Peer request store is corrupted and cannot be parsed: ${this.filePath}. ` +
          `To reset peer delegation, move this file aside and retry — all peer records will be lost.`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `Peer request store is corrupted (expected a JSON array of records): ${this.filePath}. ` +
          `To reset peer delegation, move this file aside and retry — all peer records will be lost.`,
      );
    }
    return parsed as PeerRequest[];
  }

  private async writeAll(records: PeerRequest[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(tmpPath, JSON.stringify(records, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }
}
