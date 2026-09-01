import type { DiscordInboundMessage } from "./types.js";

export interface DiscordAttachmentInfo {
  url: string;
  name?: string;
  contentType?: string | null;
  size?: number;
}

export function inferMediaKind(contentType: string | null | undefined, fileName: string | undefined): "image" | "file" | "audio" | "video" {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  const ext = (fileName ?? "").toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "opus", "m4a", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "avi", "webm", "mkv"].includes(ext)) return "video";
  return "file";
}

export function extractDiscordAttachments(message: DiscordInboundMessage): DiscordAttachmentInfo[] {
  if (!message.attachments || message.attachments.length === 0) return [];
  return message.attachments.map((a) => ({
    url: a.url,
    name: a.name,
    contentType: a.contentType ?? null,
    size: a.size,
  }));
}

export interface DownloadDiscordAttachmentInput {
  url: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}

export interface DownloadedAttachment {
  buffer: Buffer;
  contentType: string;
  fileName?: string;
}

export async function downloadDiscordAttachment(input: DownloadDiscordAttachmentInput): Promise<DownloadedAttachment> {
  const fetchFn = input.fetchImpl ?? fetch;
  const res = await fetchFn(input.url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isFinite(len) && len > input.maxBytes) {
      throw new Error(`attachment exceeds ${input.maxBytes} bytes`);
    }
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  let fileName: string | undefined;
  const disposition = res.headers.get("content-disposition");
  if (disposition) {
    const m = /filename="?([^"]+)"?/.exec(disposition);
    if (m?.[1]) fileName = m[1];
  }
  if (!fileName) {
    try {
      const u = new URL(input.url);
      const base = u.pathname.split("/").pop();
      if (base) fileName = decodeURIComponent(base);
    } catch {
      // ignore
    }
  }

  // Stream with incremental size check (spec §12): fail fast before buffering whole file.
  const body = (res as unknown as { body?: ReadableStream<Uint8Array> | null }).body ?? null;
  if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > input.maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            throw new Error(`attachment exceeds ${input.maxBytes} bytes`);
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return {
      buffer,
      contentType,
      ...(fileName ? { fileName } : {}),
    };
  }

  const ab = await res.arrayBuffer();
  if (ab.byteLength > input.maxBytes) {
    throw new Error(`attachment exceeds ${input.maxBytes} bytes`);
  }
  return {
    buffer: Buffer.from(ab),
    contentType,
    ...(fileName ? { fileName } : {}),
  };
}
