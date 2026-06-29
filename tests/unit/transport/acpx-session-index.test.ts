import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveSessionAgentCommandFromIndex } from "../../../src/transport/acpx-session-index";

describe("resolveSessionAgentCommandFromIndex", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempDir = await mkdir(join(tmpdir(), `acpx-session-index-${Date.now()}`), { recursive: true });
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createIndex(entries: Array<{ name?: string; cwd?: string; agentCommand?: string }>): Promise<void> {
    const sessionsDir = join(tempDir, ".acpx", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "index.json"), JSON.stringify({ entries }));
  }

  test("returns undefined when index file does not exist", async () => {
    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBeUndefined();
  });

  test("returns undefined when index file contains invalid JSON", async () => {
    const sessionsDir = join(tempDir, ".acpx", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "index.json"), "not valid json");

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBeUndefined();
  });

  test("returns undefined when index has no entries", async () => {
    await createIndex([]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBeUndefined();
  });

  test("returns agentCommand when exact session name and cwd match", async () => {
    await createIndex([
      { name: "ws:demo", cwd: "/home/user/project", agentCommand: "codex" },
    ]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBe("codex");
  });

  test("returns agentCommand when cwd path is resolved (normalized)", async () => {
    await createIndex([
      { name: "ws:demo", cwd: "/home/user/project/sub/../", agentCommand: "codex" },
    ]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBe("codex");
  });

  test("returns undefined when session name does not match", async () => {
    await createIndex([
      { name: "ws:other", cwd: "/home/user/project", agentCommand: "codex" },
    ]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBeUndefined();
  });

  test("returns undefined when cwd does not match", async () => {
    await createIndex([
      { name: "ws:demo", cwd: "/home/user/other", agentCommand: "codex" },
    ]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBeUndefined();
  });

  test("returns undefined when agentCommand is empty or whitespace", async () => {
    await createIndex([
      { name: "ws:demo", cwd: "/home/user/project", agentCommand: "" },
      { name: "ws:demo2", cwd: "/home/user/project", agentCommand: "   " },
    ]);

    expect(await resolveSessionAgentCommandFromIndex({ transportSession: "ws:demo", cwd: "/home/user/project" } as never)).toBeUndefined();
    expect(await resolveSessionAgentCommandFromIndex({ transportSession: "ws:demo2", cwd: "/home/user/project" } as never)).toBeUndefined();
  });

  test("returns undefined when HOME env is not set", async () => {
    delete process.env.HOME;

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBeUndefined();
  });

  test("matches first entry when multiple entries have same name but different cwd", async () => {
    await createIndex([
      { name: "ws:demo", cwd: "/home/user/project", agentCommand: "codex" },
      { name: "ws:demo", cwd: "/home/user/other", agentCommand: "claude" },
    ]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBe("codex");
  });

  test("trims agentCommand before returning", async () => {
    await createIndex([
      { name: "ws:demo", cwd: "/home/user/project", agentCommand: "  codex  " },
    ]);

    const session = { transportSession: "ws:demo", cwd: "/home/user/project" };
    expect(await resolveSessionAgentCommandFromIndex(session as never)).toBe("codex");
  });
});