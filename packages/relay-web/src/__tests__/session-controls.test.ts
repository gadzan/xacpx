import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import { useSessionControlsStore } from "../stores/session-controls";
import { dismissToast, useToasts } from "../lib/use-toasts";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
  for (const toast of [...useToasts().value]) dismissToast(toast.id);
});

describe("session-controls store", () => {
  it("loadModel fetches current + available (sending only sessionAlias)", async () => {
    rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.2[low]"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.get", { sessionAlias: "backend" });
    expect(s.modelCurrent).toBe("gpt-5.2[high]");
    expect(s.modelAvailable).toEqual(["gpt-5.2[high]", "gpt-5.2[low]"]);
  });

  it("loadModel coerces a malformed result to safe defaults (no array → [])", async () => {
    // A partial/garbled connector reply (e.g. {}) must not leave `available` undefined —
    // the composer reads `available.length` during render and would white-screen otherwise.
    rpc.mockResolvedValueOnce({});
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    expect(s.modelAvailable).toEqual([]);
    expect(s.modelCurrent).toBeUndefined();
  });

  it("loadModel resets on missing instance/alias without an rpc", async () => {
    const s = useSessionControlsStore();
    await s.loadModel(null, "backend");
    expect(rpc).not.toHaveBeenCalled();
    expect(s.modelAvailable).toEqual([]);
  });

  it("clears the previous session model while a new session is loading", async () => {
    rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "session-a");

    let resolveLoad!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve; }));
    const pendingLoad = s.loadModel("i1", "session-b");

    expect(s.modelCurrent).toBeUndefined();
    expect(s.modelAvailable).toEqual([]);
    expect(s.modelLoading).toBe(true);
    resolveLoad({ current: "model-b", available: ["model-b"] });
    await pendingLoad;
    expect(s.modelCurrent).toBe("model-b");
  });

  it("setModel updates current optimistically before the RPC resolves", async () => {
    let resolveRpc!: (v: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((r) => { resolveRpc = r; }));
    const s = useSessionControlsStore();
    const p = s.setModel("i1", "backend", "claude-opus-4-8");
    // The chip reflects the choice immediately — before the (slow) backend set resolves.
    expect(s.modelCurrent).toBe("claude-opus-4-8");
    resolveRpc({ ok: true });
    expect(await p).toBe(true);
    expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.set", { sessionAlias: "backend", modelId: "claude-opus-4-8" });
    expect(s.modelCurrent).toBe("claude-opus-4-8");
  });

  it("setModel reverts current and reports a concise global toast on an instance-side error", async () => {
    rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    expect(s.modelCurrent).toBe("gpt-5.2[high]");
    const detail = "acpx command timed out during set-model after 30s; stderr tail: adapter stalled";
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: detail } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ok = await s.setModel("i1", "backend", "bogus");
    expect(ok).toBe(false);
    expect(s.modelCurrent).toBe("gpt-5.2[high]"); // reverted, not left on "bogus"
    expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "chat.modelSetFailed" });
    expect(useToasts().value[0]?.params).toBeUndefined();
    expect(log).toHaveBeenCalledWith("[relay-web] model switch failed", detail);
    log.mockRestore();
  });

  it("setModel adopts the authoritative model returned by timeout reconciliation", async () => {
    rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    rpc.mockResolvedValueOnce({ ok: false, current: "provider/fallback-model" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const ok = await s.setModel("i1", "backend", "claude-opus-4-8");

    expect(ok).toBe(false);
    expect(s.modelCurrent).toBe("provider/fallback-model");
    expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "chat.modelSetFailed" });
    expect(log).toHaveBeenCalledWith(
      "[relay-web] model switch failed",
      "requested claude-opus-4-8; authoritative model is provider/fallback-model",
    );
    log.mockRestore();
  });

  it("ignores a model-set response that arrives after switching sessions", async () => {
    rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a", "model-b"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "session-a");

    let resolveSet!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveSet = resolve; }));
    const pendingSet = s.setModel("i1", "session-a", "model-b");

    rpc.mockResolvedValueOnce({ current: "model-x", available: ["model-x"] });
    await s.loadModel("i1", "session-b");
    expect(s.modelCurrent).toBe("model-x");

    resolveSet({ ok: true, current: "model-b" });
    await pendingSet;
    expect(s.modelCurrent).toBe("model-x");
  });

  it("keeps the latest selection when model-set responses arrive out of order", async () => {
    rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a", "model-b", "model-c"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");

    let resolveB!: (value: unknown) => void;
    let resolveC!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    const pendingB = s.setModel("i1", "backend", "model-b");
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveC = resolve; }));
    const pendingC = s.setModel("i1", "backend", "model-c");

    resolveC({ ok: true, current: "model-c" });
    await pendingC;
    resolveB({ ok: true, current: "model-b" });
    await pendingB;

    expect(s.modelCurrent).toBe("model-c");
  });

  it("returns to the last authoritative model when two rapid selections both fail", async () => {
    rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a", "model-b", "model-c"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");

    let resolveB!: (value: unknown) => void;
    let resolveC!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    const pendingB = s.setModel("i1", "backend", "model-b");
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveC = resolve; }));
    const pendingC = s.setModel("i1", "backend", "model-c");

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveB({ error: { code: "internal", message: "model-b failed" } });
    await pendingB;
    resolveC({ error: { code: "internal", message: "model-c failed" } });
    await pendingC;

    expect(s.modelCurrent).toBe("model-a");
    expect(useToasts().value).toHaveLength(1);
    log.mockRestore();
  });

  it("a model selection supersedes a pending load without leaving loading stuck", async () => {
    let resolveLoad!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve; }));
    const s = useSessionControlsStore();
    const pendingLoad = s.loadModel("i1", "backend");
    expect(s.modelLoading).toBe(true);

    rpc.mockResolvedValueOnce({ ok: true, current: "model-b" });
    await s.setModel("i1", "backend", "model-b");
    expect(s.modelLoading).toBe(false);

    resolveLoad({ current: "model-a", available: ["model-a"] });
    await pendingLoad;
    expect(s.modelCurrent).toBe("model-b");
  });

  it("does not toast a stale model-set failure from the previous session", async () => {
    rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a", "model-b"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "session-a");

    let resolveSet!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveSet = resolve; }));
    const pendingSet = s.setModel("i1", "session-a", "model-b");
    rpc.mockResolvedValueOnce({ current: "model-x", available: ["model-x"] });
    await s.loadModel("i1", "session-b");

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveSet({ error: { code: "internal", message: "late failure" } });
    await pendingSet;

    expect(s.modelCurrent).toBe("model-x");
    expect(useToasts().value).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("reloads a session only after its pending model selection settles", async () => {
    rpc.mockResolvedValueOnce({ current: "model-a", available: ["model-a", "model-b"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "session-a");

    let modelApplied = false;
    let settleSet!: () => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => {
      settleSet = () => {
        modelApplied = true;
        resolve({ ok: true, current: "model-b" });
      };
    }));
    const pendingSet = s.setModel("i1", "session-a", "model-b");

    rpc.mockResolvedValueOnce({ current: "model-x", available: ["model-x"] });
    await s.loadModel("i1", "session-b");
    rpc.mockImplementationOnce(async () => ({
      current: modelApplied ? "model-b" : "model-a",
      available: ["model-a", "model-b"],
    }));
    const pendingReload = s.loadModel("i1", "session-a");

    // The set finishes while session A is active again. Its reload must not have
    // queried the pre-set value and then discarded the authoritative set reply.
    settleSet();
    await pendingSet;
    await pendingReload;

    expect(s.modelCurrent).toBe("model-b");
  });

  it("loadEffort fetches the adapter-advertised effort values", async () => {
    rpc.mockResolvedValueOnce({ current: "medium", available: ["low", "medium", "high"] });
    const s = useSessionControlsStore();

    await s.loadEffort("i1", "backend");

    expect(rpc).toHaveBeenCalledWith("i1", "control.session.effort.get", { sessionAlias: "backend" });
    expect(s.effortCurrent).toBe("medium");
    expect(s.effortAvailable).toEqual(["low", "medium", "high"]);
  });

  it("setEffort updates optimistically and rolls back on failure", async () => {
    rpc.mockResolvedValueOnce({ current: "medium", available: ["medium", "high"] });
    const s = useSessionControlsStore();
    await s.loadEffort("i1", "backend");

    let resolveSet!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveSet = resolve; }));
    const pending = s.setEffort("i1", "backend", "high");
    expect(s.effortCurrent).toBe("high");

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveSet({ error: { code: "internal", message: "unsupported effort" } });
    await expect(pending).resolves.toBe(false);
    expect(s.effortCurrent).toBe("medium");
    expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "chat.effortSetFailed" });
    log.mockRestore();
  });

  it("waitForEffortSet waits for the active effort mutation in the same session", async () => {
    const s = useSessionControlsStore();
    let resolveSet!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveSet = resolve; }));
    const setting = s.setEffort("i1", "backend", "high");
    let settled = false;
    const waiting = s.waitForEffortSet("i1", "backend")!.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    resolveSet({ current: "high", applied: true });
    await setting;
    await waiting;
    expect(settled).toBe(true);
  });

  it("clears effort when a failed set reports an authoritative null current", async () => {
    rpc.mockResolvedValueOnce({ current: "medium", available: ["medium", "high"] });
    const s = useSessionControlsStore();
    await s.loadEffort("i1", "backend");
    rpc.mockResolvedValueOnce({ ok: false, current: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(s.setEffort("i1", "backend", "high")).resolves.toBe(false);

    expect(s.effortCurrent).toBeUndefined();
    log.mockRestore();
  });

  it("keeps the last applied effort when a rapid newer selection fails", async () => {
    rpc.mockResolvedValueOnce({ current: "medium", available: ["medium", "high", "xhigh"] });
    const s = useSessionControlsStore();
    await s.loadEffort("i1", "backend");

    let resolveHigh!: (value: unknown) => void;
    let resolveXhigh!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveHigh = resolve; }));
    const pendingHigh = s.setEffort("i1", "backend", "high");
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveXhigh = resolve; }));
    const pendingXhigh = s.setEffort("i1", "backend", "xhigh");

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveHigh({ ok: true, current: "high" });
    await expect(pendingHigh).resolves.toBe(true);
    resolveXhigh({ error: { code: "internal", message: "xhigh failed" } });
    await expect(pendingXhigh).resolves.toBe(false);

    expect(s.effortCurrent).toBe("high");
    expect(useToasts().value).toHaveLength(1);
    log.mockRestore();
  });
});
