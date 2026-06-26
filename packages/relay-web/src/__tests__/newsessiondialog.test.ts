import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import NewSessionDialog from "../components/NewSessionDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { i18n } from "../i18n";

interface DialogOptions {
  agents?: Array<{ name: string; driver: string }>;
  workspaces?: Array<{ name: string; cwd: string; description?: string }>;
  agentCatalog?: Array<{ driver: string; configured: boolean; installed: "builtin" | "yes" | "unknown" }>;
  sessions?: Array<{ alias: string }>;
  nativeSessions?: Array<{ sessionId: string; title?: string | null; updatedAt?: string; cwd?: string }>;
  modelSuggestions?: string[];
}

function mountDialog(opts: DialogOptions = {}) {
  const store = useInstancesStore();
  store.instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null,
    sessions: opts.sessions ?? [],
    agents: opts.agents ?? [{ name: "codex", driver: "codex" }],
    workspaces: opts.workspaces ?? [{ name: "home", cwd: "/Users/me" }],
    agentCatalog: opts.agentCatalog ?? [{ driver: "codex", configured: true, installed: "builtin" }],
  }] as never;
  vi.spyOn(store, "loadFormOptions").mockResolvedValue();
  vi.spyOn(store, "createAgent").mockResolvedValue(undefined as never);
  vi.spyOn(store, "createWorkspace").mockResolvedValue({ name: "ws", cwd: "/ws" } as never);
  vi.spyOn(store, "createSession").mockResolvedValue({ pending: false });
  // The dialog submits via the optimistic background path, not createSession directly.
  vi.spyOn(store, "beginSessionCreation").mockImplementation(() => {});
  vi.spyOn(store, "listNativeSessions").mockResolvedValue(opts.nativeSessions ?? []);
  vi.spyOn(store, "listModelSuggestions").mockResolvedValue(opts.modelSuggestions ?? []);
  // Stub <Teleport> so the dialog renders in-place and wrapper.find() reaches it
  // (in the app it teleports to body to escape the mobile drawer's transform).
  const wrapper = mount(NewSessionDialog, {
    props: { instanceId: "i1", instanceName: "pc" },
    global: { stubs: { teleport: true } },
  });
  return { wrapper, store };
}

// The Agent/Workspace pickers are custom SelectMenu dropdowns (button + list), not native
// <select>s — open the trigger then click the option by its data-value.
async function pick(wrapper: ReturnType<typeof mountDialog>["wrapper"], trigger: string, value: string) {
  await wrapper.get(`[data-test="${trigger}"]`).trigger("click");
  await wrapper.get(`[data-value="${value}"]`).trigger("mousedown");
}

