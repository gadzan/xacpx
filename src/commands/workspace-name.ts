import { workspaceNameFallback } from "@ganglion/xacpx-relay-protocol";
import { sanitizeString } from "../util/sanitize.js";
import { quoteIfNeeded } from "../util/text.js";

const VALID_WORKSPACE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function sanitizeWorkspaceName(input: string, fallback = "workspace"): string {
  const sanitized = sanitizeString(input.trim(), {
    allow: /[a-zA-Z0-9._-]/,
    replacement: "-",
    trim: true,
  });
  if (sanitized.length > 0) return sanitized;
  if (input.trim().length === 0) return fallback;
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
