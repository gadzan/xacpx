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
});
