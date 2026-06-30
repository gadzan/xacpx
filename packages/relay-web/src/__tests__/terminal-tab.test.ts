import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";

const adapter = { write: vi.fn(), resize: vi.fn(), dispose: vi.fn(), cols: () => 80, rows: () => 24 };
vi.mock("../lib/terminal-adapter", () => ({ createTerminalAdapter: vi.fn(() => adapter) }));
vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));
vi.mock("../api/events", () => ({ sendWebClientMessage: vi.fn() }));

import TerminalTab from "../components/TerminalTab.vue";
import { createTerminalAdapter } from "../lib/terminal-adapter";
import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";

const globalOpts = { mocks: { $t: (k: string) => k } };

describe("TerminalTab", () => {
  beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks(); });

  it("creates a terminal and mounts the adapter when a session is selected", async () => {
    mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await new Promise((r) => setTimeout(r, 0));
    expect(createTerminalAdapter).toHaveBeenCalled();
  });

  it("shows the no-session hint when sessionAlias is empty", () => {
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "" }, global: globalOpts });
    expect(w.text()).toContain("terminal.noSession");
    expect(createTerminalAdapter).not.toHaveBeenCalled();
  });

  it("shows terminal.disabled hint when api.rpc RESOLVES an errorPayload with terminal-disabled message (Fix 1+3)", async () => {
    // api.rpc resolves (does NOT throw) with an errorPayload — the store must surface the rejection
    // and the tab must map the message to the disabled i18n key.
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "internal", message: "terminal-disabled" } } as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await new Promise((r) => setTimeout(r, 0));
    // status=error, errorKey="terminal.disabled" → $t renders the key
    expect(w.text()).toContain("terminal.disabled");
  });

  it("shows terminal.error for unrecognized error message (Fix 3)", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "session-not-found", message: "session-not-found" } } as never);
    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "demo" }, global: globalOpts });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.text()).toContain("terminal.error");
  });

  it("superseded create() is closed and does not leak the terminal (Fix 2 race guard)", async () => {
    // Arrange: a deferred create() that resolves only when we tell it to.
    let resolveFn!: (v: unknown) => void;
    const deferred = new Promise((res) => { resolveFn = res; });
    vi.mocked(api.rpc).mockReturnValueOnce(deferred as never);

    const w = mount(TerminalTab, { props: { instanceId: "i1", sessionAlias: "s1" }, global: globalOpts });
    // At this point, start() is awaiting the deferred create() — terminalId is still "".

    // Trigger a supersede: change the session prop, which calls teardown() + a new start().
    // The new start() calls rpc normally (returns { terminalId: "t2" }).
    vi.mocked(api.rpc).mockResolvedValueOnce({ terminalId: "t2" } as never);
    await w.setProps({ sessionAlias: "s2" });
    await new Promise((r) => setTimeout(r, 0));

    // Now resolve the original deferred with terminalId "t1" (the orphan).
    resolveFn({ terminalId: "t1" });
    await new Promise((r) => setTimeout(r, 0));

    // The superseded branch must have fired terminal-close for "t1" (the orphan).
    expect(sendWebClientMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "terminal-close", terminalId: "t1" }),
    );
  });
});
