import { hasWorkspaceNameChars, workspaceNameFallback } from "@ganglion/xacpx-relay-protocol";
import { sanitizeString } from "../util/sanitize.js";
import { quoteIfNeeded } from "../util/text.js";

const VALID_WORKSPACE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Derive a valid workspace name from free-form input.
 *
 * - ASCII-bearing input keeps its sanitized ASCII part (`api v2 中文` → `api-v2`).
 * - Input with other letters/digits (all-CJK, …) gets an opaque hashed name.
 * - Blank input returns `fallback` (callers keep their own blank semantics).
 * - Input with no Unicode letter or digit (`!!!`, `...`, `___`) is rejected
 *   with `null`; callers must surface that as an invalid-name error. The
 *   Web dashboard applies the same rule (`hasWorkspaceNameChars`).
 */
export function sanitizeWorkspaceName(input: string, fallback = "workspace"): string | null {
  if (input.trim().length === 0) return fallback;
  // Checked first so ASCII punctuation (`...`, `___`) is rejected too.
  if (!hasWorkspaceNameChars(input)) return null;
  const sanitized = sanitizeString(input.trim(), {
    allow: /[a-zA-Z0-9._-]/,
    replacement: "-",
    trim: true,
  });
  if (sanitized.length > 0) return sanitized;
  return workspaceNameFallback(input, fallback);
}

export function allocateWorkspaceName(base: string, existing: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(existing, base)) return base;
  let suffix = 2;
  while (Object.prototype.hasOwnProperty.call(existing, `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function isWorkspaceNameValid(input: string): boolean {
  return VALID_WORKSPACE_NAME_RE.test(input);
}

export function quoteWorkspaceNameIfNeeded(input: string): string {
  if (isWorkspaceNameValid(input)) return input;
  return quoteIfNeeded(input);
}
