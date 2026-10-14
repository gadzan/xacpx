import { resolve } from "node:path";

import type { ResolvedSession } from "./types";
import { scanAcpxSessionRecords } from "./acpx-record-discovery";
import { resolveAcpxHomeDir } from "./acpx-session-files";

export type SessionAgentCommandResolver = (session: ResolvedSession) => Promise<string | undefined>;

/**
 * Resolve the acpx agent command for a logical session from the canonical
 * session records on disk (acpx 0.19 ignores the legacy index.json).
 *
 * A record matches when its name equals the session's transport session and its
 * cwd resolves to the session's cwd. When several matching records disagree on
 * the agent command the answer is ambiguous, so this returns undefined rather
 * than guessing: a wrong command would launch a different agent for the session.
 */
export async function resolveSessionAgentCommandFromRecord(session: ResolvedSession): Promise<string | undefined> {
  const records = await scanAcpxSessionRecords({
    sessionsDir: resolve(resolveAcpxHomeDir(), ".acpx", "sessions"),
  });
  const targetCwd = resolve(session.cwd);
  const commands = records
    .filter(
      (record) =>
        record.name === session.transportSession &&
        resolve(record.cwd) === targetCwd &&
        record.agentCommand.trim().length > 0,
    )
    .map((record) => record.agentCommand.trim());

  if (commands.length === 0) {
    return undefined;
  }
  const first = commands[0]!;
  return commands.every((command) => command === first) ? first : undefined;
}
