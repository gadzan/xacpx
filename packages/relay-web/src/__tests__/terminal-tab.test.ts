import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

const adapter = {
  write: vi.fn(), resize: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
  getSelection: vi.fn(() => ""), setTheme: vi.fn(), scrollLines: vi.fn(),
  fit: vi.fn(() => ({ cols: 80, rows: 24 })),
  cols: () => 80, rows: () => 24,
};
vi.mock("../lib/terminal-adapter", () => ({ createTerminalAdapter: vi.fn(() => adapter) }));
vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));
vi.mock("../api/events", () => ({ sendWebClientMessage: vi.fn() }));

import TerminalTab from "../components/TerminalTab.vue";
import { createTerminalAdapter } from "../lib/terminal-adapter";
import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";

const globalOpts = { mocks: { $t: (k: string) => k } };
const tick = () => new Promise((r) => setTimeout(r, 0));

// Grab the onData callback TerminalTab passed into the (mocked) adapter factory.
function onDataOf() {
  const call = vi.mocked(createTerminalAdapter).mock.calls.at(-1);
  return (call![1] as { onData: (d: string) => void }).onData;
}

describe("TerminalTab", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); localStorage.clear(); });

  it("creates a terminal and mounts the adapter when a session is selected", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(createTerminalAdapter).toHaveBeenCalled();
  });

  it("host carries the term-host class the focus-ring suppression targets", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.find('[data-test="terminal-host"]').classes()).toContain("term-host");
  });

  it("shows the no-session hint when sessionAlias is empty", () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "" }, global: globalOpts });
    expect(w.text()).toContain("terminal.noSession");
    expect(createTerminalAdapter).not.toHaveBeenCalled();
  });

  it("maps a resolved errorPayload 'terminal-disabled' to the disabled hint", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "internal", message: "terminal-disabled" } } as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.text()).toContain("terminal.disabled");
  });

  it("maps an unrecognized error message to terminal.error", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "session-not-found", message: "session-not-found" } } as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.text()).toContain("terminal.error");
  });

  it("superseded create() is closed and does not leak the terminal", async () => {
    let resolveFn!: (v: unknown) => void;
    const deferred = new Promise((res) => { resolveFn = res; });
    vi.mocked(api.rpc).mockReturnValueOnce(deferred as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "s1" }, global: globalOpts });
    vi.mocked(api.rpc).mockResolvedValueOnce({ terminalId: "t2" } as never);
    await w.setProps({ sessionAlias: "s2" });
    await tick();
    resolveFn({ terminalId: "t1" });
    await tick();
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-close", terminalId: "t1" }),
    );
  });

  it("keybar Esc sends the escape sequence to the PTY", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-esc"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", terminalId: "t1", data: "\u001b" }),
    );
  });

  it("keybar arrow-up sends the CSI up sequence", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-up"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "\u001b[A" }),
    );
  });

  it("sticky Ctrl turns the next typed letter into a control code, then disarms", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-ctrl"]').trigger("click"); // arm
    const onData = onDataOf();
    onData("c");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "\u0003" }),
    );
    vi.mocked(sendWebClientMessage).mockClear();
    onData("d"); // disarmed → plain 'd'
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "d" }),
    );
  });

  it("sticky Alt prefixes ESC to the next typed char, then disarms", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-alt"]').trigger("click"); // arm
    const onData = onDataOf();
    onData("b");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "b" }),
    );
    vi.mocked(sendWebClientMessage).mockClear();
    onData("b"); // disarmed → plain 'b'
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "b" }),
    );
  });

  it("multi-char input (paste/IME) passes through and disarms an armed modifier", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-alt"]').trigger("click"); // arm Alt
    const onData = onDataOf();
    onData("abc"); // multi-char → unchanged, and the one-shot arm is dropped
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "abc" }),
    );
    vi.mocked(sendWebClientMessage).mockClear();
    onData("x"); // disarmed → plain 'x' (no ESC prefix)
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "x" }),
    );
  });

  it("sticky Shift upcases the next typed letter, then disarms", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-shift"]').trigger("click"); // arm
    onDataOf()("a");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "A" }),
    );
  });

  it("Shift + arrow-up sends the xterm modified CSI sequence and disarms Shift", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-shift"]').trigger("click"); // arm
    await w.find('[data-test="key-up"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "[1;2A" }),
    );
    vi.mocked(sendWebClientMessage).mockClear();
    await w.find('[data-test="key-up"]').trigger("click"); // disarmed → plain up
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "[A" }),
    );
  });

  it("Shift + Tab sends reverse-tab CSI Z", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-shift"]').trigger("click"); // arm
    await w.find('[data-test="key-tab"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "[Z" }),
    );
  });

  it("keybar Home / End send Ctrl-A / Ctrl-E (bound in default zsh/bash)", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-home"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "" }),
    );
    await w.find('[data-test="key-end"]').trigger("click");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "" }),
    );
  });

  it("keybar PgUp / PgDn scroll the viewport locally (rows-1 lines), not send keys", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    vi.mocked(sendWebClientMessage).mockClear();
    await w.find('[data-test="key-pageup"]').trigger("click");
    expect(adapter.scrollLines).toHaveBeenCalledWith(-23); // rows(24) - 1, toward older
    await w.find('[data-test="key-pagedown"]').trigger("click");
    expect(adapter.scrollLines).toHaveBeenCalledWith(23); // toward newer
    expect(sendWebClientMessage).not.toHaveBeenCalled(); // local scroll, nothing sent to PTY
  });

  it("touch drag scrolls the viewport (finger up -> toward newer) without focusing", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    const el = w.find('[data-test="terminal-host"]').element as HTMLElement;
    Object.defineProperty(el, "clientHeight", { value: 240, configurable: true }); // rows 24 -> lineH 10
    adapter.scrollLines.mockClear(); adapter.focus.mockClear();
    const touch = (type: string, y: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "touches", { value: [{ clientX: 0, clientY: y }], configurable: true });
      el.dispatchEvent(e);
    };
    touch("touchstart", 100);
    touch("touchmove", 60); // dy=-40, lineH=10 -> 4 lines toward newer
    touch("touchend", 60);
    expect(adapter.scrollLines).toHaveBeenCalledWith(4);
    expect(adapter.focus).not.toHaveBeenCalled(); // a drag must not raise the keyboard
  });

  it("Copy writes the terminal selection to the clipboard; no-op when empty", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    adapter.getSelection.mockReturnValueOnce("selected text");
    await w.find('[data-test="key-copy"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("selected text");
    writeText.mockClear();
    adapter.getSelection.mockReturnValueOnce("");
    await w.find('[data-test="key-copy"]').trigger("click");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("sticky Ctrl passes a non-letter through unchanged and disarms", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    await w.find('[data-test="key-ctrl"]').trigger("click"); // arm
    const onData = onDataOf();
    onData("1");
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-input", data: "1" }),
    );
  });

  it("keybar defaults visible on non-desktop (no matchMedia)", async () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.find('[data-test="keybar"]').exists()).toBe(true);
  });

  it("keybar honors a persisted hidden preference", async () => {
    localStorage.setItem("xacpx.terminalKeybar", "0");
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(w.find('[data-test="keybar"]').exists()).toBe(false);
  });

  it("applyFit drives both the ghostty grid and the PTY resize after open", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await tick();
    expect(adapter.resize).toHaveBeenCalledWith(80, 24);
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-resize", cols: 80, rows: 24 }),
    );
  });
});
