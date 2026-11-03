import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { cleanupDedicatedWorkspace, evaluateDedicatedWorkspaceCleanup, type DedicatedWorkspaceReferences } from "../../../src/bots/dedicated-workspace-cleanup";

const EMPTY_REFERENCES: DedicatedWorkspaceReferences = {
  bots: [],
  sessions: [],
  topics: [],
  scheduledTasks: [],
  worktrees: [],
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function botsHome(): string {
  const root = mkdtempSync(join(tmpdir(), "xacpx-cleanup-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "bots");
  mkdirSync(home, { recursive: true });
  return home;
}

/** The shape `ConfigStore` hands back: forward slashes, via `normalizePath`. */
function registeredCwd(home: string, name: string): string {
  return join(home, name).replace(/\\/g, "/");
}

test("a native-separator marker cleans up the registry's normalized entry", async () => {
  const home = botsHome();
  const name = "Reviewer";
  const dir = join(home, name);
  mkdirSync(dir);
  const marker = { name, cwd: dir, createdAt: "2026-11-03T00:00:00.000Z" };
  const workspaces = [{ name, cwd: registeredCwd(home, name) }];

  // Preview path: the dialog renders `inUse` from this plan, so a separator
  // mismatch would hide the delete-workspace checkbox on Windows.
  const plan = await evaluateDedicatedWorkspaceCleanup({
    marker,
    workspace: name,
    workspaces,
    botsHomeRoot: home,
    references: EMPTY_REFERENCES,
  });
  expect(plan?.blocker).toBeNull();

  // Removal path: the same predicate decides whether the directory and the
  // `dedicated: true` row go away.
  const removed: string[] = [];
  const outcome = await cleanupDedicatedWorkspace({
    marker,
    workspace: name,
    deps: {
      workspaces: {
        list: () => workspaces,
        remove: async (workspaceName) => { removed.push(workspaceName); },
      },
      botsHomeRoot: home,
      references: () => EMPTY_REFERENCES,
    },
  });
  expect(outcome?.outcome).toBe("deleted");
  expect(removed).toEqual([name]);
  expect(existsSync(dir)).toBe(false);
});

test("a registry entry that points elsewhere still blocks the cleanup", async () => {
  const home = botsHome();
  const name = "Reviewer";
  const dir = join(home, name);
  mkdirSync(dir);
  const marker = { name, cwd: dir, createdAt: "2026-11-03T00:00:00.000Z" };

  const plan = await evaluateDedicatedWorkspaceCleanup({
    marker,
    workspace: name,
    workspaces: [{ name, cwd: join(home, "elsewhere").replace(/\\/g, "/") }],
    botsHomeRoot: home,
    references: EMPTY_REFERENCES,
  });
  expect(plan?.blocker).toMatchObject({ kind: "cwd_mismatch" });

  const outcome = await cleanupDedicatedWorkspace({
    marker,
    workspace: name,
    deps: {
      workspaces: { list: () => [{ name, cwd: join(home, "elsewhere") }], remove: async () => {} },
      botsHomeRoot: home,
      references: () => EMPTY_REFERENCES,
    },
  });
  expect(outcome).toMatchObject({ outcome: "kept", code: "cwd_mismatch" });
  expect(existsSync(dir)).toBe(true);
});
