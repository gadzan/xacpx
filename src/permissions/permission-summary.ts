/**
 * Bounded presentation for permission requests (plan I9).
 *
 * Never dumps raw tool input into channel UI/logs. Prefers title/kind plus a
 * short scalar summary; falls back to title/kind only when summarization
 * cannot produce a bounded string.
 */

export interface PermissionSummary {
  title?: string;
  kind?: string;
  summary?: string;
}

const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 800;
const MAX_INPUT_SCAN_CHARS = 4000;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function asBoundedTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, MAX_TITLE_CHARS);
}

function scalarToSummary(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return truncate(trimmed, MAX_SUMMARY_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return truncate(String(value), MAX_SUMMARY_CHARS);
  }
  return undefined;
}

/**
 * Pick a single human-meaningful scalar from tool input without serializing
 * the whole payload. Prefers command-like keys, then path-like keys, then
 * the first short scalar found.
 */
function pickScalarSummary(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const direct = scalarToSummary(input);
  if (direct !== undefined) return direct;
  if (typeof input !== "object") return undefined;
  if (Array.isArray(input)) {
    for (const item of input.slice(0, 5)) {
      const s = scalarToSummary(item);
      if (s !== undefined) return s;
    }
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const preferredKeys = ["command", "cmd", "script", "path", "file", "filePath", "url", "query", "pattern", "text", "input", "prompt"];
  for (const key of preferredKeys) {
    if (key in record) {
      const s = scalarToSummary(record[key]);
      if (s !== undefined) return truncate(`${key}: ${s}`, MAX_SUMMARY_CHARS);
    }
  }
  // Shallow scan of first few short scalar values; never recurse or stringify.
  let scanned = 0;
  for (const [key, value] of Object.entries(record)) {
    if (scanned >= MAX_INPUT_SCAN_CHARS) break;
    scanned += key.length + 8;
    const s = scalarToSummary(value);
    if (s !== undefined) return truncate(`${key}: ${s}`, MAX_SUMMARY_CHARS);
    scanned += 32;
    if (scanned > 12) break;
  }
  return undefined;
}

export function summarizePermissionRequest(input: {
  title?: string;
  kind?: string;
  rawInput?: unknown;
}): PermissionSummary {
  const out: PermissionSummary = {};
  const title = asBoundedTitle(input.title);
  if (title !== undefined) out.title = title;
  if (typeof input.kind === "string" && input.kind.trim()) {
    out.kind = truncate(input.kind.trim(), 80);
  }
  try {
    const summary = pickScalarSummary(input.rawInput);
    if (summary !== undefined) out.summary = summary;
  } catch {
    // Fall back to title/kind only — never an unrestricted serialization.
  }
  return out;
}
