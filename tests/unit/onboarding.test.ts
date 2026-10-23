import { expect, test } from "bun:test";
import type { AppConfig } from "../../src/config/types";
import { createEmptyState } from "../../src/state/types";
import { t } from "../../src/i18n";
import { isFirstUse, maybeRunFirstUseOnboarding } from "../../src/onboarding";

function config(): AppConfig {
  return {
    transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1, maxFiles: 1, retentionDays: 1 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [],
    plugins: [],
    agents: {},
    workspaces: {},
    orchestration: { maxPendingAgentRequestsPerCoordinator: 1, allowWorkerChainedRequests: false, allowedAgentRequestTargets: [], allowedAgentRequestRoles: [], progressHeartbeatSeconds: 0 },
  };
}

test("isFirstUse treats a config carrying only the seeded home workspace as first use", () => {
  const cfg = config();
  cfg.workspaces = { home: { cwd: "/Users/test" } };
  expect(isFirstUse(cfg, createEmptyState())).toBe(true);
});

test("isFirstUse is false once a non-default workspace exists", () => {
  const cfg = config();
  cfg.workspaces = { home: { cwd: "/Users/test" }, myrepo: { cwd: "/tmp/myrepo" } };
  expect(isFirstUse(cfg, createEmptyState())).toBe(false);
});

test("interactive onboarding still fires when only the seeded home workspace is present", async () => {
  const cfg = config();
  cfg.workspaces = { home: { cwd: "/Users/test" } };
  const state = createEmptyState();
  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state,
    saveFirstRunConfig: async () => {},
    deps: {
      cwd: () => "/tmp/myrepo",
      print: () => {},
      isInteractive: () => true,
      promptText: async () => "",
    },
  });

  expect(result).toMatchObject({ created: true, workspace: "myrepo", alias: "myrepo:codex" });
  // The seeded home workspace and the onboarding-created project workspace coexist.
  expect(Object.keys(cfg.workspaces).sort()).toEqual(["home", "myrepo"]);
});

test("first-use onboarding creates current directory workspace and initial session", async () => {
  const cfg = config();
  const state = createEmptyState();
  const answers = ["", "1"];
  const savedEntries: unknown[] = [];
  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state,
    saveFirstRunConfig: async (entries) => {
      savedEntries.push(entries);
    },
    deps: {
      cwd: () => "/tmp/myrepo",
      print: () => {},
      isInteractive: () => true,
      promptText: async () => answers.shift() ?? "",
    },
  });

  expect(result.created).toBe(true);
  expect(cfg.workspaces.myrepo.cwd).toBe("/tmp/myrepo");
  // Persists only the created entries (targeted patches), never a whole config.
  expect(savedEntries).toEqual([
    {
      workspace: { name: "myrepo", cwd: "/tmp/myrepo" },
      agent: { name: "codex", config: { driver: "codex" } },
    },
  ]);
  expect(result).toMatchObject({
    created: true,
    alias: "myrepo:codex",
    agent: "codex",
    workspace: "myrepo",
    workspaceCwd: "/tmp/myrepo",
    rollback: { workspaceExisted: false, agentExisted: false },
  });
  expect(state.sessions["myrepo:codex"]).toBeUndefined();
});

test("first-use onboarding returns the normalized workspace cwd for rollback", async () => {
  const cfg = config();
  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state: createEmptyState(),
    saveFirstRunConfig: async () => {},
    deps: {
      cwd: () => "/tmp/myrepo",
      print: () => {},
      isInteractive: () => true,
      promptText: async () => "",
    },
  });

  expect(result).toMatchObject({
    created: true,
    workspace: "myrepo",
    // Rollback passes this cwd as removeWorkspace's expectedCwd so a
    // concurrently registered same-name workspace is never deleted.
    workspaceCwd: "/tmp/myrepo",
    rollback: { workspaceExisted: false },
  });
});

test("first-use onboarding skips non-interactive mode", async () => {
  const cfg = config();
  const state = createEmptyState();
  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state,
    saveFirstRunConfig: async () => { throw new Error("should not save"); },
    deps: { cwd: () => "/tmp/myrepo", print: () => {}, isInteractive: () => false, promptText: async () => "" },
  });

  expect(result.created).toBe(false);
  expect(Object.keys(cfg.workspaces)).toEqual([]);
});

test("first-use onboarding sanitizes workspace names for session aliases", async () => {
  const cfg = config();
  const state = createEmptyState();
  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state,
    saveFirstRunConfig: async () => {},
    deps: {
      cwd: () => "/tmp/my repo!",
      print: () => {},
      isInteractive: () => true,
      promptText: async () => "",
    },
  });

  expect(result).toMatchObject({ created: true, workspace: "my-repo", alias: "my-repo:codex" });
});

test("first-use onboarding is skipped with a notice when the cwd name has no letters or digits", async () => {
  const cfg = config();
  const lines: string[] = [];
  let prompted = false;
  let saved = false;
  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state: createEmptyState(),
    saveFirstRunConfig: async () => {
      saved = true;
    },
    deps: {
      cwd: () => "/tmp/!!!",
      print: (line) => lines.push(line),
      isInteractive: () => true,
      promptText: async () => {
        prompted = true;
        return "";
      },
    },
  });

  expect(result).toEqual({ created: false });
  expect(lines).toEqual([t().misc.onboardingWorkspaceNameUnderivable("/tmp/!!!")]);
  expect(prompted).toBe(false);
  expect(saved).toBe(false);
  expect(cfg.workspaces).toEqual({});
});

test("first-use onboarding records rollback metadata for existing agents", async () => {
  const cfg = config();
  cfg.agents.codex = { driver: "codex" };
  const state = createEmptyState();

  const result = await maybeRunFirstUseOnboarding({
    config: cfg,
    state,
    saveFirstRunConfig: async () => {},
    deps: {
      cwd: () => "/tmp/myrepo",
      print: () => {},
      isInteractive: () => true,
      promptText: async () => "",
    },
  });

  expect(result).toMatchObject({
    created: true,
    rollback: { workspaceExisted: false, agentExisted: true },
  });
});
