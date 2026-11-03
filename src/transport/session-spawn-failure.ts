import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { t } from "../i18n/index.js";
import type { ResolvedSession } from "./types";

/**
 * acpx appends this sentence only when the spawn cause is ENOENT; the shorter
 * "Failed to spawn agent command" prefix also covers admission rejections and
 * PID-less spawns, which are not proof of a missing launch path.
 */
const ENOENT_SPAWN_SENTENCE = "required executable, interpreter, working directory, or other launch path was not found";

function isAbsentPathError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Absent only when the stat itself says ENOENT/ENOTDIR: a file, or an unreadable path, is not "missing". */
function cwdIsAbsent(cwd: string): boolean {
  try {
    statSync(cwd);
    return false;
  } catch (error) {
    return isAbsentPathError(error);
  }
}

/**
 * acpx reports every spawn ENOENT as a missing "executable, interpreter,
 * working directory, or other launch path", so a workspace directory that was
 * moved or deleted reads as a broken agent command. Name the launch path xacpx
 * can prove is gone instead, and keep the acpx error as cause.
 */
export function explainSessionSpawnFailure(session: ResolvedSession, error: unknown): unknown {
  const spawnEnoent =
    (error as { detailCode?: unknown } | null)?.detailCode === "AGENT_SPAWN_ENOENT" ||
    (error instanceof Error && error.message.includes(ENOENT_SPAWN_SENTENCE));
  if (!spawnEnoent) return error;
  if (cwdIsAbsent(session.cwd)) {
    return new Error(t().misc.workspaceCwdMissing(session.workspace, session.cwd), { cause: error });
  }
  // Only argv[0] is a launch path: later entries are exec arguments, so their
  // absence cannot cause a spawn ENOENT. A bare argv[0] resolves through the
  // child's PATH, which xacpx cannot see.
  const launchPath = session.agentArgv?.[0];
  if (launchPath && isAbsolute(launchPath) && !existsSync(launchPath)) {
    return new Error(t().misc.agentLaunchPathMissing(session.agent, launchPath), { cause: error });
  }
  return error;
}
