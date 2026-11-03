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

/** The separator this platform does NOT use.
 *
 * The real mismatch is ConfigStore handing back `normalizePath` output (forward
 * slashes) while the marker keeps the `path.join`-native path: on Windows those
 * are two different strings for one directory. Writing the registry side with
 * the non-native separator reproduces that on every platform, so a raw string
 * compare fails on Linux and macOS too — where rewriting a backslash to "/" is a no-op
 * and the regression would go unguarded.
 */
function nonNativeSeparators(dir: string): string {
  return process.platform === "win32" ? dir.replace(/\\/g, "/") : dir.replace(/\//g, "\\");
}

test("a marker in native separators cleans up a registry entry in the other separator", async () => {
  const home = botsHome();
  const name = "Reviewer";
  const dir = join(home, name);
  mkdirSync(dir);
  const marker = { name, cwd: dir, createdAt: "2026-11-03T00:00:00.000Z" };
  const registryCwd = nonNativeSeparators(dir);
  // Guard the guard: if both sides were ever byte-identical again, this test
  // would pass without exercising the comparison at all.
  expect(registryCwd).not.toBe(dir);
  const workspaces = [{ name, cwd: registryCwd }];

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
    workspaces: [{ name, cwd: nonNativeSeparators(join(home, "elsewhere")) }],
    botsHomeRoot: home,
    references: EMPTY_REFERENCES,
  });
  expect(plan?.blocker).toMatchObject({ kind: "cwd_mismatch" });

  const outcome = await cleanupDedicatedWorkspace({
    marker,
    workspace: name,
    deps: {
      workspaces: { list: () => [{ name, cwd: nonNativeSeparators(join(home, "elsewhere")) }], remove: async () => {} },
      botsHomeRoot: home,
      references: () => EMPTY_REFERENCES,
    },
  });
  expect(outcome).toMatchObject({ outcome: "kept", code: "cwd_mismatch" });
  expect(existsSync(dir)).toBe(true);
});
