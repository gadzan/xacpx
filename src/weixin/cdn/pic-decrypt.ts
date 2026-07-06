import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl } from "./cdn-url.js";
import { weixinLog } from "../util/weixin-log";

/**
 * Download raw bytes from the CDN (no decryption).
 */
async function fetchCdnBytes(url: string, label: string, maxBytes?: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const cause =
      (err as NodeJS.ErrnoException).cause ?? (err as NodeJS.ErrnoException).code ?? "(no cause)";
    weixinLog.error("weixin.cdn.fetch_network_error", `${label}: fetch network error`, {
      url,
      err: String(err),
      cause: String(cause),
    });
    throw err;
  }
  weixinLog.debug("weixin.cdn.pic_response", `${label}: response`, { status: res.status, ok: res.ok });
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    const msg = `${label}: CDN download ${res.status} ${res.statusText} body=${body}`;
    weixinLog.error("weixin.cdn.download_failed", msg, { status: res.status, statusText: res.statusText });
    throw new Error(msg);
  }
  const contentLength = res.headers.get("content-length");
  if (maxBytes !== undefined && contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${label}: CDN download exceeds ${maxBytes} bytes`);
    }
  }

  if (!res.body) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
      throw new Error(`${label}: CDN download exceeds ${maxBytes} bytes`);
    }
    return buffer;
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label}: CDN download exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)          → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    // hex-encoded key: base64 → hex string → raw bytes
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  const msg = `${label}: aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes (base64="${aesKeyBase64}")`;
  weixinLog.error("weixin.cdn.pic_decrypt_failed", msg);
  throw new Error(msg);
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 * aesKeyBase64: CDNMedia.aes_key JSON field (see parseAesKey for supported formats).
 */
export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
  maxBytes?: number,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  weixinLog.debug("weixin.cdn.pic_fetch", `${label}: fetching`, { url });
  const encryptedMaxBytes = maxBytes === undefined ? undefined : maxBytes + 16;
  const encrypted = await fetchCdnBytes(url, label, encryptedMaxBytes);
  weixinLog.debug("weixin.cdn.pic_downloaded", `${label}: downloaded, decrypting`, {
    bytes: encrypted.byteLength,
  });
  const decrypted = decryptAesEcb(encrypted, key);
  if (maxBytes !== undefined && decrypted.byteLength > maxBytes) {
    throw new Error(`${label}: decrypted media exceeds ${maxBytes} bytes`);
  }
  weixinLog.debug("weixin.cdn.pic_decrypted", `${label}: decrypted`, { bytes: decrypted.length });
  return decrypted;
}

/**
 * Download plain (unencrypted) bytes from the CDN. Returns the raw Buffer.
 */
export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
  maxBytes?: number,
): Promise<Buffer> {
  const url = fullUrl || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  weixinLog.debug("weixin.cdn.pic_fetch_plain", `${label}: fetching`, { url });
  return fetchCdnBytes(url, label, maxBytes);
}
