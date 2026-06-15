import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import { useSessionControlsStore } from "../stores/session-controls";

beforeEach(() => { setActivePinia(createPinia()); rpc.mockReset(); });

describe("session-controls store", () => {
  it("loadModel fetches current + available (sending only sessionAlias)", async () => {
    rpc.mockResolvedValueOnce({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]", "gpt-5.2[low]"] });
    const s = useSessionControlsStore();
    await s.loadModel("i1", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.get", { sessionAlias: "backend" });
    expect(s.current).toBe("gpt-5.2[high]");
    expect(s.available).toEqual(["gpt-5.2[high]", "gpt-5.2[low]"]);
  });

  it("loadModel resets on missing instance/alias without an rpc", async () => {
    const s = useSessionControlsStore();
    await s.loadModel(null, "backend");
    expect(rpc).not.toHaveBeenCalled();
    expect(s.available).toEqual([]);
  });

  it("setModel switches and optimistically updates current", async () => {
    rpc.mockResolvedValueOnce({ ok: true });
    const s = useSessionControlsStore();
    const ok = await s.setModel("i1", "backend", "claude-opus-4-8");
    expect(rpc).toHaveBeenCalledWith("i1", "control.session.model.set", { sessionAlias: "backend", modelId: "claude-opus-4-8" });
    expect(ok).toBe(true);
    expect(s.current).toBe("claude-opus-4-8");
  });

  it("setModel surfaces an instance-side error payload", async () => {
    rpc.mockResolvedValueOnce({ error: { code: "internal", message: "requested model unsupported" } });
    const s = useSessionControlsStore();
    const ok = await s.setModel("i1", "backend", "bogus");
    expect(ok).toBe(false);
    expect(s.error).toContain("unsupported");
  });
});