describe("NewSessionDialog", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("blank alias is auto-generated from workspace + agent and de-duped", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [{ alias: "backend-codex" }],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-codex-2", "codex", "backend", undefined, undefined);
  });

  it("selecting an un-configured driver auto-creates the agent before the session", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [
        { driver: "codex", configured: true, installed: "builtin" },
        { driver: "gemini", configured: false, installed: "yes" },
      ],
      sessions: [],
    });
    await flushPromises();
    await pick(wrapper, "ns-agent", "gemini");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.createAgent).toHaveBeenCalledWith("i1", "gemini", "gemini");
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-gemini", "gemini", "backend", undefined, undefined);
  });

  it("New-path workspace mode auto-creates a workspace from the path basename", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-ws-mode-path"]').trigger("click");
    await wrapper.get('[data-test="ns-ws-path"]').setValue("/tmp/demo-project");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.createWorkspace).toHaveBeenCalledWith("i1", "demo-project", "/tmp/demo-project");
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "demo-project-codex", "codex", "demo-project", undefined, undefined);
  });

  it("an un-installed (unknown) driver is shown but disabled in the agent picker", async () => {
    const { wrapper } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [
        { driver: "codex", configured: true, installed: "builtin" },
        { driver: "qwen", configured: false, installed: "unknown" },
      ],
      sessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-agent"]').trigger("click");
    const opt = wrapper.find('[data-value="qwen"]');
    expect(opt.exists()).toBe(true);
    expect(opt.classes()).toContain("cursor-not-allowed");
    // Clicking a disabled option must not select it.
    await opt.trigger("mousedown");
    expect(wrapper.find('[data-value="qwen"]').exists()).toBe(true); // menu stays open
  });

  it("New-path mode with an all-symbols path shows an error and does not create a session", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-ws-mode-path"]').trigger("click");
    await wrapper.get('[data-test="ns-ws-path"]').setValue("@@@");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="ns-error"]').exists()).toBe(true);
    expect(store.beginSessionCreation).not.toHaveBeenCalled();
  });

  it("does not create an agent when an all-symbols path yields an empty name (guard precedes createAgent)", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [],
      agentCatalog: [
        { driver: "codex", configured: true, installed: "builtin" },
        { driver: "gemini", configured: false, installed: "yes" },
      ],
      sessions: [],
    });
    await flushPromises();
    await pick(wrapper, "ns-agent", "gemini");
    await wrapper.get('[data-test="ns-ws-mode-path"]').trigger("click");
    await wrapper.get('[data-test="ns-ws-path"]').setValue("@@@");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="ns-error"]').exists()).toBe(true);
    expect(store.createAgent).not.toHaveBeenCalled();
    expect(store.createWorkspace).not.toHaveBeenCalled();
    expect(store.beginSessionCreation).not.toHaveBeenCalled();
  });

  it("emits the resolved auto-generated alias immediately on create when alias was blank", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    await flushPromises();
    // leave alias blank → auto-generated "backend-codex"
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    // Optimistic: creation kicks off in the background and the dialog emits + closes at
    // once — no blocking in-dialog pending notice.
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-codex", "codex", "backend", undefined, undefined);
    expect(wrapper.emitted("created")?.[0]).toEqual(["backend-codex"]);
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("forwards a chosen model override on create", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-model"]').setValue("gpt-5.2[high]");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-codex", "codex", "backend", undefined, "gpt-5.2[high]");
  });

  it("opens the themed model dropdown and forwards a clicked suggestion", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
      modelSuggestions: ["gpt-5.2[high]", "gpt-5.2[low]"],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-model"]').trigger("focus");
    const list = wrapper.find('[data-test="ns-model-list"]');
    expect(list.exists()).toBe(true);
    // "default" is always offered first, then the suggestions.
    const items = list.findAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].text()).toContain("default");
    expect(items[1].text()).toBe("gpt-5.2[high]");
    expect(items[2].text()).toBe("gpt-5.2[low]");
    await items[1].trigger("mousedown");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-codex", "codex", "backend", undefined, "gpt-5.2[high]");
  });

  it("treats a literal \"default\" (or blank) model as the agent default — no override sent", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-model"]').setValue("  Default  ");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-codex", "codex", "backend", undefined, undefined);
  });

  it("native source lists the agent's rollouts and attaches the chosen one by agentSessionId", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
      nativeSessions: [{ sessionId: "ses_99", title: "Prior work", updatedAt: "2026-06-10T00:00:00Z", cwd: "/b" }],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-source-native"]').trigger("click");
    await flushPromises();
    // The native list is queried for the chosen agent + workspace, and the picker shows.
    expect(store.listNativeSessions).toHaveBeenCalledWith("i1", "codex", "backend");
    expect(wrapper.find('[data-test="ns-native"]').exists()).toBe(true);
    // Creating now resumes the (preselected) native session via its agentSessionId.
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend-codex", "codex", "backend", "ses_99");
  });

  it("native source with no rollouts shows an empty hint and blocks create", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
      nativeSessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-source-native"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="ns-native-empty"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="ns-create"]').attributes("disabled")).toBeDefined();
    expect(store.beginSessionCreation).not.toHaveBeenCalled();
  });

  it("surfaces a native-list failure as a distinct error block with an auth hint", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    vi.mocked(store.listNativeSessions).mockRejectedValue(new Error("Authentication required"));
    await flushPromises();
    await wrapper.get('[data-test="ns-source-native"]').trigger("click");
    await flushPromises();
    const err = wrapper.find('[data-test="ns-native-error"]');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("Authentication required");
    expect(err.text()).toMatch(/isn't authenticated/i); // friendly next-step hint
    // The plain "no sessions" empty hint must NOT show when there's a real error.
    expect(wrapper.find('[data-test="ns-native-empty"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="ns-create"]').attributes("disabled")).toBeDefined();
  });

  it("renders Chinese strings when the locale is zh-CN", async () => {
    i18n.global.locale.value = "zh-CN";
    try {
      const { wrapper } = mountDialog({
        agents: [{ name: "codex", driver: "codex" }],
        workspaces: [{ name: "backend", cwd: "/b" }],
        agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
        sessions: [],
      });
      await flushPromises();
      const dialog = wrapper.get('[data-test="new-session-dialog"]');
      expect(dialog.text()).toContain("新建会话");
      expect(dialog.text()).toContain("创建");
    } finally {
      i18n.global.locale.value = "en";
    }
  });

  it("closes optimistically on create — emits created+close without blocking on the slow RPC", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    await flushPromises();
    await wrapper.get('[data-test="ns-alias"]').setValue("backend");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    // No in-dialog pending notice — the dialog hands creation to the background and leaves.
    expect(wrapper.find('[data-test="ns-pending"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="ns-error"]').exists()).toBe(false);
    expect(store.beginSessionCreation).toHaveBeenCalledWith("i1", "backend", "codex", "backend", undefined, undefined);
    expect(wrapper.emitted("created")?.[0]).toEqual(["backend"]);
    expect(wrapper.emitted("close")).toBeTruthy();
  });
});
