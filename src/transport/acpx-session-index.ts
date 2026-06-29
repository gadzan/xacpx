import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { ResolvedSession } from "./types";

interface AcpxSessionIndexEntry {
  name?: string;
  cwd?: string;
  agentCommand?: string;
}

interface AcpxSessionIndex {
  entries?: AcpxSessionIndexEntry[];
}

export type SessionAgentCommandResolver = (session: ResolvedSession) => Promise<string | undefined>;

export async function resolveSessionAgentCommandFromIndex(session: ResolvedSession): Promise<string | undefined> {
  const home = process.env.HOME ?? homedir();
  if (!home) {
    return undefined;
  }

  try {
    const raw = await readFile(resolve(home, ".acpx", "sessions", "index.json"), "utf8");
    const parsed = JSON.parse(raw) as AcpxSessionIndex;
    const targetCwd = resolve(session.cwd);
    const match = parsed.entries?.find((entry) =>
      entry.name === session.transportSession &&
      typeof entry.cwd === "string" && resolve(entry.cwd) === targetCwd &&
      typeof entry.agentCommand === "string" &&
      entry.agentCommand.trim().length > 0
    );

    return match?.agentCommand?.trim();
  } catch {
    return undefined;
  }
}
