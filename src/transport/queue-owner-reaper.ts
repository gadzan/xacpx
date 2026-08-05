import { spawn } from "node:child_process";

import { resolveSpawnCommand } from "../process/spawn-command";
import { settleWithinTimeout } from "../util/async.js";
import { terminateAcpxQueueOwner } from "./acpx-queue-owner-launcher";

/**
 * Minimal session identity needed to locate an acpx queue owner: enough to run
 * `acpx sessions show <name>` and resolve the session's stable record id, which
 * is the key acpx uses for the queue lock at `~/.acpx/queues/<hash>.lock`.
 */
export interface ReapTarget {
  agent: string;
  agentCommand?: string;
  /** Positional acpx agent (overlay alias or bare driver) for structured launches. */
  acpxAgent?: string;
  /** Unix-only legacy raw override passed as acpx `--agent`. */
  rawCommand?: string;
  cwd: string;
  transportSession: string;
}

export interface ReapQueueOwnersDeps {
  /** Resolve a target to its acpx record id (queue key), or null when unknown. */
  resolveRecordId?: (acpxCommand: string, target: ReapTarget) => Promise<string | null>;
  /** Terminate the queue owner process for a record id (kills process, keeps session). */
  terminate?: (acpxRecordId: string) => Promise<void>;
  /** Overall budget for the whole sweep; on expiry we return what finished. */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  onError?: (target: ReapTarget, error: unknown) => void;
}

export class LegacyOwnerUnverifiableError extends Error {
  readonly code = "legacy-owner-unverifiable";

  constructor() {
    super("legacy Windows queue owner has no durable token identity and cannot be auto-reaped");
  }
}

/**
 * Terminate the warm acpx queue owner processes for the given sessions on daemon
 * stop. Each owner holds a live ACP agent kept warm by `--ttl`; without this they
 * would linger until the TTL expires (or forever when ttl=0) after the daemon is
 * gone. This kills only the owner process tree — it does NOT close the acpx session
 * (no `closed` flag, no metadata change), so sessions resume normally on next start.
 *
 * Best-effort by design: per-target failures are swallowed and the whole sweep is
 * bounded by `timeoutMs`. If resolution fails or times out, the owner simply lingers
 * until its TTL — i.e. the pre-existing behaviour, never a regression or a hang.
 */
export async function reapQueueOwners(
  acpxCommand: string,
  targets: ReapTarget[],
  deps: ReapQueueOwnersDeps = {},
): Promise<{ terminated: number; attempted: number }> {
  const resolveRecordId = deps.resolveRecordId ?? defaultResolveRecordId;
  const platform = deps.platform ?? process.platform;
  // The legacy terminator ultimately accepts only a queue-lock PID. That remains
  // valid on Unix (process-group semantics), but is intentionally disabled on
  // Windows: token-less pre-upgrade owners are reusable/degraded evidence, never
  // candidates for an automatic bare-PID kill. Registered Windows owners are
  // reconciled by windows-orphan-reaper instead.
  const terminate = deps.terminate ?? (platform === "win32"
    ? async () => { throw new LegacyOwnerUnverifiableError(); }
    : terminateAcpxQueueOwner);
  const timeoutMs = deps.timeoutMs ?? 5_000;

  // Several aliases can share one transport session; the queue owner is per
  // session record, so dedup by composite identity to avoid redundant resolves/kills.
  // Two targets that share a session *name* but differ in cwd or agent resolve to
  // different acpx records (different queue owners) and must both be reaped.
  // Use JSON.stringify so cwd values with arbitrary characters cannot collide.
  const seen = new Set<string>();
  const unique = targets.filter((target) => {
    const key = JSON.stringify([target.agent, target.agentCommand ?? null, target.cwd, target.transportSession]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  let terminated = 0;
  const reapOne = async (target: ReapTarget): Promise<void> => {
    try {
      const recordId = await resolveRecordId(acpxCommand, target);
      if (!recordId) {
        return;
      }
      await terminate(recordId);
      terminated += 1;
    } catch (error) {
      deps.onError?.(target, error);
    }
  };

  await settleWithinTimeout(Promise.all(unique.map(reapOne)), timeoutMs);
  return { terminated, attempted: unique.length };
}

async function defaultResolveRecordId(acpxCommand: string, target: ReapTarget): Promise<string | null> {
  const args = [
    "--format",
    "quiet",
    "--cwd",
    target.cwd,
    // Same launch selector as the transports: raw Unix override → `--agent`;
    // overlay alias → positional; legacy `agentCommand`-only targets keep the
    // old `--agent` form; otherwise the bare agent name.
    ...(target.rawCommand
      ? ["--agent", target.rawCommand]
      : target.acpxAgent
        ? [target.acpxAgent]
        : target.agentCommand
          ? ["--agent", target.agentCommand]
          : [target.agent]),
    "sessions",
    "show",
    target.transportSession,
  ];
  const spawnSpec = resolveSpawnCommand(acpxCommand, args);
  const result = await runCapture(spawnSpec.command, spawnSpec.args, 4_000);
  if (result.code !== 0) {
    return null;
  }
  return parseRecordId(result.stdout);
}

// Mirrors the transports' readSessionRecord parsing. `acpx sessions show
// --format quiet` emits a bare record id, handled by the first-line branch; the
// JSON branch additionally accepts a record-object payload so this stays correct
// if the output format ever changes (e.g. --format json).
export function parseRecordId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { acpxRecordId?: unknown; id?: unknown };
    if (typeof parsed.acpxRecordId === "string") {
      return parsed.acpxRecordId;
    }
    if (typeof parsed.id === "string") {
      return parsed.id;
    }
  } catch {
    const firstLine = stdout.trim().split(/\r?\n/, 1)[0];
    if (firstLine && /^[\w.:-]+$/.test(firstLine) && firstLine.length >= 8) {
      return firstLine;
    }
  }
  return null;
}

function runCapture(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let done = false;
    const finish = (code: number) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });
}
