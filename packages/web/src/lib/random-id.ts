const HEX = "0123456789abcdef";

/**
 * UUID v4 for request ids.
 *
 * `crypto.randomUUID` is only exposed in secure contexts, so a dashboard opened
 * over plain HTTP (a LAN address or a Tailscale Machine name) would otherwise
 * throw before an RPC is sent. `crypto.getRandomValues` is available in
 * insecure contexts too; only the UUID formatting is ours.
 */
export function randomUuid(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") return source.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof source?.getRandomValues === "function") {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122 version 4 + variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += "-";
    const byte = bytes[index]!;
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  }
  return out;
}
