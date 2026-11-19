import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const ATTEMPTS = 12;
const DELAY_MS = 100;

/**
 * `rm -rf` that survives Windows EBUSY/EPERM.
 *
 * A test that spawns a CLI (which itself spawns an ACP agent) can still be
 * racing that grandchild's handle release when the parent process has already
 * seen the direct child exit. Deleting the temp home then fails with
 * `EBUSY: resource busy or locked` even though nothing is logically using the
 * files any more. Retrying with a short backoff is the portable way to clean
 * up; POSIX never hits this.
 */
export async function rmTemp(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await delay(DELAY_MS);
    }
  }
  throw lastError;
}
