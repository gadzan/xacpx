// packages/relay-web/src/__tests__/terminal-store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("../api/client", () => ({ api: { rpc: vi.fn(async () => ({ terminalId: "t1" })) } }));
vi.mock("../api/events", () => ({ sendWebClientMessage: vi.fn() }));

import { api } from "../api/client";
import { sendWebClientMessage } from "../api/events";
import { useTerminalStore } from "../stores/terminal";

describe("terminal store", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("create calls control.terminal.create and stores terminalId", async () => {
    const s = useTerminalStore();
    const id = await s.create("i1", "demo", 100, 30);
    expect(id).toBe("t1");
    expect(api.rpc).toHaveBeenCalledWith("i1", "control.terminal.create", { sessionAlias: "demo", cols: 100, rows: 30 });
  });

  it("create rejects when api.rpc resolves an errorPayload (Fix 1 guard)", async () => {
    // api.rpc RESOLVES (does not throw) with an error payload — the store must surface it as rejection.
    vi.mocked(api.rpc).mockResolvedValueOnce({ error: { code: "internal", message: "terminal-disabled" } } as never);
    const s = useTerminalStore();
    await expect(s.create("i1", "demo", 80, 24)).rejects.toThrow("terminal-disabled");
  });

  it("input/resize/close send web client frames", () => {
    const s = useTerminalStore();
    s.input("i1", "t1", "ls\n");
    s.resize("i1", "t1", 90, 20);
    s.close("i1", "t1");
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" });
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 90, rows: 20 });
    expect(sendWebClientMessage).toHaveBeenCalledWith({ kind: "terminal-close", instanceId: "i1", terminalId: "t1" });
  });

  it("applyEvent forwards terminal-output to onOutput subscribers and clears on exit", () => {
    const s = useTerminalStore();
    const out = vi.fn();
    const exit = vi.fn();
    s.onOutput(out);
    s.onExit(exit);
    s.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: 0, data: "hi" } } as never);
    s.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-exit", terminalId: "t1", code: 0 } } as never);
    expect(out).toHaveBeenCalledWith("t1", "hi", 0);
    expect(exit).toHaveBeenCalledWith("t1", 0);
  });

  it("attach() calls control.terminal.attach and unwraps the result", async () => {
    vi.mocked(api.rpc).mockResolvedValueOnce({ ok: true, buffer: "scroll", lastSeq: 7 } as never);
    const store = useTerminalStore();
    const res = await store.attach("i1", "term-x");
    expect(api.rpc).toHaveBeenCalledWith("i1", "control.terminal.attach", { terminalId: "term-x" });
    expect(res).toEqual({ ok: true, buffer: "scroll", lastSeq: 7 });
  });

  it("applyEvent forwards seq to output callbacks", () => {
    const store = useTerminalStore();
    const seen: Array<[string, string, number]> = [];
    store.onOutput((id, data, seq) => seen.push([id, data, seq]));
    store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: 42, data: "hi" } } as never);
    expect(seen).toEqual([["t1", "hi", 42]]);
  });
});
