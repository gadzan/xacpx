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
  /** True only once the bridge actually hosts a RuntimeEngine (Wave B+). */
  runtimeAvailable?: boolean;
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
 *
 * Strict `engine: "runtime"` is honored ONLY when a RuntimeEngine is actually
 * wired into the bridge (runtimeAvailable). Until the worker infrastructure
 * lands, strict mode fails loudly at session creation (plan §5.2: 不能静默
 * fallback) instead of silently running on the CLI engine while state claims
 * runtime — which would violate §3-R1's single-owner rule.
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

  if (configured === "runtime") {
    if (hasExplicitCommand) {
      throw new Error(
        'transport.engine = "runtime" conflicts with explicit transport.command (self-provided acpx); remove one of them',
      );
    }
    if (!input.runtimeAvailable) {
      throw new Error(
        'transport.engine = "runtime" requires acpx Runtime worker support, which this build does not enable yet',
      );
    }
    return { engine: "runtime" };
  }
  if (hasExplicitCommand) {
    return { engine: "cli", reason: "explicit-acpx-command" };
  }
  // configured === "auto"/absent stays on cli until G1–G13 pass and the default
  // switch PR flips auto to consult the eligibility probe.
  return { engine: "cli" };
}
