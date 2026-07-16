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
    expect(s.current).toBe("gpt-5.2[high]");
    expect(s.available).toEqual(["gpt-5.2[high]", "gpt-5.2[low]"]);
  });

  it("loadModel coerces a malformed result to safe defaults (no array → [])", async () => {
    // A partial/garbled connector reply (e.g. {}) must not leave `available` undefined —
    // the composer reads `available.length` during render and would white-screen otherwise.
    rpc.mockResolvedValueOnce({});
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    expect(s.available).toEqual([]);
    expect(s.current).toBeUndefined();
  });

  it("loadModel resets on missing instance/alias without an rpc", async () => {
    const s = useSessionControlsStore();
    await s.loadModel(null, "backend");
    expect(rpc).not.toHaveBeenCalled();
    expect(s.available).toEqual([]);
  });

  it("setModel updates current optimistically before the RPC resolves", async () => {
    let resolveRpc!: (v: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((r) => { resolveRpc = r; }));
    const s = useSessionControlsStore();
    const p = s.setModel("i1", "backend", "claude-opus-4-8");
    // The chip reflects the choice immediately — before the (slow) backend set resolves.
    expect(s.current).toBe("claude-opus-4-8");
    resolveRpc({ ok: true });
    expect(await p).toBe(true);
    expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.set", { sessionAlias: "backend", modelId: "claude-opus-4-8" });
    expect(s.current).toBe("claude-opus-4-8");
  });

  it("setModel reverts current and reports a concise global toast on an instance-side error", async () => {
    rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    expect(s.current).toBe("gpt-5.2[high]");
    const detail = "acpx command timed out during set-model after 30s; stderr tail: adapter stalled";
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: detail } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ok = await s.setModel("i1", "backend", "bogus");
    expect(ok).toBe(false);
    expect(s.current).toBe("gpt-5.2[high]"); // reverted, not left on "bogus"
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
    expect(s.current).toBe("provider/fallback-model");
    expect(useToasts().value[0]).toMatchObject({ tone: "error", key: "chat.modelSetFailed" });
    expect(log).toHaveBeenCalledWith(
      "[relay-web] model switch failed",
      "requested claude-opus-4-8; authoritative model is provider/fallback-model",
    );
    log.mockRestore();
  });
});
