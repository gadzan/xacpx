import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlService } from "../../../src/control/control-service";

const cleanups: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "control-git-"));
  cleanups.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test User");
  writeFileSync(join(root, "README.md"), "initial\n");
  git("add", "README.md");
  git("commit", "-qm", "initial");
  return root;
}

function service(
  root: string,
  writeEnabled: boolean,
  created: Array<{ name: string; cwd: string }> = [],
  options: { managedRoot?: string; failCreate?: boolean } = {},
): ControlService {
  return new ControlService({
    workspaces: {
      list: () => [{ name: "project", cwd: root }, ...created],
      create: async (name: string, cwd: string) => {
        if (options.failCreate) throw new Error("config-write-failed");
        created.push({ name, cwd });
        return { name, cwd };
      },
    },
    filesWriteEnabled: () => writeEnabled,
    gitWorktreesRoot: options.managedRoot,
    events: {
      emit() {},
      subscribe() {
        return () => {};
      },
    },
  } as never);
}

afterEach(() => {
  for (const path of cleanups.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("ControlService Git gate", () => {
  test("status remains readable while index mutations require files.writeEnabled", async () => {
    const root = repo();
    writeFileSync(join(root, "new.txt"), "new\n");
    const control = service(root, false);

    expect(await control.workspaceGitStatus("project")).toMatchObject({
      workspace: "project",
      branch: "main",
    });
    await expect(control.gitStage("project", ["new.txt"])).rejects.toThrow(
      "files-write-disabled",
    );
  });

  test("all Git mutations share the same disabled-by-default gate", async () => {
    const control = service(repo(), false);
    const attempts = [
      control.gitUnstage("project", ["README.md"]),
      control.gitUntrack("project", ["README.md"]),
      control.gitDiscard("project", ["README.md"]),
      control.gitCommit("project", "test"),
      control.gitFetch("project"),
      control.gitPull("project"),
      control.gitPush("project"),
      control.gitCheckout("project", { branch: "main" }),
      control.gitCreateWorktree("project", {
        workspaceName: "project-feature",
        branch: "feature",
        createBranch: true,
      }),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toThrow("files-write-disabled");
    }
  });
});

describe("ControlService Git worktree registration", () => {
  test("serializes the name check through registration for concurrent creates", async () => {
    const root = repo();
    const managedRoot = mkdtempSync(join(tmpdir(), "control-git-managed-"));
    cleanups.push(managedRoot);
    const created: Array<{ name: string; cwd: string }> = [];
    const control = service(root, true, created, { managedRoot });
    const input = {
      workspaceName: "project-feature",
      branch: "feature/concurrent",
      createBranch: true,
      startPoint: "main",
    };

    const results = await Promise.allSettled([
      control.gitCreateWorktree("project", input),
      control.gitCreateWorktree("project", input),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toBe("workspace-name-exists");
    expect(created).toHaveLength(1);
    expect(
      (await control.workspaceGitStatus("project")).worktrees,
    ).toHaveLength(2);
  });

  test("registers a created worktree as a configured workspace", async () => {
    const root = repo();
    const managedRoot = mkdtempSync(join(tmpdir(), "control-git-managed-"));
    cleanups.push(managedRoot);
    const created: Array<{ name: string; cwd: string }> = [];
    const control = service(root, true, created, { managedRoot });

    const result = await control.gitCreateWorktree("project", {
      workspaceName: "project-feature",
      branch: "feature/worktree",
      createBranch: true,
      startPoint: "main",
    });

    expect(created).toEqual([
      { name: "project-feature", cwd: result.worktree.path },
    ]);
    expect(result).toMatchObject({
      worktree: { branch: "feature/worktree", linked: true },
      workspace: { name: "project-feature", cwd: result.worktree.path },
    });
  });

  test("rolls back the Git worktree when workspace registration fails", async () => {
    const root = repo();
    const managedRoot = mkdtempSync(join(tmpdir(), "control-git-managed-"));
    cleanups.push(managedRoot);
    const control = service(root, true, [], { managedRoot, failCreate: true });

    await expect(
      control.gitCreateWorktree("project", {
        workspaceName: "project-feature",
        branch: "feature/worktree",
        createBranch: true,
        startPoint: "main",
      }),
    ).rejects.toThrow("config-write-failed");

    expect(
      (await control.workspaceGitStatus("project")).worktrees,
    ).toHaveLength(1);
  });
});
