import path from "node:path";
import { homedir } from "node:os";

const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH_RE = /^\\\\/;
const ROOT_PATH_RE = /^(\/|[a-zA-Z]:\/?)$/;

export function normalizePath(input: string): string {
  const expanded = expandHome(input);
  if (isWindowsLikePath(expanded)) {
    return path.win32.normalize(expanded).replace(/\\/g, "/");
  }
  return path.posix.normalize(expanded.replace(/\\/g, "/"));
}

export function basenameForPath(input: string): string {
  const normalized = normalizePath(input);
  if (ROOT_PATH_RE.test(normalized)) {
    return normalized;
  }
  const base = path.posix.basename(normalized);
  return base || normalized;
}

export function isSamePath(left: string, right: string): boolean {
  const normalizedLeft = stripTrailingSeparators(normalizePath(left));
  const normalizedRight = stripTrailingSeparators(normalizePath(right));

  if (isWindowsLikePath(normalizedLeft) || isWindowsLikePath(normalizedRight)) {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

export function isWindowsLikePath(input: string): boolean {
  return WINDOWS_DRIVE_PATH_RE.test(input) || WINDOWS_UNC_PATH_RE.test(input);
}

/** Expand a leading `~` to the home directory, keeping the platform's native
 *  separators. Workspace cwds are user config and are routinely written as `~`
 *  or `~/path`; every consumer that needs a PHYSICAL path (spawn, acpx record
 *  lookup, reap identity) must go through here, because the recorded path is
 *  always absolute. */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~" + path.sep)) {
    return path.resolve(homedir(), input.slice(2));
  }
  return input;
}

/**
 * Trailing separators are not part of a path's identity: `/tmp/x/` and
 * `/tmp/x` denote the same directory. Roots (`/`, `C:/`, `C:`) keep their
 * canonical shape instead of collapsing to an empty string.
 */
function stripTrailingSeparators(normalized: string): string {
  if (ROOT_PATH_RE.test(normalized)) return normalized;
  const trimmed = normalized.replace(/\/+$/, "");
  return trimmed === "" ? normalized : trimmed;
}
