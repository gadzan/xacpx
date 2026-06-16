import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import NewSessionDialog from "../components/NewSessionDialog.vue";
import { useInstancesStore } from "../stores/instances";

interface DialogOptions {
  agents?: Array<{ name: string; driver: string }>;
  workspaces?: Array<{ name: string; cwd: string; description?: string }>;
  agentCatalog?: Array<{ driver: string; configured: boolean; installed: "builtin" | "yes" | "unknown" }>;
  sessions?: Array<{ alias: string }>;
  nativeSessions?: Array<{ sessionId: string; title?: string | null; updatedAt?: string; cwd?: string }>;
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
  vi.spyOn(store, "listNativeSessions").mockResolvedValue(opts.nativeSessions ?? []);
  const wrapper = mount(NewSessionDialog, { props: { instanceId: "i1", instanceName: "pc" } });
  return { wrapper, store };
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
    expect(store.createSession).toHaveBeenCalledWith("i1", "backend-codex-2", "codex", "backend");
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
    await wrapper.get('[data-test="ns-agent"]').setValue("gemini");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(store.createAgent).toHaveBeenCalledWith("i1", "gemini", "gemini");
    expect(store.createSession).toHaveBeenCalledWith("i1", "backend-gemini", "gemini", "backend");
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
    expect(store.createSession).toHaveBeenCalledWith("i1", "demo-project-codex", "codex", "demo-project");
  });

  it("an un-installed (unknown) driver is shown but disabled in the select", async () => {
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
    const opt = wrapper.find('option[value="qwen"]');
    expect(opt.exists()).toBe(true);
    expect(opt.attributes("disabled")).toBeDefined();
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
    expect(store.createSession).not.toHaveBeenCalled();
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
    await wrapper.get('[data-test="ns-agent"]').setValue("gemini");
    await wrapper.get('[data-test="ns-ws-mode-path"]').trigger("click");
    await wrapper.get('[data-test="ns-ws-path"]').setValue("@@@");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="ns-error"]').exists()).toBe(true);
    expect(store.createAgent).not.toHaveBeenCalled();
    expect(store.createWorkspace).not.toHaveBeenCalled();
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it("emits the resolved auto-generated alias on pending-close when alias was blank", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    vi.mocked(store.createSession).mockResolvedValue({ pending: true });
    await flushPromises();
    // leave alias blank → auto-generated "backend-codex"
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="ns-pending"]').exists()).toBe(true);
    await wrapper.get('[data-test="ns-pending-close"]').trigger("click");
    expect(wrapper.emitted("created")?.[0]).toEqual(["backend-codex"]);
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
    expect(store.createSession).toHaveBeenCalledWith("i1", "backend-codex", "codex", "backend", "ses_99");
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
    expect(store.createSession).not.toHaveBeenCalled();
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

  it("shows a non-error pending notice on a create timeout and defers emit until acknowledged", async () => {
    const { wrapper, store } = mountDialog({
      agents: [{ name: "codex", driver: "codex" }],
      workspaces: [{ name: "backend", cwd: "/b" }],
      agentCatalog: [{ driver: "codex", configured: true, installed: "builtin" }],
      sessions: [],
    });
    vi.mocked(store.createSession).mockResolvedValue({ pending: true });
    await flushPromises();
    await wrapper.get('[data-test="ns-alias"]').setValue("backend");
    await wrapper.get('[data-test="ns-create"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="ns-pending"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="ns-error"]').exists()).toBe(false);
    expect(wrapper.emitted("created")).toBeFalsy();
    expect(wrapper.emitted("close")).toBeFalsy();
    await wrapper.get('[data-test="ns-pending-close"]').trigger("click");
    expect(wrapper.emitted("created")?.[0]).toEqual(["backend"]);
    expect(wrapper.emitted("close")).toBeTruthy();
  });
});
