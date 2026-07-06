import type { AppLogger } from "../../logging/app-logger";

// Derived from AppLogger itself (rather than a hand-rolled Record<string, unknown>)
// so this can never drift out of structural sync with the real sink it forwards to.
type SinkContext = NonNullable<Parameters<AppLogger["debug"]>[2]>;
type LogFn = (event: string, message: string, context?: SinkContext) => unknown;

export interface WeixinLog {
  debug(event: string, message: string, context?: SinkContext): void;
  info(event: string, message: string, context?: SinkContext): void;
  error(event: string, message: string, context?: SinkContext): void;
}

type Sink = Pick<AppLogger, "debug" | "info" | "error">;

let sink: Sink | null = null;

/** Inject the sink (the DI'd AppLogger) at the composition root. */
export function setWeixinLog(logger: Sink): void {
  sink = logger;
}

/** Test-only: drop the sink so cases start from the un-injected state. */
export function resetWeixinLogForTest(): void {
  sink = null;
}

function forward(level: keyof Sink, event: string, message: string, context?: SinkContext): void {
  if (!sink) return;
  try {
    // Fire-and-forget: the AppLogger returns a never-rejecting Promise, but we
    // also guard synchronously so a sink swap or unexpected throw can never
    // surface in a weixin hot path.
    void sink[level](event, message, context);
  } catch {
    // Logging must never break the caller.
  }
}

export const weixinLog: WeixinLog = {
  debug: (event, message, context) => forward("debug", event, message, context),
  info: (event, message, context) => forward("info", event, message, context),
  error: (event, message, context) => forward("error", event, message, context),
};
