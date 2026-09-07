import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir as defaultTmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PromptMedia, PromptMediaInput } from "./types";

type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: { uri: string; text: string } };

const MAX_STRUCTURED_IMAGE_BYTES = 100 * 1024 * 1024;

export interface StructuredPromptFile {
  filePath: string;
  cleanup: () => Promise<void>;
}

export interface StructuredPromptFileDeps {
  readImageFile: (filePath: string, maxBytes: number) => Promise<Buffer>;
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (filePath: string, data: string, encoding: BufferEncoding) => Promise<void>;
  rm: (filePath: string, options: { recursive: true; force: true }) => Promise<void>;
  tmpdir: () => string;
}

export async function createStructuredPromptFile(
  text: string,
  media?: PromptMediaInput,
  deps: StructuredPromptFileDeps = defaultStructuredPromptFileDeps,
): Promise<StructuredPromptFile | null> {
  const mediaList = normalizePromptMedia(media);
  if (mediaList.length === 0) {
    return null;
  }

  const blocks: AcpContentBlock[] = [];
  if (text.trim().length > 0) {
    blocks.push({ type: "text", text });
  }

  const nonImages = mediaList.filter((item) => item.type !== "image");
  if (nonImages.length > 0) {
    blocks.push({ type: "text", text: buildAttachmentSummary(nonImages) });
  }

  for (const item of mediaList) {
    if (item.type === "image") {
      const imageData = await deps.readImageFile(item.filePath, MAX_STRUCTURED_IMAGE_BYTES);
      if (imageData.byteLength === 0) throw new Error("image prompt must not be empty");
      if (imageData.byteLength > MAX_STRUCTURED_IMAGE_BYTES) {
        throw new Error(`image prompt exceeds ${MAX_STRUCTURED_IMAGE_BYTES} bytes`);
      }
      blocks.push({
        type: "image",
        mimeType: resolveImageMimeType(imageData, item.mimeType),
        data: imageData.toString("base64"),
      });
      continue;
    }

    blocks.push({
      type: "resource",
      resource: {
        uri: pathToFileURL(item.filePath).toString(),
        text: `${item.fileName ?? path.basename(item.filePath)} ${item.mimeType} ${item.type}`,
      },
    });
  }

  return await writeStructuredPromptBlocks(blocks, deps);
}

function normalizePromptMedia(media?: PromptMediaInput): PromptMedia[] {
  if (!media) return [];
  return Array.isArray(media) ? media : [media];
}

function buildAttachmentSummary(items: PromptMedia[]): string {
  const lines = ["Attachments available as local files:"];
  for (const [index, item] of items.entries()) {
    lines.push(`${index + 1}. ${item.type} ${item.fileName ?? path.basename(item.filePath)} ${item.mimeType} ${item.filePath}`);
  }
  return lines.join("\n");
}

async function writeStructuredPromptBlocks(
  blocks: AcpContentBlock[],
  deps: StructuredPromptFileDeps,
): Promise<StructuredPromptFile> {
  let dir = "";
  try {
    dir = await deps.mkdtemp(path.join(deps.tmpdir(), "xacpx-acp-prompt-"));
    const filePath = path.join(dir, "prompt.json");
    await deps.writeFile(filePath, JSON.stringify(blocks), "utf8");
    return { filePath, cleanup: async () => deps.rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    if (dir) await deps.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

const defaultStructuredPromptFileDeps: StructuredPromptFileDeps = {
  readImageFile: readImageFileBounded,
  mkdtemp,
  writeFile,
  rm,
  tmpdir: defaultTmpdir,
};

export async function readImageFileBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const imageStats = await handle.stat();
    if (!imageStats.isFile()) {
      throw new Error("image prompt path must be a regular file");
    }
    if (imageStats.size > maxBytes) {
      throw new Error(`image prompt exceeds ${maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let position = 0;
    const chunkSize = 1024 * 1024;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function resolveImageMimeType(buffer: Buffer, declaredMimeType: string): string {
  if (/^image\/[A-Za-z0-9.+-]+$/.test(declaredMimeType) && declaredMimeType !== "image/*") {
    return declaredMimeType;
  }

  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }

  return "image/png";
}
