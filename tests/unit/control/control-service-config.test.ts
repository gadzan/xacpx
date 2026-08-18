import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";

function makeDeps(sessions: Array<{ agent: string; workspace: string }> = []) {
  const created: Array<{ name: string; cwd: string; description?: string }> =
    [];
  const calls: string[] = [];
  const deps = {
    sessions: {
      listAllResolvedSessions: () => sessions,
    },
    agents: {
      list: () => [
        { name: "codex", driver: "codex" },
        { name: "claude", driver: "claude" },
      ],
      catalog: () => [
        { driver: "codex", configured: true, installed: "builtin" as const },
      ],
      create: async (name: string, driver: string) => {
        calls.push(`create:${name}:${driver}`);
        return { name, driver };
      },
      remove: async (name: string) => {
        calls.push(`remove:${name}`);
      },
    },
    workspaces: {
      list: () => [{ name: "home", cwd: "/Users/me", description: "home dir" }],
      create: async (name: string, cwd: string, description?: string) => {
        created.push({ name, cwd, description });
        return { name, cwd, ...(description ? { description } : {}) };
      },
      remove: async (name: string) => {
        calls.push(`wsremove:${name}`);
      },
    },
    events: { emit: () => {} },
  };
  return { deps, created, calls };
}

test("listAgents returns configured agents", () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  expect(control.listAgents()).toEqual([
    { name: "codex", driver: "codex" },
    { name: "claude", driver: "claude" },
  ]);
});

test("listWorkspaces returns configured workspaces", () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  expect(control.listWorkspaces()).toEqual([
    { name: "home", cwd: "/Users/me", description: "home dir" },
  ]);
});

test("createWorkspace persists via the workspace creator and returns the dto", async () => {
  const { deps, created } = makeDeps();
  const control = new ControlService(deps as never);
  const result = await control.createWorkspace(
    "backend",
    "/srv/backend",
    "api",
  );
  expect(result).toEqual({
    name: "backend",
    cwd: "/srv/backend",
    description: "api",
  });
  expect(created).toEqual([
    { name: "backend", cwd: "/srv/backend", description: "api" },
  ]);
});

test("createWorkspace works without a description", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const result = await control.createWorkspace("scratch", "/tmp/scratch");
  expect(result).toEqual({ name: "scratch", cwd: "/tmp/scratch" });
});

test("listAgentCatalog delegates to the agents.catalog dep", () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  expect(control.listAgentCatalog()).toEqual([
    { driver: "codex", configured: true, installed: "builtin" },
  ]);
});

test("createAgent delegates to agents.create", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  const created = await control.createAgent("gemini", "gemini");
  expect(created).toEqual({ name: "gemini", driver: "gemini" });
  expect(calls).toContain("create:gemini:gemini");
});

test("removeAgent rejects when a session uses the agent", async () => {
  const { deps, calls } = makeDeps([{ agent: "codex", workspace: "w" }]);
  const control = new ControlService(deps as never);
  await expect(control.removeAgent("codex")).rejects.toThrow(/in use/);
  expect(calls).not.toContain("remove:codex");
});

test("removeAgent succeeds when no session uses the agent", async () => {
  const { deps, calls } = makeDeps([{ agent: "claude", workspace: "w" }]);
  const control = new ControlService(deps as never);
  await control.removeAgent("codex");
  expect(calls).toContain("remove:codex");
});

test("removeWorkspace rejects when a session uses the workspace", async () => {
  const { deps } = makeDeps([{ agent: "codex", workspace: "backend" }]);
  const control = new ControlService(deps as never);
  await expect(control.removeWorkspace("backend")).rejects.toThrow(/in use/);
});
