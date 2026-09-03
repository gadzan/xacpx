import { statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeEngineMode, NonInteractivePermissions, PermissionMode, TransportConfig } from "../config/types";
import type { SessionTransportEngine } from "../state/types";
import {
  isEligibleForRuntime,
  parseXacpxPermissionPolicy,
  type XacpxPermissionPolicy,
} from "../bridge/engine/runtime/runtime-permission-policy";

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
  config: {
    type: TransportConfig["type"];
    command?: string;
    engine?: BridgeEngineMode;
    permissionMode?: PermissionMode;
    nonInteractivePermissions?: NonInteractivePermissions;
    permissionPolicy?: string;
    permissionInteractionAvailable?: boolean;
  };
  /** Existing persisted binding or candidate session shape. `undefined` = brand-new session with no record. */
  session?: {
    transport_engine?: SessionTransportEngine;
    agent?: string;
    workspace?: string;
    alias?: string;
    [key: string]: unknown;
  };
  /** True only once the bridge actually hosts a RuntimeEngine. */
  runtimeAvailable?: boolean;
  /** Optional probe function for runtime availability. */
  runtimeProbe?: () => boolean;
  /** Direct eligibility parameters (optional overrides or convenience inputs) */
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string | XacpxPermissionPolicy;
  permissionInteractionAvailable?: boolean;
  /** Probe or flag for record compatibility */
  recordCompatible?: boolean;
  /** Probe or flag for session shape validity */
  sessionShapeSupported?: boolean;
}

export interface TransportEngineChoice {
  engine: SessionTransportEngine;
  reason?: RuntimeIneligibleReason;
}

export function probeRuntimeWorkerAvailable(): boolean {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "../bridge/engine/runtime/runtime-worker-main.js"),
      resolvePath(here, "../../dist/bridge/engine/runtime/runtime-worker-main.js"),
      resolvePath(process.cwd(), "dist/bridge/engine/runtime/runtime-worker-main.js"),
      resolvePath(process.cwd(), "dist/engine/runtime/runtime-worker-main.js"),
    ];
    return candidates.some((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Single source of truth for engine affinity resolution (plan §3-R1..R3, §5).
 *
 * Precedence:
 * 1. Persisted per-session binding wins — never re-derived per request.
 * 2. Explicit `transport.command` (self-provided acpx) forces cli; under strict
 *    `engine: "runtime"` this is a configuration error, not a silent fallback.
 * 3. Config mode decides for new sessions:
 *    - `cli` (default): resolves to cli.
 *    - `runtime`: strict — requires runtime support, valid session shape, and
 *      compatible permission policy/mode; throws diagnostic errors on ineligibility.
 *    - `auto`: resolves to runtime when eligible (worker available, shape valid,
 *      record compatible, permission policy compatible); otherwise falls back
 *      to cli with a diagnostic reason.
 * 4. Rollback: `transport.engine = cli` only affects new sessions; existing
 *    runtime sessions keep runtime until explicit migration (plan §60).
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

  if (hasExplicitCommand) {
    if (configured === "runtime") {
      throw new Error(
        'transport.engine = "runtime" conflicts with explicit transport.command (self-provided acpx); remove one of them',
      );
    }
    return { engine: "cli", reason: "explicit-acpx-command" };
  }

  if (configured === "cli") {
    return { engine: "cli" };
  }

  const runtimeAvailable =
    input.runtimeAvailable ??
    (typeof input.runtimeProbe === "function" ? input.runtimeProbe() : probeRuntimeWorkerAvailable());

  if (!runtimeAvailable) {
    if (configured === "runtime") {
      throw new Error(
        'transport.engine = "runtime" requires acpx Runtime worker support, which this build does not enable yet',
      );
    }
    return { engine: "cli", reason: "runtime-import-failed" };
  }

  let sessionShapeValid = true;
  if (input.sessionShapeSupported === false) {
    sessionShapeValid = false;
  } else if (input.session) {
    if (typeof input.session.agent === "string" && input.session.agent.trim().length === 0) {
      sessionShapeValid = false;
    } else if (typeof input.session.workspace === "string" && input.session.workspace.trim().length === 0) {
      sessionShapeValid = false;
    } else if (input.session.unsupportedShape === true) {
      sessionShapeValid = false;
    }
  }
  if (!sessionShapeValid) {
    if (configured === "runtime") {
      throw new Error('transport.engine = "runtime" is not eligible for unsupported session shape');
    }
    return { engine: "cli", reason: "unsupported-session-shape" };
  }

  if (input.recordCompatible === false) {
    if (configured === "runtime") {
      throw new Error('transport.engine = "runtime" is not eligible: record compatibility check failed');
    }
    return { engine: "cli", reason: "record-compatibility-failed" };
  }

  const nonInteractivePermissions =
    input.nonInteractivePermissions ?? input.config.nonInteractivePermissions;
  const permissionMode = input.permissionMode ?? input.config.permissionMode;
  const permissionPolicyRaw = input.permissionPolicy ?? input.config.permissionPolicy;
  const interactiveAvailable =
    input.permissionInteractionAvailable ??
    input.config.permissionInteractionAvailable ??
    false;

  if (
    permissionMode !== undefined &&
    permissionMode !== "approve-all" &&
    permissionMode !== "approve-reads" &&
    permissionMode !== "deny-all"
  ) {
    if (configured === "runtime") {
      throw new Error(
        `transport.engine = "runtime" is not eligible with unsupported permissionMode "${String(permissionMode)}"`,
      );
    }
    return { engine: "cli", reason: "unsupported-permission-mode" };
  }

  if (nonInteractivePermissions === "fail") {
    if (configured === "runtime") {
      throw new Error('transport.engine = "runtime" is not eligible with nonInteractivePermissions = "fail"');
    }
    return { engine: "cli", reason: "unsupported-permission-mode" };
  }

  let policy: XacpxPermissionPolicy | undefined;
  if (permissionPolicyRaw !== undefined) {
    if (typeof permissionPolicyRaw === "object" && permissionPolicyRaw !== null) {
      policy = permissionPolicyRaw as XacpxPermissionPolicy;
    } else {
      try {
        policy = parseXacpxPermissionPolicy(permissionPolicyRaw);
      } catch (err) {
        if (configured === "runtime") {
          throw new Error(
            `transport.engine = "runtime" permission policy error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return { engine: "cli", reason: "unsupported-permission-policy" };
      }
    }
  }

  const eligible = isEligibleForRuntime(policy, nonInteractivePermissions, interactiveAvailable);
  if (!eligible) {
    if (configured === "runtime") {
      throw new Error(
        'transport.engine = "runtime" is not eligible under current permission policy (escalate requires interactive permissions)',
      );
    }
    return { engine: "cli", reason: "unsupported-permission-policy" };
  }

  if (configured === "runtime" || configured === "auto") {
    return { engine: "runtime" };
  }
  return { engine: "cli" };
}

export const resolveTransportEngineWithEligibility = resolveTransportEngine;
