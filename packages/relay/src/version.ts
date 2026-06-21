import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCapture } from "./proc.js";

export const RELAY_PACKAGE_NAME = "@ganglion/xacpx-relay";

/** Read this relay build's own version from its package.json. Resolves against
 *  import.meta.url (same as resolveBundledWebRoot), so it works both from source
 *  (packages/relay/src) and from the bundled dist/cli.js. Falls back to "unknown". */
export function readRelayVersion(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  for (const candidate of [
    join(here, "package.json"),
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (parsed.name === RELAY_PACKAGE_NAME && typeof parsed.version === "string") return parsed.version;
    } catch { /* try next candidate */ }
  }
  return "unknown";
}

export async function getLatestNpmVersion(packageName: string): Promise<string | null> {
  let result: { code: number; stdout: string; stderr: string };
  try {
    result = await runCapture("npm", ["view", packageName, "version", "--json"], { timeoutMs: 8000 });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const raw = result.stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return raw.replace(/^"|"$/g, "") || null;
  }
}

/** True when `candidate` >= compare numerically on major.minor.patch; a prerelease
 *  ranks below the same release (so a staging prerelease never trips "update available"). */
export function isNewer(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

function compareSemver(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; prerelease: boolean } => {
    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(-[^\s]*)?/.exec(value);
    if (!match) return { nums: [0, 0, 0], prerelease: false };
    return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: Boolean(match[4]) };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i]! !== right.nums[i]!) return left.nums[i]! < right.nums[i]! ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease ? -1 : 1;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/** Build a cached update-checker. Only SUCCESSFUL latest lookups are cached (for
 *  ttlMs); a failed/null lookup leaves the cache untouched so the next call retries.
 *  Clock + fetcher are injectable for tests. */
export function createRelayUpdateChecker(opts: {
  current: string;
  getLatest?: () => Promise<string | null>;
  now?: () => number;
  ttlMs?: number;
}): () => Promise<UpdateCheck> {
  const getLatest = opts.getLatest ?? (() => getLatestNpmVersion(RELAY_PACKAGE_NAME));
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
  let cache: { latest: string; at: number } | null = null;
  return async (): Promise<UpdateCheck> => {
    if (!cache || now() - cache.at >= ttlMs) {
      try {
        const latest = await getLatest();
        if (latest != null) cache = { latest, at: now() };
      } catch { /* keep any prior cache; report current-only below */ }
    }
    const latest = cache?.latest ?? null;
    return { current: opts.current, latest, updateAvailable: latest != null && isNewer(latest, opts.current) };
  };
}
