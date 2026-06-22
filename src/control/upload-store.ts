import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { coreHomeDir } from "../runtime/core-home.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface UploadStoreOptions {
  rootDir?: string;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => Date;
}

export interface SavedUpload {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

function defaultRootDir(): string {
  const home = process.env.HOME ?? homedir();
  return path.join(coreHomeDir(home), "runtime", "uploads");
}

/** Strip directory components and traversal segments, leaving a safe basename. */
export function sanitizeUploadFilename(raw: string): string {
  const base = path.basename(raw).replace(/[/\\]/g, "").replace(/^\.+/, "");
  const cleaned = base.trim();
  return cleaned.length > 0 ? cleaned : "file";
}

export class UploadStore {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(opts: UploadStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultRootDir();
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? (() => new Date());
  }

  /** Sandbox root all uploads are written under. Callers may use this to verify a
   *  media filePath actually originated from a control.upload (defense-in-depth). */
  get root(): string {
    return this.rootDir;
  }

  async save(filename: string, base64: string, mimeType: string): Promise<SavedUpload> {
    // Pre-decode size guard: a base64 string encodes ceil(n/3)*4 chars per n bytes,
    // so reject obvious oversized payloads before materializing them into memory.
    if (base64.length > Math.ceil((this.maxBytes * 4) / 3) + 4) throw new Error("file-too-large");

    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0) throw new Error("empty-file");
    if (bytes.byteLength > this.maxBytes) throw new Error("file-too-large");

    const safeName = sanitizeUploadFilename(filename);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.rootDir, { recursive: true });
    const dir = await mkdtemp(path.join(this.rootDir, "u-"));
    const filePath = path.join(dir, safeName);
    await writeFile(filePath, bytes);

    return {
      id: path.basename(dir),
      path: filePath,
      filename: safeName,
      mimeType,
      size: bytes.byteLength,
    };
  }

  /** Remove upload dirs whose mtime is older than the TTL. Returns count removed. */
  async cleanup(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return 0;
    }
    const cutoff = this.now().getTime() - this.ttlMs;
    let removed = 0;
    for (const name of entries) {
      const dir = path.join(this.rootDir, name);
      try {
        const info = await stat(dir);
        if (info.mtimeMs < cutoff) {
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // ignore races
      }
    }
    return removed;
  }
}
