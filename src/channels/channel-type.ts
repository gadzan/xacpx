/** Canonical channel namespace shared by registration and external ingress. */
export function normalizeChannelType(type: string): string {
  const normalized = type.trim();
  if (!normalized) throw new Error("channel type must be non-empty");
  if (normalized.includes(":")) throw new Error("channel type must not contain ':'");
  return normalized;
}
