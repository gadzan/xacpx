import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount, flushPromises, enableAutoUnmount } from "@vue/test-utils";
import { TerminalRequestError } from "../api/events";
import { initialRecoveryState } from "../lib/terminal-recovery";
import type { TerminalAttachmentView } from "../stores/terminal";

// The viewport controller keeps settling timers alive after mount; unmount
// every wrapper so they are disposed before the next test's mock assertions.
enableAutoUnmount(afterEach);

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
const onRebase = vi.fn(
  (_cb?: (key: string, keyframe: Uint8Array, cols: number, rows: number) => void | Promise<void>) => () => {},
);
const onBytes = vi.fn(() => () => {});
const onMeta = vi.fn((_cb?: (key: string, view: TerminalAttachmentView) => void) => () => {});
const onAttachmentExit = vi.fn((_cb?: (key: string, reason: string, code?: number) => void) => () => {});

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
  lastErrorCode: string;
}>): TerminalAttachmentView {
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
    lastErrorCode: overrides?.lastErrorCode,
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

  it("does not label a dashboard socket drop as instance-offline", async () => {
    openOrResume.mockRejectedValueOnce(new TerminalRequestError("events-offline", "events socket is offline"));
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.text()).toContain("terminal.eventsOffline");
    expect(w.text()).not.toContain("terminal.offline");
  });

  it("sole controller does not count itself as a viewer", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-role"]').text()).toContain("terminal.role.controller");
    expect(w.find('[data-test="terminal-viewers"]').exists()).toBe(false);
  });

  it("shows other viewers as total attachments minus self", async () => {
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias, role: "controller", viewerCount: 2 }),
    );
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-viewers"]').text()).toContain("\"count\":1");
  });

  it("spectator with two attachments also shows one other viewer", async () => {
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias, role: "spectator", viewerCount: 2 }),
    );
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-role"]').text()).toContain("terminal.role.spectator");
    expect(w.find('[data-test="terminal-viewers"]').text()).toContain("\"count\":1");
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
    expect(takeControl).not.toHaveBeenCalled();
  });

  it("sole spectator auto take-controls so the keybar is usable", async () => {
    takeControl.mockResolvedValueOnce(
      openedView({ role: "controller", viewerCount: 1 }),
    );
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias, role: "spectator", viewerCount: 1 }),
    );
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(takeControl).toHaveBeenCalled();
    expect(w.find('[data-test="key-enter"]').attributes("disabled")).toBeUndefined();
  });

  it("controller keystrokes go through sendInput", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    onDataOf()("x");
    expect(sendInput).toHaveBeenCalledWith("i1\0demo", "x");
  });

  it("keybar Enter sends CR without needing ghostty focus", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    if (!w.find('[data-test="keybar"]').exists()) {
      await w.find('[data-test="toggle-keybar"]').trigger("click");
    }
    await w.find('[data-test="key-enter"]').trigger("click");
    expect(sendInput).toHaveBeenCalledWith("i1\0demo", "\r");
  });

  it("initial fit skips local resize but still forwards the backend resize", async () => {
    // fit() agrees with the adapter's current geometry (80x24 default) — the
    // local emulator must not reflow, but the backend push is unconditional:
    // the store owns "last synced" semantics, not the adapter size.
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(adapter.resize).not.toHaveBeenCalled();
    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledWith("i1\0demo", 80, 24);
  });

  it("fit-driven local resize changes forward exactly one backend resize", async () => {
    adapter.fit.mockReturnValue({ cols: 70, rows: 40 });
    try {
      mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
      await flushPromises();
      expect(adapter.resize).toHaveBeenCalledWith(70, 40);
      expect(sendResize).toHaveBeenCalledTimes(1);
      expect(sendResize).toHaveBeenCalledWith("i1\0demo", 70, 40);
    } finally {
      // clearAllMocks does not reset mockReturnValue — restore the shared default.
      adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    }
  });

  it("spectator fits stay local; take-control re-syncs backend geometry even when unchanged", async () => {
    adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias, role: "spectator", viewerCount: 2 }),
    );
    takeControl.mockResolvedValue(openedView({ role: "controller", viewerCount: 2 }));
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();

    // Spectator: adapter fitted locally (fit() returns 80x24 == adapter) but
    // no backend resize is ever pushed.
    expect(sendResize).not.toHaveBeenCalled();

    // Take control: even though the adapter is already at the target geometry,
    // applyFit must still forward the resize — the pane may be at another size.
    await w.find('[data-test="terminal-take-control"]').trigger("click");
    await flushPromises();
    expect(takeControl).toHaveBeenCalledWith("i1\0demo");
    expect(adapter.resize).not.toHaveBeenCalled();
    expect(sendResize).toHaveBeenCalledTimes(1);
    expect(sendResize).toHaveBeenCalledWith("i1\0demo", 80, 24);
  });

  it("host is keyboard-focusable", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-host"]').attributes("tabindex")).toBe("0");
  });

  it("focuses the adapter after a successful open, and again on host mousedown", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(adapter.focus).toHaveBeenCalled();
    adapter.focus.mockClear();
    await w.find('[data-test="terminal-host"]').trigger("mousedown");
    expect(adapter.focus).toHaveBeenCalled();
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

  it("fatal recovery failure shows an error instead of a blank controller canvas", async () => {
    let metaCb: ((key: string, view: TerminalAttachmentView) => void) | undefined;
    onMeta.mockImplementation((cb) => {
      metaCb = cb;
      return () => {};
    });
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-host"]').exists()).toBe(true);
    if (!w.find('[data-test="keybar"]').exists()) {
      await w.find('[data-test="toggle-keybar"]').trigger("click");
    }
    expect(w.find('[data-test="key-enter"]').attributes("disabled")).toBeUndefined();
    metaCb?.("i1\0demo", openedView({ lastErrorCode: "terminal-rmux-unavailable" }));
    await flushPromises();
    expect(w.text()).toContain("terminal.unsupported");
    expect(w.find('[data-test="terminal-host"]').isVisible()).toBe(false);
    expect(w.find('[data-test="key-enter"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="terminal-take-control"]').exists()).toBe(false);
    await w.find('[data-test="key-enter"]').trigger("click");
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("does not count a detached controller as another viewer", async () => {
    let exitCb: ((key: string, reason: string, code?: number) => void) | undefined;
    onAttachmentExit.mockImplementation((cb) => {
      exitCb = cb;
      return () => {};
    });
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    expect(w.find('[data-test="terminal-viewers"]').exists()).toBe(false);
    exitCb?.("i1\0demo", "exited", 0);
    await flushPromises();
    expect(w.find('[data-test="terminal-viewers"]').exists()).toBe(false);
  });

  type RebaseCb = (key: string, keyframe: Uint8Array, cols: number, rows: number) => void | Promise<void>;
  const keyframe = new Uint8Array([1, 2, 3]);

  it("late recovery rebase re-fits the canvas back to the host geometry", async () => {
    adapter.fit.mockReturnValue({ cols: 150, rows: 45 });
    let rebaseCb: RebaseCb | undefined;
    onRebase.mockImplementation((cb) => {
      rebaseCb = cb;
      return () => {};
    });
    try {
      mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
      await flushPromises();
      // Initial fit applied the host geometry.
      expect(adapter.resize).toHaveBeenLastCalledWith(150, 45);
      adapter.resize.mockClear();

      await rebaseCb?.("i1\0demo", keyframe, 70, 40);
      await flushPromises();

      // Keyframe rebuilt at the rebase geometry first, then re-fit to host.
      expect(adapter.resetAndReplay).toHaveBeenCalledWith(keyframe, 70, 40);
      expect(adapter.resize).toHaveBeenCalledWith(150, 45);
      const replayOrder = adapter.resetAndReplay.mock.invocationCallOrder[0];
      const resizeOrder = adapter.resize.mock.invocationCallOrder[0];
      expect(resizeOrder).toBeGreaterThan(replayOrder);
    } finally {
      adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    }
  });

  it("controller late rebase may re-send the backend resize; dedupe is the store's job", async () => {
    adapter.fit.mockReturnValue({ cols: 150, rows: 45 });
    let rebaseCb: RebaseCb | undefined;
    onRebase.mockImplementation((cb) => {
      rebaseCb = cb;
      return () => {};
    });
    try {
      mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
      await flushPromises();
      expect(sendResize).toHaveBeenCalledTimes(1);

      await rebaseCb?.("i1\0demo", keyframe, 70, 40);
      await flushPromises();

      expect(sendResize).toHaveBeenCalledTimes(2);
      expect(sendResize).toHaveBeenLastCalledWith("i1\0demo", 150, 45);
    } finally {
      adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    }
  });

  it("spectator late rebase re-fits locally but never pushes a backend resize", async () => {
    adapter.fit.mockReturnValue({ cols: 150, rows: 45 });
    openOrResume.mockImplementation(async (key: string, opts: { sessionAlias: string }) =>
      openedView({ localKey: key, sessionAlias: opts.sessionAlias, role: "spectator", viewerCount: 2 }),
    );
    let rebaseCb: RebaseCb | undefined;
    onRebase.mockImplementation((cb) => {
      rebaseCb = cb;
      return () => {};
    });
    try {
      mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
      await flushPromises();
      expect(sendResize).not.toHaveBeenCalled();
      adapter.resize.mockClear();

      await rebaseCb?.("i1\0demo", keyframe, 70, 40);
      await flushPromises();

      expect(adapter.resetAndReplay).toHaveBeenCalledWith(keyframe, 70, 40);
      expect(adapter.resize).toHaveBeenCalledWith(150, 45);
      expect(sendResize).not.toHaveBeenCalled();
    } finally {
      adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    }
  });

  it("stale rebase after epoch change does not re-fit the adapter after replay", async () => {
    let resolveReplay: (() => void) | undefined;
    const replayGate = new Promise<void>((r) => { resolveReplay = r; });
    adapter.resetAndReplay.mockReturnValueOnce(replayGate);
    let rebaseCb: RebaseCb | undefined;
    onRebase.mockImplementation((cb) => {
      rebaseCb = cb;
      return () => {};
    });
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await flushPromises();
    const fitCallsBefore = adapter.fit.mock.calls.length;
    const resizesBefore = adapter.resize.mock.calls.length;
    const sendResizesBefore = sendResize.mock.calls.length;

    const pending = rebaseCb?.("i1\0demo", keyframe, 70, 40);
    // Unmount bumps the epoch and disposes the adapter while replay is in flight.
    w.unmount();
    resolveReplay?.();
    await pending;
    await flushPromises();

    expect(adapter.fit.mock.calls.length).toBe(fitCallsBefore);
    expect(adapter.resize.mock.calls.length).toBe(resizesBefore);
    expect(sendResize.mock.calls.length).toBe(sendResizesBefore);
  });

  it("re-fits when font/canvas metrics settle after open (initial layout settling)", async () => {
    // The terminal renderer initializes asynchronously (WASM, webfont, canvas
    // mount, CSS layout). The first measurable geometry can be the fallback
    // font's; once the webfont lands the same host pixels fit a different
    // grid, and nothing re-fires ResizeObserver - settling syncs must re-fit.
    vi.useFakeTimers();
    try {
      adapter.fit.mockReturnValueOnce({ cols: 80, rows: 24 }).mockReturnValue({ cols: 150, rows: 45 });
      mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
      await vi.advanceTimersByTimeAsync(0);
      // The adapter starts at 80x24, so the first fit is a local no-op - the
      // backend push is what proves the sync ran.
      expect(adapter.resize).not.toHaveBeenCalled();
      expect(sendResize).toHaveBeenCalledWith("i1\0demo", 80, 24);

      await vi.advanceTimersByTimeAsync(1100); // settling window elapses
      expect(adapter.resize).toHaveBeenLastCalledWith(150, 45);
      expect(sendResize).toHaveBeenLastCalledWith("i1\0demo", 150, 45);
    } finally {
      vi.useRealTimers();
      adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    }
  });

  it("stops settling syncs once the tab unmounts", async () => {
    vi.useFakeTimers();
    try {
      adapter.fit.mockReturnValue({ cols: 150, rows: 45 });
      const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
      await vi.advanceTimersByTimeAsync(0);
      w.unmount();
      adapter.fit.mockClear();
      adapter.resize.mockClear();

      await vi.advanceTimersByTimeAsync(2000);
      expect(adapter.fit).not.toHaveBeenCalled();
      expect(adapter.resize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      adapter.fit.mockReturnValue({ cols: 80, rows: 24 });
    }
  });
});
