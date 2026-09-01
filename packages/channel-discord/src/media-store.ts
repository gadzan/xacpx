import { access, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChannelId, ChannelMediaAttachment, ChannelMediaKind } from "./media-types.js";

export const DEFAULT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const DEFAULT_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RuntimeMediaStoreOptions {
  rootDir: string;
  retentionMs?: number;
}

export interface SaveMediaBufferInput {
  channelId: ChannelId;
  accountId: string;
  chatKey: string;
  messageId: string;
  fileName?: string;
  mimeType: string;
  kind: ChannelMediaKind;
  buffer: Buffer;
  sourceResourceId?: string;
  maxBytes: number;
}

export class RuntimeMediaStore {
  readonly rootDir: string;
  readonly retentionMs: number;

  constructor(options: RuntimeMediaStoreOptions) {
    this.rootDir = options.rootDir;
    this.retentionMs = options.retentionMs ?? DEFAULT_MEDIA_RETENTION_MS;
  }

  async saveMediaBuffer(input: SaveMediaBufferInput): Promise<ChannelMediaAttachment> {
    if (input.buffer.byteLength > input.maxBytes) {
      throw new Error(`media exceeds ${input.maxBytes} bytes`);
    }

    const safeChatKey = safePathSegment(input.chatKey);
    const safeMessageId = safePathSegment(input.messageId || "message");
    const baseFileName = sanitizeMediaFileName(input.fileName ?? "attachment", input.mimeType);
    const dir = path.join(this.rootDir, input.channelId, safeChatKey, safeMessageId);
    await mkdir(dir, { recursive: true });

    const resolvedRoot = path.resolve(this.rootDir);
    const resolvedFile = path.resolve(path.join(dir, await uniqueFileName(dir, baseFileName)));
    if (!isPathInside(resolvedFile, resolvedRoot)) {
      throw new Error("media path escapes runtime media root");
    }

    await writeFile(resolvedFile, input.buffer);

    return {
      kind: input.kind,
      filePath: resolvedFile,
      mimeType: input.mimeType,
      fileName: path.basename(resolvedFile),
      sizeBytes: input.buffer.byteLength,
      source: {
        channelId: input.channelId,
        accountId: input.accountId,
        chatKey: input.chatKey,
        messageId: input.messageId,
        ...(input.sourceResourceId ? { resourceId: input.sourceResourceId } : {}),
      },
    };
  }

  async cleanupExpired(now: Date = new Date()): Promise<void> {
    await cleanupDir(this.rootDir, now.getTime() - this.retentionMs);
  }
}

export function sanitizeMediaFileName(fileName: string, mimeType: string): string {
  const base = path.basename(fileName.trim() || "attachment");
  const replaced = base.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  const safe = replaced || "attachment";
  const ext = path.extname(safe);
  if (ext) return safe;
  return `${safe}${extensionFromMime(mimeType)}`;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "unknown";
}

async function uniqueFileName(dir: string, baseName: string): Promise<string> {
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let candidate = baseName;
  let counter = 2;
  while (true) {
    try {
      await access(path.join(dir, candidate));
      candidate = `${stem}-${counter}${ext}`;
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "audio/wav") return ".wav";
  if (normalized === "audio/ogg" || normalized === "audio/opus") return ".opus";
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "text/plain") return ".txt";
  return ".bin";
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function cleanupDir(dir: string, cutoffMs: number): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }

  let empty = true;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const childEmpty = await cleanupDir(full, cutoffMs);
      if (childEmpty) {
        await rm(full, { recursive: true, force: true });
      } else {
        empty = false;
      }
      continue;
    }

    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.mtimeMs < cutoffMs) {
      await rm(full, { force: true });
    } else {
      empty = false;
    }
  }
  return empty;
}
