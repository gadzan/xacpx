export interface RelayLogger {
  debug(event: string, message: string, context?: Record<string, unknown>): void;
  info(event: string, message: string, context?: Record<string, unknown>): void;
  error(event: string, message: string, context?: Record<string, unknown>): void;
}

type Level = "error" | "info" | "debug";
const ORDER: Record<Level, number> = { error: 0, info: 1, debug: 2 };

export interface RelayLoggerOptions {
  level?: Level;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
  now?: () => Date;
}

export function createNoopRelayLogger(): RelayLogger {
  return { debug: () => {}, info: () => {}, error: () => {} };
}

export function createRelayLogger(options: RelayLoggerOptions = {}): RelayLogger {
  const level = options.level ?? resolveEnvLevel() ?? "info";
  const writeOut = options.writeOut ?? ((line: string) => process.stdout.write(line));
  const writeErr = options.writeErr ?? ((line: string) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  function emit(lvl: Level, event: string, message: string, context?: Record<string, unknown>): void {
    if (ORDER[lvl] > ORDER[level]) return;
    const line = formatLine(now(), lvl, event, message, context ?? {});
    if (lvl === "error") writeErr(line);
    else writeOut(line);
  }
  return {
    debug: (e, m, c) => emit("debug", e, m, c),
    info: (e, m, c) => emit("info", e, m, c),
    error: (e, m, c) => emit("error", e, m, c),
  };
}

function resolveEnvLevel(): Level | undefined {
  const raw = process.env.RELAY_LOG_LEVEL?.toLowerCase();
  return raw === "error" || raw === "info" || raw === "debug" ? raw : undefined;
}

// Mirrors the core app-logger line format (src/logging/app-logger.ts formatLogLine)
// so hub stdout and daemon app.log read the same. Reimplemented here because the
// relay package must not import from the core `src/` tree.
function formatLine(time: Date, level: Level, event: string, message: string, context: Record<string, unknown>): string {
  const fields = Object.entries(context)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${fmt(v)}`);
  const suffix = fields.length > 0 ? ` ${fields.join(" ")}` : "";
  return `${time.toISOString()} ${level.toUpperCase()} ${event} message=${fmt(message)}${suffix}\n`;
}

function fmt(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
