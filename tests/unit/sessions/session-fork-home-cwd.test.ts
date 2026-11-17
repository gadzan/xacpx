import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../../../src/config/types";
import { createEmptyState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import { readTransportSessionHistory } from "../../../src/transport/native-session-history";
import { resolveSessionForkNode, sessionForkPromptDigest } from "../../../src/sessions/session-fork-node";

class MemoryStateStore implements Pick<StateStore, "save"> {
  async save(): Promise<void> {}
  async saveNow(): Promise<void> {}
}

function config(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    // Pinned argv: a bare `omp` driver resolves through PATH, so the launch
    // identity (and therefore the record's `agent_command`) would differ between
    // a machine that has omp installed and CI.
    agents: { omp: { driver: "omp", argv: [process.execPath, "--acp"] } },
    // The operator writes the home workspace as `~`; a fork reads the acpx record
    // back and matches its absolute `cwd`, so the resolved value must be physical
    // or every fork fails with `session-fork-empty-history`.
    workspaces: { home: { cwd: "~" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
    },
  } as AppConfig;
}

const PROMPT = "fork me";

test("a `~` workspace reads the acpx record a fork needs", async () => {
  const sessionsDir = await mkdtemp(join(homedir(), ".xacpx-fork-cwd-test-"));
  try {
    const sessions = new SessionService(config(), new MemoryStateStore(), createEmptyState());
    await sessions.createSession("at-home", "omp", "home");
    const resolved = (await sessions.getSession("at-home"))!;
    expect(resolved.cwd).toBe(homedir());

    // An acpx record shaped exactly like acpx persists one, named for the session
    // the daemon actually launched.
    const recordName = resolved.transportSession;
    await writeFile(
      join(sessionsDir, `${encodeURIComponent(recordName)}.json`),
      JSON.stringify({
        schema: "acpx.session.v1",
        acpx_record_id: recordName,
        acp_session_id: "acp-1",
        agent_command: resolved.agentCommand,
        cwd: homedir(),
        closed: false,
        created_at: "2026-11-17T00:00:00.000Z",
        last_used_at: "2026-11-17T00:00:01.000Z",
        updated_at: "2026-11-17T00:00:01.000Z",
        last_seq: 1,
        name: recordName,
        messages: [
          { User: { id: "u-1", content: [{ Text: PROMPT }] } },
          { Agent: { content: [{ Text: "forked reply" }], tool_results: {} } },
        ],
      }),
      "utf8",
    );

    const history = await readTransportSessionHistory({
      transportSession: recordName,
      cwd: resolved.cwd,
      agentCommand: resolved.agentCommand,
      sessionsDir,
    });
    expect(history.map((message) => message.role)).toEqual(["user", "agent"]);

    // The recorded node digest is what a per-message fork resolves against.
    const node = {
      nodeId: "node-1",
      sessionId: "logical-1",
      sequence: 0,
      promptDigest: sessionForkPromptDigest(PROMPT),
      createdAt: "2026-11-17T00:00:00.000Z",
    };
    expect(resolveSessionForkNode({ history, nodes: [node], nodeId: node.nodeId })).toMatchObject({ ok: true });
  } finally {
    await rm(sessionsDir, { recursive: true, force: true });
  }
});
