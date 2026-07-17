import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({ api: { rpc: (...args: unknown[]) => rpc(...args) } }));

import { useGitStore } from "../stores/git";

const status = (files: Array<{ path: string; status: string }> = []) => ({
  workspace: "project",
  branch: "main",
  detached: false,
  ahead: 0,
  behind: 0,
  worktree: { root: "/repo", linked: false },
  files,
  branches: [{ name: "main", current: true, worktreePath: "/repo" }],
  worktrees: [{ path: "/repo", branch: "main", current: true, linked: false }],
});

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

describe("Git store operation lifecycle", () => {
  it("keeps stage visibly in flight, then reloads authoritative status", async () => {
    let resolveStage!: (value: unknown) => void;
    rpc.mockImplementation((_id: string, type: string) => {
      if (type === "control.git.stage") return new Promise((resolve) => { resolveStage = resolve; });
      if (type === "control.git.status") return Promise.resolve(status([{ path: "a.ts", status: "M " }]));
      throw new Error(`unexpected ${type}`);
    });
    const store = useGitStore();

    const pending = store.stage("i1", "project", ["a.ts"]);
    expect(store.operation).toMatchObject({ kind: "stage" });
    expect(store.status).toBeNull();

    resolveStage({ ok: true });
    await pending;

    expect(rpc.mock.calls).toEqual([
      ["i1", "control.git.stage", { workspace: "project", paths: ["a.ts"] }],
      ["i1", "control.git.status", { workspace: "project" }],
    ]);
    expect(store.operation).toBeNull();
    expect(store.status?.files).toEqual([{ path: "a.ts", status: "M " }]);
    expect(store.lastResult).toMatchObject({ kind: "stage", ok: true });
  });

  it("rejects a second mutation while one is pending", async () => {
    let resolveFetch!: (value: unknown) => void;
    rpc.mockImplementation((_id: string, type: string) => {
      if (type === "control.git.fetch") return new Promise((resolve) => { resolveFetch = resolve; });
      if (type === "control.git.status") return Promise.resolve(status());
      throw new Error(`unexpected ${type}`);
    });
    const store = useGitStore();

    const first = store.fetch("i1", "project");
    await expect(store.pull("i1", "project")).rejects.toThrow("git-operation-in-progress");
    expect(rpc).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true });
    await first;
  });

  it("records an instance error and does not reload status", async () => {
    rpc.mockResolvedValue({ error: { code: "git-failed", message: "non-fast-forward" } });
    const store = useGitStore();

    await expect(store.pull("i1", "project")).rejects.toThrow("non-fast-forward");

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(store.operation).toBeNull();
    expect(store.error).toBe("non-fast-forward");
    expect(store.lastResult).toMatchObject({ kind: "pull", ok: false, message: "non-fast-forward" });
  });

  it("ignores an older status response after the workspace changes", async () => {
    let resolveOld!: (value: unknown) => void;
    rpc.mockImplementation((_id: string, _type: string, payload: { workspace: string }) => {
      if (payload.workspace === "old") return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve({ ...status(), workspace: "new", branch: "feature" });
    });
    const store = useGitStore();

    const oldLoad = store.load("i1", "old");
    await store.load("i1", "new");
    resolveOld({ ...status(), workspace: "old", branch: "stale" });
    await oldLoad;

    expect(store.status).toMatchObject({ workspace: "new", branch: "feature" });
  });

  it("does not reload an old workspace when its mutation finishes after a context switch", async () => {
    let resolveOldStage!: (value: unknown) => void;
    rpc.mockImplementation((_id: string, type: string, payload: { workspace: string }) => {
      if (type === "control.git.stage") return new Promise((resolve) => { resolveOldStage = resolve; });
      if (type === "control.git.status" && payload.workspace === "new") {
        return Promise.resolve({ ...status(), workspace: "new", branch: "feature" });
      }
      if (type === "control.git.status") return Promise.resolve({ ...status(), workspace: payload.workspace });
      throw new Error(`unexpected ${type}`);
    });
    const store = useGitStore();
    await store.load("i1", "old");

    const oldStage = store.stage("i1", "old", ["a.ts"]);
    await store.load("i1", "new");
    resolveOldStage({ ok: true });
    await oldStage;

    expect(store.status).toMatchObject({ workspace: "new", branch: "feature" });
    expect(rpc.mock.calls.filter((call) => call[1] === "control.git.status").map((call) => call[2])).toEqual([
      { workspace: "old" },
      { workspace: "new" },
    ]);
  });

  it("does not let an old mutation clear the new workspace operation lifecycle", async () => {
    let resolveOldStage!: (value: unknown) => void;
    let resolveNewFetch!: (value: unknown) => void;
    rpc.mockImplementation((_id: string, type: string, payload: { workspace: string }) => {
      if (type === "control.git.stage") return new Promise((resolve) => { resolveOldStage = resolve; });
      if (type === "control.git.fetch") return new Promise((resolve) => { resolveNewFetch = resolve; });
      if (type === "control.git.status") return Promise.resolve({ ...status(), workspace: payload.workspace });
      throw new Error(`unexpected ${type}`);
    });
    const store = useGitStore();
    await store.load("i1", "old");
    const oldStage = store.stage("i1", "old", ["a.ts"]);

    store.reset();
    await store.load("i1", "new");
    const newFetch = store.fetch("i1", "new");
    expect(store.operation).toMatchObject({ kind: "fetch" });

    resolveOldStage({ ok: true });
    await oldStage;
    expect(store.operation).toMatchObject({ kind: "fetch" });
    expect(store.lastResult).toBeNull();

    resolveNewFetch({ ok: true });
    await newFetch;
    expect(store.operation).toBeNull();
    expect(store.lastResult).toMatchObject({ kind: "fetch", ok: true });
  });

  it("returns the registered workspace created for a managed worktree", async () => {
    rpc.mockImplementation((_id: string, type: string) => {
      if (type === "control.git.worktree.create") {
        return Promise.resolve({ workspace: { name: "project-feature", cwd: "/managed/feature" }, branch: "feature" });
      }
      if (type === "control.git.status") return Promise.resolve(status());
      throw new Error(`unexpected ${type}`);
    });
    const store = useGitStore();

    const result = await store.createWorktree("i1", "project", {
      workspaceName: "project-feature",
      branch: "feature",
      createBranch: true,
      startPoint: "main",
    });

    expect(result).toMatchObject({ workspace: { name: "project-feature", cwd: "/managed/feature" }, branch: "feature" });
    expect(rpc.mock.calls[0]).toEqual([
      "i1",
      "control.git.worktree.create",
      { workspace: "project", workspaceName: "project-feature", branch: "feature", createBranch: true, startPoint: "main" },
    ]);
  });
});
