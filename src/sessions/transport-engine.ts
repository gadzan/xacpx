import type { BridgeEngineMode, TransportConfig } from "../config/types";
import type { SessionTransportEngine } from "../state/types";

/** Why a session is not eligible for the Runtime engine (plan §5). */
export type RuntimeIneligibleReason =
  | "explicit-acpx-command"
  | "runtime-import-failed"
  | "runtime-probe-failed"
  | "unsupported-permission-mode"
  | "unsupported-permission-policy"
  | "unsupported-session-shape"
  | "record-compatibility-failed";

export interface ResolveTransportEngineInput {
  config: { type: TransportConfig["type"]; command?: string; engine?: BridgeEngineMode };
  /** Existing persisted binding. `undefined` = brand-new session with no record. */
  session?: { transport_engine?: SessionTransportEngine };
}

export interface TransportEngineChoice {
  engine: SessionTransportEngine;
  reason?: RuntimeIneligibleReason;
}

/**
 * Single source of truth for engine affinity resolution (plan §3-R1..R3, §5).
 *
 * Precedence:
 * 1. Persisted per-session binding wins — never re-derived per request.
 * 2. Explicit `transport.command` (self-provided acpx) forces cli; under strict
 *    `engine: "runtime"` this is a configuration error, not a silent fallback.
 * 3. Config mode decides for new sessions: development-phase default is cli;
 *    "auto" also resolves to cli until the Runtime gates (G1–G13) go green.
 */
export function resolveTransportEngine(input: ResolveTransportEngineInput): TransportEngineChoice {
  const persisted = input.session?.transport_engine;
  if (persisted === "cli" || persisted === "runtime") {
    return { engine: persisted };
  }

  const configured: BridgeEngineMode =
    input.config.engine === "auto" || input.config.engine === "cli" || input.config.engine === "runtime"
      ? input.config.engine
      : "cli";
  const hasExplicitCommand = typeof input.config.command === "string" && input.config.command.trim().length > 0;

  if (configured === "runtime" && hasExplicitCommand) {
    throw new Error(
      'transport.engine = "runtime" conflicts with explicit transport.command (self-provided acpx); remove one of them',
    );
  }
  if (configured === "runtime") {
    return { engine: "runtime" };
  }
  if (hasExplicitCommand) {
    return { engine: "cli", reason: "explicit-acpx-command" };
  }
  // configured === "auto" stays on cli this wave: Runtime selection unlocks only
  // after the worker infrastructure lands and G1–G13 pass.
  return { engine: "cli" };
}
