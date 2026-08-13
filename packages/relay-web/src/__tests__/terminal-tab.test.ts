import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount, flushPromises } from "@vue/test-utils";
import { TerminalRequestError } from "../api/events";
import { initialRecoveryState } from "../lib/terminal-recovery";

const adapter = {
  write: vi.fn(async () => {}),
  resize: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  getSelection: vi.fn(() => ""),
  setTheme: vi.fn(),
  scrollLines: vi.fn(),
  resetAndReplay: vi.fn(async () => {}),
  fit: vi.fn((): { cols: number; rows: number } | null => ({ cols: 80, rows: 24 })),
  cols: () => 80,
  rows: () => 24,
};
vi.mock("../lib/terminal-adapter", () => ({ createTerminalAdapter: vi.fn(() => adapter) }));

const openOrResume = vi.fn();
const detach = vi.fn();
const sendInput = vi.fn();
const sendResize = vi.fn();
const takeControl = vi.fn();
const onRebase = vi.fn(() => () => {});
const onBytes = vi.fn(() => () => {});
const onMeta = vi.fn(() => () => {});
const onAttachmentExit = vi.fn(() => () => {});

vi.mock("../stores/terminal", async () => {
  const actual = await vi.importActual<typeof import("../stores/terminal")>("../stores/terminal");
  return {
    ...actual,
    useTerminalStore: () => ({
      openOrResume,
      detach,
      sendInput,
      sendResize,
      takeControl,
      onRebase,
      onBytes,
      onMeta,
      onAttachmentExit,
      get: vi.fn(),
    }),
  };
});

import TerminalTab from "../components/TerminalTab.vue";
import { createTerminalAdapter } from "../lib/terminal-adapter";

const globalOpts = { mocks: { $t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k) } };
const tick = () => new Promise((r) => setTimeout(r, 0));

function onDataOf() {
  const call = vi.mocked(createTerminalAdapter).mock.calls.at(-1);
  return (call![1] as { onData: (d: string) => void }).onData;
}

function openedView(overrides?: Partial<{
  localKey: string;
  sessionAlias: string;
  role: "controller" | "spectator";
  viewerCount: number;
}>) {
  const sessionAlias = overrides?.sessionAlias ?? "demo";
  const localKey = overrides?.localKey ?? `i1\0${sessionAlias}`;
  return {
    localKey,
    instanceId: "i1",
    sessionAlias,
    cols: 80,
    rows: 24,
    terminalId: "t1",
    generation: "g1",
    attachmentId: "a1",
    role: overrides?.role ?? "controller",
    viewerCount: overrides?.viewerCount ?? 1,
    recovery: initialRecoveryState("g1"),
    active: true,
    terminatePending: false,
    terminateRetryable: false,
  };
}

describe("TerminalTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    openOrResume.mockResolvedValue(openedView());
    onRebase.mockReturnValue(() => {});
    onBytes.mockReturnValue(() => {});
    onMeta.mockReturnValue(() => {});
    onAttachmentExit.mockReturnValue(() => {});
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias }),
    );
  });

  it("openOrResumes and mounts the adapter when a session is selected", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(createTerminalAdapter).toHaveBeenCalled();
    expect(openOrResume).toHaveBeenCalledWith("i1\0demo", expect.objectContaining({
      instanceId: "i1",
      sessionAlias: "demo",
    }));
  });

  it("host carries the term-host class", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.find('[data-test="terminal-host"]').classes()).toContain("term-host");
  });

  it("shows the no-session hint when sessionAlias is empty", () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "" }, global: globalOpts });
    expect(w.text()).toContain("terminal.noSession");
    expect(openOrResume).not.toHaveBeenCalled();
  });

  it("maps TerminalRequestError codes to i18n keys", async () => {
    openOrResume.mockRejectedValueOnce(new TerminalRequestError("terminal-disabled", "off"));
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.text()).toContain("terminal.disabled");
  });

  it("spectator disables input and shows take-control", async () => {
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias, role: "spectator", viewerCount: 2 }),
    );
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-role"]').text()).toContain("terminal.role.spectator");
    expect(w.find('[data-test="terminal-take-control"]').exists()).toBe(true);
    onDataOf()("x");
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("controller keystrokes go through sendInput", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    onDataOf()("x");
    expect(sendInput).toHaveBeenCalledWith("i1\0demo", "x");
  });

  it("detaches on unmount without terminate", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    w.unmount();
    expect(detach).toHaveBeenCalledWith("i1\0demo");
  });

  it("registers rebase/bytes handlers for recovery rendering", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(onRebase).toHaveBeenCalled();
    expect(onBytes).toHaveBeenCalled();
  });

  it("toggles the keybar", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    const btn = w.find('[data-test="toggle-keybar"]');
    const before = w.find('[data-test="keybar"]').exists();
    await btn.trigger("click");
    expect(w.find('[data-test="keybar"]').exists()).toBe(!before);
  });
});
