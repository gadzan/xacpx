import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn().mockResolvedValue({ workspaces: [], entries: [], path: "" });
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (...a: unknown[]) => rpc(...a) },
}));

import FilesPanel from "../components/FilesPanel.vue";
import { useFilesStore } from "../stores/files";
import { useInstancesStore } from "../stores/instances";
import { useChatStore } from "../stores/chat";

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  rpc.mockClear();
});

describe("FilesPanel navigation rail", () => {
  it("follows the active session's workspace and shows it as a static label (no picker)", async () => {
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [{ alias: "s1", agent: "codex", workspace: "backend" }],
      agents: [], workspaces: [{ name: "backend", cwd: "/b" }], agentCatalog: [],
    }] as never;
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    await flushPromises();
    // No manual workspace dropdown any more — it's a static label tied to the session.
    expect(w.find('[data-test="ws-select"]').exists()).toBe(false);
    const label = w.find('[data-test="ws-label"]');
    expect(label.exists()).toBe(true);
    expect(label.text()).toContain("backend");
  });

  it("badges directory entries with git status", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.path = "";
    files.entries = [
      { name: "src", type: "dir" },
      { name: "clean.ts", type: "file", size: 1 },
      { name: "new.ts", type: "file", size: 1 },
    ];
    files.changed = { "src/a.ts": " M", "new.ts": "??" };
    await w.vm.$nextTick();
    const badges = w.findAll('[data-test="fs-status"]');
    // src (dir, nested change) + new.ts (untracked) badge; clean.ts has none.
    expect(badges.length).toBe(2);
    const titles = badges.map((b) => b.attributes("title"));
    expect(titles.some((t) => t?.startsWith("•"))).toBe(true); // src directory contains a change
    expect(titles.some((t) => t?.startsWith("U"))).toBe(true); // new.ts is untracked
    expect(badges.every((b) => b.classes().includes("bg-warn"))).toBe(true);
  });

  it("opening a directory entry that is a file routes it to the center viewer (clears any diff)", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.diffPath = "old/diff.ts"; // a stale diff selection
    files.entries = [{ name: "a.ts", type: "file", size: 1 }];
    await w.vm.$nextTick();
    await w.find('[data-test="fs-entry"]').trigger("click");
    // The diff selection is cleared so the center shows the freshly opened file, not a mix.
    expect(files.diffPath).toBeNull();
  });

  it("up button is disabled at the workspace root and goes up one level from a nested dir", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const up = vi.spyOn(files, "up").mockImplementation(() => {});

    // At the root: no path segments → the button is present but disabled.
    files.path = "";
    await w.vm.$nextTick();
    const btnRoot = w.find('[data-test="fs-up"]');
    expect(btnRoot.exists()).toBe(true);
    expect(btnRoot.attributes("disabled")).toBeDefined();
    await btnRoot.trigger("click");
    expect(up).not.toHaveBeenCalled();

    // Two levels deep (src/lib): up one level keeps the first segment → up(0) ("src").
    files.path = "src/lib";
    await w.vm.$nextTick();
    const btn = w.find('[data-test="fs-up"]');
    expect(btn.attributes("disabled")).toBeUndefined();
    await btn.trigger("click");
    expect(up).toHaveBeenCalledWith(0);
  });

  it("has a refresh button that re-fetches the current view via the store", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    const spy = vi.spyOn(files, "refresh").mockResolvedValue();
    await w.vm.$nextTick();
    const btn = w.find('[data-test="refresh-files"]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("aria-label")).toBeTruthy();
    expect(btn.attributes("title")).toBeTruthy();
    await btn.trigger("click");
    expect(spy).toHaveBeenCalled();
  });

  it("shows the branch, worktree path, and a linked badge in the Changes tab git context", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws", files: [{ path: "a.ts", status: " M" }], diff: "+x\n-y\n", truncated: false,
      branch: "feature", worktree: { root: "/Users/dev/.worktrees/feature", linked: true },
    } as never;
    await w.vm.$nextTick();
    expect(w.find('[data-test="changes-branch"]').text()).toBe("feature");
    expect(w.find('[data-test="worktree-linked"]').exists()).toBe(true);
    expect(w.find('[data-test="worktree-path"]').text()).toContain("/Users/dev/.worktrees/feature");
  });

  it("falls back to a detached label and hides the linked badge on the primary worktree", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws", files: [], diff: "", truncated: false,
      detached: true, worktree: { root: "/repo", linked: false },
    } as never;
    await w.vm.$nextTick();
    expect(w.find('[data-test="changes-branch"]').text()).toBeTruthy(); // a detached label, not a branch
    expect(w.find('[data-test="worktree-linked"]').exists()).toBe(false);
    expect(w.find('[data-test="worktree-path"]').exists()).toBe(true);
  });

  it("shows a calm empty state (not a dismiss-less error banner) for a non-git workspace's Changes tab", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.notGit = true; // backend reported "not-a-git-repo"
    await w.vm.$nextTick();
    expect(w.find('[data-test="changes-not-git"]').exists()).toBe(true);
    // The sticky, undismissable error banner must NOT be used for this expected state.
    expect(w.find('[data-test="files-error"]').exists()).toBe(false);
  });

  it("groups changed files into Staged / Changes / Untracked with full-path tooltips", async () => {
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    const files = useFilesStore();
    files.tab = "changes";
    files.diff = {
      workspace: "ws",
      files: [
        { path: "src/staged.ts", status: "M " },
        { path: "src/work.ts", status: " M" },
        { path: "notes/草稿.md", status: "??" },
      ],
      diff: "",
      truncated: false,
    } as never;
    await w.vm.$nextTick();
    const groups = w.findAll('[data-test="change-group"]');
    expect(groups.length).toBe(3); // staged, changes, untracked all non-empty
    const rows = w.findAll('[data-test="diff-file"]');
    // the untracked CJK path renders raw and carries a full-path tooltip
    const cjk = rows.find((r) => r.attributes("title") === "notes/草稿.md");
    expect(cjk).toBeTruthy();
    expect(cjk!.text()).toContain("草稿.md");
  });

  it("auto-loads the diff when switching sessions while the Changes tab is active", async () => {
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [
        { alias: "s1", agent: "codex", workspace: "backend" },
        { alias: "s2", agent: "codex", workspace: "frontend" },
      ],
      agents: [], workspaces: [{ name: "backend", cwd: "/b" }, { name: "frontend", cwd: "/f" }], agentCatalog: [],
    }] as never;
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    await flushPromises();

    const files = useFilesStore();
    // Changes tab already active with a diff loaded — so the tab watcher's `!files.diff`
    // guard would NOT fire on its own; only the session-switch path should reload.
    files.tab = "changes";
    files.diff = { workspace: "backend", files: [], diff: "", truncated: false } as never;
    await flushPromises();

    const loadDiff = vi.spyOn(files, "loadDiff").mockResolvedValue();
    // Switch to a session in a different workspace while the Changes tab stays active.
    chat.sessionAlias = "s2";
    await flushPromises();

    expect(loadDiff).toHaveBeenCalled();
  });

  it("does not auto-load the diff on a session switch when the Files tab is active", async () => {
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
      sessions: [
        { alias: "s1", agent: "codex", workspace: "backend" },
        { alias: "s2", agent: "codex", workspace: "frontend" },
      ],
      agents: [], workspaces: [{ name: "backend", cwd: "/b" }, { name: "frontend", cwd: "/f" }], agentCatalog: [],
    }] as never;
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(FilesPanel, { props: { instanceId: "i1" }, global: { plugins: [pinia] } });
    await flushPromises();

    const files = useFilesStore();
    files.tab = "files";
    const loadDiff = vi.spyOn(files, "loadDiff").mockResolvedValue();
    chat.sessionAlias = "s2";
    await flushPromises();

    expect(loadDiff).not.toHaveBeenCalled();
  });
});
