import { hasWorkspaceNameChars, workspaceNameFallback } from "@ganglion/xacpx-relay-protocol";

/** Lowercase, collapse any non [a-z0-9] run to a single dash, trim leading/trailing dashes. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Default session alias from a workspace name and an agent name. */
export function genAlias(workspace: string, agent: string): string {
  const combined = `${workspace}-${agent}`;
  const slug = slugify(combined);
  if (slug.length > 0) return slug;
  return workspaceNameFallback(combined);
}

/** `base`, or `base-2`, `base-3`, … — the first not present in `existing`. */
export function uniqueName(base: string, existing: string[]): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Derive a workspace name from a filesystem path's final segment (POSIX or Windows). */
export function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).pop() ?? "";
  const slug = slugify(segment);
  if (slug.length > 0) return slug;
  // Only a segment that still carries usable characters (CJK or other
  // non-ASCII letters/digits) earns an opaque hashed name. A blank or
  // symbols-only segment yields "" so callers can reject it as underivable.
  if (!hasWorkspaceNameChars(segment)) return "";
  return workspaceNameFallback(segment);
}
