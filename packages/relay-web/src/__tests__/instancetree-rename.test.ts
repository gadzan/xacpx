import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import InstanceTree from "../components/InstanceTree.vue";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";

const instance = (sessions: unknown[] = []) => ({
  id: "i1", name: "pc", online: true, lastSeenAt: null, sessions, sessionsLoaded: true,
  agents: [], workspaces: [], agentCatalog: [],
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("InstanceTree rename", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("renders displayName instead of alias when present", () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false, displayName: "API hotfix" }])] as never;
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
    expect(w.text()).toContain("API hotfix");
    expect(w.text()).not.toContain("backend");
  });

  it("opens an inline input from the menu and commits via renameSession on Enter", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const rename = vi.spyOn(store, "renameSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="action-rename"]').trigger("click");

    const input = w.find('[data-test="rename-input"]');
    expect(input.exists()).toBe(true);
    await input.setValue("API hotfix");
    await input.trigger("keydown.enter");

    expect(rename).toHaveBeenCalledWith("i1", "backend", "API hotfix");
  });

  it("shows the committed name while the rename RPC is still pending", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: true, archived: false, displayName: "old" }])] as never;
    const result = deferred<unknown>();
    vi.spyOn(api, "rpc").mockReturnValue(result.promise as never);
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="action-rename"]').trigger("click");
    const input = w.find('[data-test="rename-input"]');
    await input.setValue("API hotfix");
    await input.trigger("keydown.enter");

    expect(w.find('[data-test="rename-input"]').exists()).toBe(false);
    expect(w.find('[data-test="session-name"]').text()).toBe("API hotfix");

    result.resolve({ ok: true });
    await flushPromises();
  });

  it("cancels on Escape without calling renameSession", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const rename = vi.spyOn(store, "renameSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="action-rename"]').trigger("click");
    const input = w.find('[data-test="rename-input"]');
    await input.setValue("nope");
    await input.trigger("keydown.escape");

    expect(rename).not.toHaveBeenCalled();
    expect(w.find('[data-test="rename-input"]').exists()).toBe(false);
  });

  it("Enter then blur calls renameSession exactly once (double-commit guard)", async () => {
    const store = useInstancesStore();
    store.instances = [instance([{ alias: "backend", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }])] as never;
    const rename = vi.spyOn(store, "renameSession").mockResolvedValue();
    const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });

    await w.find('[data-test="session-menu"]').trigger("click");
    await w.find('[data-test="action-rename"]').trigger("click");
    const input = w.find('[data-test="rename-input"]');
    await input.setValue("API hotfix");
    await input.trigger("keydown.enter");
    await input.trigger("blur");

    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("i1", "backend", "API hotfix");
  });
});
