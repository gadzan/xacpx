import { isMissingAcpxSessionError, parseAcpxSessionRecordId } from "../transport/acpx-command-builder";
import { CommandTimeoutError, type AcpxCommandStage } from "../transport/command-timeouts";
import { parseSessionEffortRecord } from "../transport/session-effort";
import type { AgentCapabilityProbeResult } from "../transport/types";

/** Reserved acpx session name. Probe ownership is this name plus the agent and cwd. */
export const CAPABILITY_PROBE_SESSION_NAME = "xacpx-capability-probe";

/**
 * Whole-probe budget. It sits under the hub's 120s RPC ceiling so close and
 * file deletion still run after a slow `sessions new`.
 */
export const CAPABILITY_PROBE_BUDGET_MS = 90_000;

export type ProbeTransportResult = AgentCapabilityProbeResult;

export interface ProbeCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CapabilityProbeRunner {
  run(stage: AcpxCommandStage, tail: string[], timeoutMs: number): Promise<ProbeCommandResult>;
  deleteRecord(acpxRecordId: string): Promise<void>;
}

/**
 * acpx 0.16.0 has no model-inspect command. Models are written onto the local
 * session record by `sessions new` (ACP session/new, no user prompt) and read
 * back from `status` / `sessions show`. This sequence owns that record and
 * always closes it.
 */
export async function executeCapabilityProbe(
  runner: CapabilityProbeRunner,
  budgetMs: number,
  now: () => number = Date.now,
): Promise<ProbeTransportResult> {
  const started = now();
  const remaining = () => Math.max(1, budgetMs - (now() - started));
  const name = CAPABILITY_PROBE_SESSION_NAME;
  let created = false;
  let recordId: string | undefined;
  let interpreted: ProbeTransportResult = {
    ok: false,
    failure: "transport",
    message: "capability probe did not run",
  };

  try {
    const createdResult = await runner.run("capability-probe-new", ["sessions", "new", "--name", name], remaining());
    if (createdResult.code !== 0) {
      interpreted = classifyProbeFailure(`${createdResult.stderr}\n${createdResult.stdout}`, false);
    } else {
      created = true;
      const status = await runner.run("capability-probe-status", ["status", "-s", name], Math.min(30_000, remaining()));
      const show = await runner.run("capability-probe-show", ["sessions", "show", name], Math.min(30_000, remaining()));
      recordId = show.code === 0 ? parseAcpxSessionRecordId(show.stdout)?.acpxRecordId : undefined;
      interpreted = interpretProbeCommandResults(status, show);
    }
  } catch (error) {
    interpreted = classifyProbeFailure(error instanceof Error ? error.message : String(error), error instanceof CommandTimeoutError);
  }

  const cleanupFailed = await cleanupProbe(runner, name, created, recordId, remaining);
  if (cleanupFailed && interpreted.ok) {
    return {
      ok: false,
      failure: "cleanup",
      message: "the capability probe created a session it could not close",
    };
  }
  return interpreted;
}

export function interpretProbeCommandResults(status: ProbeCommandResult, show: ProbeCommandResult): ProbeTransportResult {
  if (status.code !== 0) return classifyProbeFailure(`${status.stderr}\n${status.stdout}`, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(status.stdout);
  } catch {
    return { ok: false, failure: "unsupported", message: "acpx status did not return a capability record" };
  }
  const record = isRecord(parsed) ? parsed : undefined;
  const available = record && Array.isArray(record.availableModels)
    ? record.availableModels.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const names = modelNamesFromShow(show.code === 0 ? show.stdout : "");
  const models = available.map((modelId) => {
    const trimmed = modelId.trim();
    return { modelId: trimmed, name: names.get(trimmed) ?? trimmed };
  });
  const effort = show.code === 0 ? parseSessionEffortRecord(show.stdout) : undefined;
  if (models.length === 0) {
    return {
      ok: false,
      failure: "unsupported",
      message: "the adapter started but did not advertise any models",
    };
  }
  const currentModelId = record && typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
  return {
    ok: true,
    models,
    ...(currentModelId ? { currentModelId } : {}),
    efforts: effort?.available ?? [],
    ...(effort?.current ? { currentEffort: effort.current } : {}),
  };
}

export function classifyProbeFailure(message: string, timedOut: boolean): ProbeTransportResult {
  if (timedOut || /timed out/i.test(message)) {
    return { ok: false, failure: "timeout", message: "the capability probe timed out before the adapter advertised models" };
  }
  if (/AUTH_REQUIRED|auth required|authentication required|not authenticated|login required/i.test(message)) {
    return { ok: false, failure: "unauthenticated", message: "the adapter requires authentication before it can list models" };
  }
  if (/did not advertise model support|no models|cannot enumerate/i.test(message)) {
    return { ok: false, failure: "unsupported", message: "the adapter cannot enumerate models" };
  }
  const detail = message.trim().slice(0, 400) || "capability probe failed";
  return { ok: false, failure: "transport", message: detail };
}

function modelNamesFromShow(stdout: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const parsed = JSON.parse(stdout) as { acpx?: { available_model_names?: unknown } };
    const table = parsed.acpx?.available_model_names;
    if (!table || typeof table !== "object" || Array.isArray(table)) return names;
    for (const [modelId, name] of Object.entries(table)) {
      if (typeof name === "string" && name.trim()) names.set(modelId, name);
    }
  } catch {
    return names;
  }
  return names;
}

async function cleanupProbe(
  runner: CapabilityProbeRunner,
  name: string,
  created: boolean,
  recordId: string | undefined,
  remaining: () => number,
): Promise<boolean> {
  if (!created) return false;
  let closeFailed = false;
  try {
    const closed = await runner.run("capability-probe-close", ["sessions", "close", name], Math.min(30_000, remaining()));
    closeFailed = closed.code !== 0 && !isMissingAcpxSessionError(closed.stderr, closed.stdout);
  } catch {
    closeFailed = true;
  }
  if (!recordId) return closeFailed;
  try {
    await runner.deleteRecord(recordId);
    return false;
  } catch {
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
