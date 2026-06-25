import { isSamePath, isWindowsLikePath, normalizePath } from "../util/path.js";
import { filterSubagentSessions } from "./codex-subagent-filter.js";
import type { AgentSessionListResult } from "./types";

export function isUnknownFilterCwdOption(output: string): boolean {
  return /(?:unknown|unrecognized) option/i.test(output) && output.includes("--filter-cwd");
}

export interface AgentSessionListCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Shared orchestration for `acpx <agent> sessions list --format json`, used by
 * both transports (acpx-cli spawns directly, acpx-bridge runs in a subprocess).
 *
 * Each transport injects `runList` (its own runner + arg builder) and
 * `formatError` (its own error-message extraction); the retry/capability/parse
 * policy lives here so the two implementations cannot drift:
 *   1. Run with `--filter-cwd`; if acpx rejects that option, retry without it
 *      and filter by cwd locally.
 *   2. If the agent doesn't advertise `sessionCapabilities.list`, return
 *      `undefined` so callers can fall back to xacpx logical sessions.
 *   3. Otherwise parse + validate the JSON payload.
 *   4. If `isSubagentSession` is provided (callers pass it only for agents whose
 *      session list can leak subagent threads, e.g. Codex), drop the flagged
 *      sessions. Fail-open — see codex-subagent-filter.
 */
export async function runAgentSessionList(options: {
  filterCwd?: string;
  runList: (includeFilterCwd: boolean) => Promise<AgentSessionListCommandResult>;
  formatError: (result: AgentSessionListCommandResult) => string;
  isSubagentSession?: (sessionId: string) => boolean;
}): Promise<AgentSessionListResult | undefined> {
  let result = await options.runList(true);
  let filterLocally = false;

  if (result.code !== 0 && options.filterCwd && isUnknownFilterCwdOption(result.stdout + result.stderr)) {
    result = await options.runList(false);
    filterLocally = true;
  }

  if (result.code !== 0) {
    if ((result.stdout + result.stderr).includes("sessionCapabilities.list")) {
      return undefined;
    }
    throw new Error(options.formatError(result));
  }

  const parsed = parseAgentSessionListOutput(result.stdout, filterLocally ? options.filterCwd : undefined);
  if (parsed && options.isSubagentSession) {
    return filterSubagentSessions(parsed, options.isSubagentSession);
  }
  return parsed;
}

export function parseAgentSessionListOutput(stdout: string, filterCwd?: string): AgentSessionListResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("failed to parse acpx sessions list output");
  }
  if (!isAgentSessionListResult(parsed)) {
    return undefined;
  }
  return filterCwd ? filterAgentSessionListByCwd(parsed, filterCwd) : parsed;
}

export function isAgentSessionListResult(value: unknown): value is AgentSessionListResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.source !== "agent" || !Array.isArray(record.sessions)) return false;
  return record.sessions.every((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return false;
    const item = session as Record<string, unknown>;
    return typeof item.sessionId === "string";
  });
}

export function filterAgentSessionListByCwd(result: AgentSessionListResult, cwd: string): AgentSessionListResult {
  return {
    ...result,
    sessions: result.sessions.filter((session) => session.cwd && isSamePath(session.cwd, cwd)),
  };
}
