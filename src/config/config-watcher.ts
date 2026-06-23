import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import type { AppLogger } from "../logging/app-logger";

export interface ConfigWatcherOptions {
  /** Absolute path to the config file (e.g. `~/.xacpx/config.json`). */
  configPath: string;
  /** Fired (debounced) when the config file is created, replaced, or modified. */
  onChange: () => void;
  /** Debounce window to coalesce one logical save's burst of fs events. Default 250ms. */
  debounceMs?: number;
  logger?: AppLogger;
  /** Injection seam for tests; defaults to node:fs `watch`. */
  watchFactory?: typeof watch;
}

export interface ConfigWatcher {
  close: () => void;
}

/**
 * Watch the config file for out-of-band edits and fire a debounced callback.
 *
 * Why watch the DIRECTORY, not the file: config writes go through
 * write-file-atomic (temp file + rename), which replaces the target's inode.
 * An `fs.watch` bound to the original file goes deaf after the first atomic
 * replace. Watching the containing directory and filtering on the basename
 * survives every replace.
 *
 * The callback is debounced because one logical save emits several directory
 * events (temp create, rename-into-place, attribute change), and because the
 * daemon's own writes (web-driven `/config` edits) trip the watcher too — the
 * caller is expected to no-op when nothing it cares about actually changed.
 *
 * Failure to start (exotic/network filesystems where `fs.watch` throws) is
 * swallowed: the daemon keeps working, operators just fall back to the
 * pre-existing "restart to pick up CLI edits" behavior.
 */
export function startConfigWatcher(options: ConfigWatcherOptions): ConfigWatcher {
  const { configPath, onChange, debounceMs = 250, logger } = options;
  const watchFactory = options.watchFactory ?? watch;
  const dir = dirname(configPath);
  const target = basename(configPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  const fire = (): void => {
    timer = undefined;
    try {
      onChange();
    } catch (error) {
      void logger?.error("config.watch.callback_failed", "config watch callback threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    // `persistent: false` so the watcher never keeps the process alive on its own.
    watcher = watchFactory(dir, { persistent: false }, (_event, filename) => {
      // `filename` is null on some platforms — when present, ignore unrelated
      // directory entries (state.json, the lockfile, temp files) so a busy state
      // write doesn't trigger needless config reloads.
      if (filename !== null && basename(filename.toString()) !== target) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
    });
    watcher.on("error", (error) => {
      void logger?.error("config.watch.error", "config watcher errored", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    void logger?.error("config.watch.start_failed", "could not start config watcher", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    close: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      watcher?.close();
      watcher = undefined;
    },
  };
}
