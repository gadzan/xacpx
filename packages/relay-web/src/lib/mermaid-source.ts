// UTF-8-safe base64 for carrying a mermaid diagram's source through an HTML data
// attribute. `btoa` only handles Latin-1, so encode to UTF-8 bytes first (the classic
// `encodeURIComponent`/`escape` bridge) — diagram labels are frequently non-ASCII.

/** Encode a diagram's source to attribute-safe base64 (alphabet `[A-Za-z0-9+/=]`). */
export function encodeMermaidSource(src: string): string {
  return btoa(unescape(encodeURIComponent(src)));
}

/** Inverse of {@link encodeMermaidSource}. */
export function decodeMermaidSource(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)));
}
