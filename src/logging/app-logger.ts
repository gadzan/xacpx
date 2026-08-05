import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { LoggingLevel } from "../config/types";
import { rotateIfNeeded, cleanupExpiredRotatedLogs } from "./rotating-file-writer";

// Levels a caller can write at. `warn` sits between error and info; it is not a
// configurable threshold (LoggingLevel stays error|info|debug) — warns emit under
// the "info"/"debug" settings and are suppressed under "error".
type WriteLevel = LoggingLevel | "warn";

const LEVEL_ORDER: Record<WriteLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

type LogContextValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

interface LogContext {
  [key: string]: LogContextValue;
}

interface CreateAppLoggerOptions {
  filePath: string;
  level: LoggingLevel;
  maxSizeBytes: number;
  maxFiles: number;
  retentionDays: number;
  now?: () => Date;
}

export interface AppLogger {
  debug: (event: string, message: string, context?: LogContext) => Promise<void>;
  info: (event: string, message: string, context?: LogContext) => Promise<void>;
  warn: (event: string, message: string, context?: LogContext) => Promise<void>;
  error: (event: string, message: string, context?: LogContext) => Promise<void>;
  cleanup: () => Promise<void>;
  flush: () => Promise<void>;
}

export function createNoopAppLogger(): AppLogger {
  return {
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {},
    cleanup: async () => {},
    flush: async () => {},
  };
}

export function createAppLogger(options: CreateAppLoggerOptions): AppLogger {
  const now = options.now ?? (() => new Date());
  let writeChain = Promise.resolve();
  let modeEnsured = false;
  // Latch: emit at most one console.error when the log file becomes unwritable.
  // Reset only when an append actually succeeds (file may have been restored) —
  // level-filtered no-op writes must NOT reset it, or interleaved below-level
  // calls would turn the one-time notice into per-failure spam.
  let writeErrorLatched = false;

  return {
    debug: async (event, message, context) => {
      await enqueueWrite("debug", event, message, context);
    },
    info: async (event, message, context) => {
      await enqueueWrite("info", event, message, context);
    },
    warn: async (event, message, context) => {
      await enqueueWrite("warn", event, message, context);
    },
    error: async (event, message, context) => {
      await enqueueWrite("error", event, message, context);
    },
    cleanup: async () => {
      try {
        await cleanupExpiredRotatedLogs(options.filePath, options.retentionDays, now);
      } catch {
        // Cleanup failures must not abort the daemon. The rotating writer
        // already tolerates ENOENT; other transient errors (EACCES, etc.)
        // are silenced here so startup continues unaffected.
      }
    },
    flush: async () => {
      await writeChain;
    },
  };

  function enqueueWrite(
    level: WriteLevel,
    event: string,
    message: string,
    context: LogContext = {},
  ): Promise<void> {
    // The resolved promise handed back to the caller must never reject.
    // We catch write errors internally and degrade gracefully (emit a
    // one-time operator notice, then silently drop further failures).
    // Invariant: every promise assigned to writeChain has its rejection
    // handled below, so the chain head never rejects (no .catch needed).
    const writePromise = writeChain
      .then(() => writeLog(level, event, message, context))
      .catch((error: unknown) => {
        if (!writeErrorLatched) {
          writeErrorLatched = true;
          console.error(
            "[xacpx] app-logger: log file write failed — further write errors will be suppressed.",
            error instanceof Error ? error.message : String(error),
          );
        }
        // Swallow the error: callers must not be affected by log I/O failures.
      });
    writeChain = writePromise;
    return writePromise;
  }

  async function writeLog(
    level: WriteLevel,
    event: string,
    message: string,
    context: LogContext = {},
  ): Promise<void> {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[options.level]) {
      return;
    }

    const line = formatLogLine(now(), level, event, message, context);
    await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
    if (!modeEnsured) {
      // Harden a log file created before 0o600 was enforced. A missing file
      // (first run) throws ENOENT and is ignored — appendFile then creates it
      // at 0o600. Runs once per logger instance.
      modeEnsured = true;
      await chmod(options.filePath, 0o600).catch(() => {});
    }
    await rotateIfNeeded(options.filePath, Buffer.byteLength(line), options.maxSizeBytes, options.maxFiles);
    await appendFile(options.filePath, line, { encoding: "utf8", mode: 0o600 });
    // A real append succeeded — clear the latch so the next failure is
    // visible again (e.g. disk temporarily full then freed).
    writeErrorLatched = false;
  }
}

function formatLogLine(
  time: Date,
  level: WriteLevel,
  event: string,
  message: string,
  context: LogContext,
): string {
  const fields = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);

  const suffix = fields.length > 0 ? ` ${fields.join(" ")}` : "";
  return `${time.toISOString()} ${level.toUpperCase()} ${event} message=${formatValue(message)}${suffix}\n`;
}

function formatValue(value: LogContextValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

