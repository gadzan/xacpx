// UTF-8-safe base64 for carrying a mermaid diagram's source through an HTML data
// attribute. `btoa` only handles Latin-1, so encode to UTF-8 bytes first — diagram
// labels are frequently non-ASCII. We use TextEncoder rather than the classic
// `unescape(encodeURIComponent(...))` bridge because `encodeURIComponent` throws a
// URIError on a lone surrogate (e.g. a stray `\uD800` in agent output); this runs
// inside the markdown render with no error isolation, so a single bad code unit would
// crash the whole message. TextEncoder is total: it maps unpaired surrogates to U+FFFD.

/**
 * Encode any string to base64 via its UTF-8 bytes (alphabet `[A-Za-z0-9+/=]`). Shared with the PNG
 * exporter, which base64s serialized SVG markup and hits the same lone-surrogate/non-Latin-1 traps.
 */
export function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Encode a diagram's source to attribute-safe base64 (alphabet `[A-Za-z0-9+/=]`). */
export function encodeMermaidSource(src: string): string {
  return utf8ToBase64(src);
}

/** Inverse of {@link encodeMermaidSource}. */
export function decodeMermaidSource(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // ignoreBOM keeps a leading U+FEFF as a literal char so the round-trip is exact (the default
  // decoder silently strips it).
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
