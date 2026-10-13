import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSessionAgentCommandFromRecord } from "../../../src/transport/acpx-session-agent-command";
import type { ResolvedSession } from "../../../src/transport/types";

const CWD = "C:\\home\\user\\project";

describe("resolveSessionAgentCommandFromRecord", () => {
  let originalHome: string | undefined;
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempDir = await mkdir(join(tmpdir(), `acpx-session-record-${Date.now()}`), { recursive: true });
    sessionsDir = join(tempDir, ".acpx", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeRecord(record: Record<string, unknown>, file?: string): Promise<void> {
    const acpxRecordId = typeof record.acpx_record_id === "string" ? record.acpx_record_id : "rec";
    await writeFile(join(sessionsDir, file ?? `${encodeURIComponent(acpxRecordId)}.json`), JSON.stringify(record));
  }

  function session(transportSession: string, cwd = CWD): ResolvedSession {
    return { transportSession, cwd } as ResolvedSession;
  }

  test("resolves the agent command from a canonical record matching name and cwd", async () => {
    await writeRecord({
      schema: "acpx.session.v1",
      acpx_record_id: "rec-1",
      acp_session_id: "acp-1",
      agent_command: "codex",
      cwd: CWD,
      name: "ws:demo",
      created_at: "2026-10-01T00:00:00Z",
      last_used_at: "2026-10-02T00:00:00Z",
      last_seq: 3,
      updated_at: "2026-10-02T00:00:00Z",
      messages: [],
    });

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBe("codex");
  });

  test("returns undefined when no record matches the session name", async () => {
    await writeRecord({
      schema: "acpx.session.v1",
      acpx_record_id: "rec-1",
      acp_session_id: "acp-1",
      agent_command: "codex",
      cwd: CWD,
      name: "other-session",
      created_at: "2026-10-01T00:00:00Z",
      last_used_at: "2026-10-02T00:00:00Z",
      last_seq: 0,
      updated_at: "2026-10-02T00:00:00Z",
      messages: [],
    });

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBeUndefined();
  });

  test("returns undefined when the record cwd differs from the session cwd", async () => {
    await writeRecord({
      schema: "acpx.session.v1",
      acpx_record_id: "rec-1",
      acp_session_id: "acp-1",
      agent_command: "codex",
      cwd: "C:\\home\\user\\other",
      name: "ws:demo",
      created_at: "2026-10-01T00:00:00Z",
      last_used_at: "2026-10-02T00:00:00Z",
      last_seq: 0,
      updated_at: "2026-10-02T00:00:00Z",
      messages: [],
    });

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBeUndefined();
  });

  test("returns undefined when matching records disagree on the agent command", async () => {
    for (const [recordId, command] of [["rec-a", "codex"], ["rec-b", "opencode acp"]] as const) {
      await writeRecord({
        schema: "acpx.session.v1",
        acpx_record_id: recordId,
        acp_session_id: `acp-${recordId}`,
        agent_command: command,
        cwd: CWD,
        name: "ws:demo",
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: "2026-10-02T00:00:00Z",
        last_seq: 0,
        updated_at: "2026-10-02T00:00:00Z",
        messages: [],
      });
    }

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBeUndefined();
  });

  test("resolves when matching records agree on the agent command", async () => {
    for (const recordId of ["rec-a", "rec-b"]) {
      await writeRecord({
        schema: "acpx.session.v1",
        acpx_record_id: recordId,
        acp_session_id: `acp-${recordId}`,
        agent_command: "codex",
        cwd: CWD,
        name: "ws:demo",
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: "2026-10-02T00:00:00Z",
        last_seq: 0,
        updated_at: "2026-10-02T00:00:00Z",
        messages: [],
      });
    }

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBe("codex");
  });

  test("ignores records whose filename does not match the encoded record id", async () => {
    await writeRecord(
      {
        schema: "acpx.session.v1",
        acpx_record_id: "rec-1",
        acp_session_id: "acp-1",
        agent_command: "codex",
        cwd: CWD,
        name: "ws:demo",
        created_at: "2026-10-01T00:00:00Z",
        last_used_at: "2026-10-02T00:00:00Z",
        last_seq: 0,
        updated_at: "2026-10-02T00:00:00Z",
        messages: [],
      },
      "mismatched.json",
    );

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBeUndefined();
  });

  test("ignores records with invalid shape and the legacy index file", async () => {
    await writeRecord({ schema: "acpx.session.v1", acpx_record_id: "rec-1", name: "ws:demo" });
    await writeFile(join(sessionsDir, "index.json"), JSON.stringify({
      entries: [{ name: "ws:demo", cwd: CWD, agentCommand: "codex" }],
    }));

    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBeUndefined();
  });

  test("returns undefined when the sessions directory is missing", async () => {
    await rm(sessionsDir, { recursive: true, force: true });
    expect(await resolveSessionAgentCommandFromRecord(session("ws:demo"))).toBeUndefined();
  });
});
