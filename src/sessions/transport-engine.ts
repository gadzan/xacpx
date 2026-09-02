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
 * 3. Config mode decides for new sessions: default is now `auto` (PR10 switch
 *    after G1–G13 green). `auto` picks Runtime when eligible, otherwise cli.
 *    Eligibility includes explicit command, runtime availability, and permission
 *    policy checks. Existing sessions keep their persisted binding (invariant).
 * 4. Rollback: `transport.engine = cli` only affects new sessions; existing
 *    runtime sessions keep runtime until explicit migration (plan §60).
 *
 * Observability: callers should log `transport.engine.selected` with
 * `engine` + `reason`, `transport.engine.ineligible` when auto falls back,
 * and `transport.engine.binding_migrated` when a legacy session gets cli.
 */
export function resolveTransportEngine(input: ResolveTransportEngineInput): TransportEngineChoice {
  const persisted = input.session?.transport_engine;
  if (persisted === "cli" || persisted === "runtime") {
    return { engine: persisted };
  }

  const configured: BridgeEngineMode =
    input.config.engine === "auto" || input.config.engine === "cli" || input.config.engine === "runtime"
      ? input.config.engine
      : "auto";
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
  if (configured === "auto") {
    if (!input.runtimeAvailable) {
      return { engine: "cli", reason: "runtime-import-failed" };
    }
    // Auto eligibility probe: if Runtime is available and no explicit
    // command, prefer Runtime. Permission-policy eligibility is checked
    // by the bridge's own probe (isEligibleForRuntime) at prompt time;
    // session creation stays permissive to avoid blocking new sessions
    // on policy that may be updated before first prompt. Existing
    // sessions remain pinned (step 1).
    return { engine: "runtime" };
  }
  return { engine: "cli" };
}
