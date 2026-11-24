import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import { dismissToast, useToasts } from "../lib/use-toasts";
import { useSessionControlsStore } from "../stores/session-controls";

function clearToasts(): void {
  for (const toast of [...useToasts().value]) dismissToast(toast.id);
}

describe("live session controls mutation quiescence", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    rpc.mockReset();
    clearToasts();
  });

  afterEach(() => {
    clearToasts();
  });

  it("drains mutations added while passive refresh is already waiting", async () => {
    let resolveModelSet!: (value: unknown) => void;
    let resolveEffortSet!: (value: unknown) => void;
    let modelSnapshot = { current: "model-old", available: ["model-old", "model-new"] };

    rpc.mockImplementation((_instanceId: string, type: string) => {
      if (type === "control.session.model.get") return Promise.resolve(structuredClone(modelSnapshot));
      if (type === "control.session.effort.get") {
        return Promise.resolve({ current: "medium", available: ["medium", "high"] });
      }
      if (type === "control.session.model.set") {
        return new Promise((resolve) => { resolveModelSet = resolve; });
      }
      if (type === "control.session.effort.set") {
        return new Promise((resolve) => { resolveEffortSet = resolve; });
      }
      throw new Error(`unexpected rpc: ${type}`);
    });

    const controls = useSessionControlsStore();
    await Promise.all([
      controls.loadModel("i1", "backend"),
      controls.loadEffort("i1", "backend"),
    ]);
    expect(rpc).toHaveBeenCalledTimes(2);

    await controls.applyLiveEvent({
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-started", chatKey: "relay:control", sessionAlias: "backend" },
    });

    // Mutation A is already pending when first activity starts the passive refresh.
    const pendingModelSet = controls.setModel("i1", "backend", "model-new");
    const refresh = controls.applyLiveEvent({
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-output", chatKey: "relay:control", sessionAlias: "backend", chunk: "activity" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(3);

    // Mutation B starts while the refresh is already awaiting A. A one-shot pending
    // snapshot would miss B and let loadEffort steal B's revision after A settles.
    const pendingEffortSet = controls.setEffort("i1", "backend", "high");
    expect(controls.effortCurrent).toBe("high");
    expect(rpc).toHaveBeenCalledTimes(4);

    modelSnapshot = { current: "model-new", available: ["model-old", "model-new"] };
    resolveModelSet({ ok: true, current: "model-new" });
    await expect(pendingModelSet).resolves.toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    // The refresh must loop back, discover B, and keep waiting. No model/effort GET
    // is allowed between A settling and B settling.
    expect(rpc).toHaveBeenCalledTimes(4);

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    resolveEffortSet({ error: { code: "internal", message: "effort switch failed" } });
    await expect(pendingEffortSet).resolves.toBe(false);

    expect(controls.effortCurrent).toBe("medium");
    expect(useToasts().value.some((toast) => toast.key === "chat.effortSetFailed")).toBe(true);
    expect(log).toHaveBeenCalledWith("[relay-web] effort switch failed", "effort switch failed");

    // Only after B has completed (including rollback + failure feedback) may the
    // passive refresh obtain fresh revisions and perform its two authoritative GETs.
    await refresh;
    expect(rpc).toHaveBeenCalledTimes(6);
    expect(controls.modelCurrent).toBe("model-new");
    expect(controls.effortCurrent).toBe("medium");

    log.mockRestore();
  });
});
