import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeEnvelope,
  webEventEnvelope,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class extends Error {},
  api: { rpc: (id: string, type: string, payload?: unknown) => rpc(id, type, payload) },
}));

import { connectEvents, _resetTerminalRequestStateForTests } from "../api/events";
import { dismissToast, useToasts } from "../lib/use-toasts";
import { useSessionControlsStore } from "../stores/session-controls";

class FakeWS {
  static instances: FakeWS[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());

  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
}

function pushEvent(ws: FakeWS, event: WebServerEvent): void {
  ws.onmessage?.({ data: encodeEnvelope(webEventEnvelope(event)) });
}

function clearToasts(): void {
  for (const toast of [...useToasts().value]) dismissToast(toast.id);
}

describe("live session controls refresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    rpc.mockReset();
    FakeWS.instances = [];
    _resetTerminalRequestStateForTests();
    clearToasts();
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
  });

  afterEach(() => {
    _resetTerminalRequestStateForTests();
    clearToasts();
    vi.unstubAllGlobals();
  });

  it("refreshes model and effort on first live activity before turn-finished", async () => {
    let model = { current: "model-old", available: ["model-old"] };
    let effort = { current: "medium", available: ["medium"] };
    rpc.mockImplementation(async (_instanceId: string, type: string) => {
      if (type === "control.session.model.get") return structuredClone(model);
      if (type === "control.session.effort.get") return structuredClone(effort);
      throw new Error(`unexpected rpc: ${type}`);
    });

    const controls = useSessionControlsStore();
    await Promise.all([
      controls.loadModel("i1", "backend"),
      controls.loadEffort("i1", "backend"),
    ]);
    expect(controls.modelCurrent).toBe("model-old");
    expect(controls.effortCurrent).toBe("medium");
    expect(rpc).toHaveBeenCalledTimes(2);

    const disconnect = connectEvents(() => {});
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();

    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-started", chatKey: "relay:control", sessionAlias: "backend" },
    });

    // Simulate adapter-side config changing after prompt dispatch. The first streamed
    // activity must make the chips authoritative immediately, before turn-finished.
    model = { current: "model-new", available: ["model-new", "model-alt"] };
    effort = { current: "high", available: ["low", "medium", "high"] };
    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-output", chatKey: "relay:control", sessionAlias: "backend", chunk: "first token" },
    });

    await vi.waitFor(() => {
      expect(controls.modelCurrent).toBe("model-new");
      expect(controls.modelAvailable).toEqual(["model-new", "model-alt"]);
      expect(controls.effortCurrent).toBe("high");
      expect(controls.effortAvailable).toEqual(["low", "medium", "high"]);
    });
    expect(rpc).toHaveBeenCalledTimes(4);

    // Streaming output is hot; don't turn this into per-token management polling.
    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-output", chatKey: "relay:control", sessionAlias: "backend", chunk: "second token" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(4);

    // One final authoritative convergence is allowed at completion.
    model = { current: "model-final", available: ["model-final"] };
    effort = { current: "xhigh", available: ["high", "xhigh"] };
    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-finished", chatKey: "relay:control", sessionAlias: "backend", ok: true },
    });
    await vi.waitFor(() => {
      expect(controls.modelCurrent).toBe("model-final");
      expect(controls.effortCurrent).toBe("xhigh");
    });
    expect(rpc).toHaveBeenCalledTimes(6);

    disconnect();
  });

  it("refreshes an active selected turn from reconnect state-snapshot without waiting for finish", async () => {
    let model = { current: "model-old", available: ["model-old"] };
    let effort = { current: "medium", available: ["medium"] };
    rpc.mockImplementation(async (_instanceId: string, type: string) => {
      if (type === "control.session.model.get") return structuredClone(model);
      if (type === "control.session.effort.get") return structuredClone(effort);
      throw new Error(`unexpected rpc: ${type}`);
    });

    const controls = useSessionControlsStore();
    await Promise.all([
      controls.loadModel("i1", "backend"),
      controls.loadEffort("i1", "backend"),
    ]);

    const disconnect = connectEvents(() => {});
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();

    // No turn-started reaches this socket: it represents a reconnect after that delta
    // was missed. The authoritative snapshot says the selected turn is still running.
    model = { current: "model-during-offline", available: ["model-during-offline", "model-alt"] };
    effort = { current: "high", available: ["medium", "high"] };
    pushEvent(ws, {
      kind: "state-snapshot",
      instanceId: "i1",
      turns: [{
        instanceId: "i1",
        sessionAlias: "backend",
        status: "streaming",
        startedAt: 10,
        parts: [],
      }],
      usage: [],
      commands: [],
    });

    await vi.waitFor(() => {
      expect(controls.modelCurrent).toBe("model-during-offline");
      expect(controls.modelAvailable).toEqual(["model-during-offline", "model-alt"]);
      expect(controls.effortCurrent).toBe("high");
      expect(controls.effortAvailable).toEqual(["medium", "high"]);
    });
    expect(rpc).toHaveBeenCalledTimes(4);

    // The snapshot itself consumed the reconnect refresh; the next token is not a poll.
    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-output", chatKey: "relay:control", sessionAlias: "backend", chunk: "resumed token" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(4);

    disconnect();
  });

  it("live refresh waits for a pending model set failure so rollback and toast are preserved", async () => {
    let resolveModelSet!: (value: unknown) => void;
    rpc.mockImplementation((_instanceId: string, type: string) => {
      if (type === "control.session.model.get") {
        return Promise.resolve({ current: "model-old", available: ["model-old", "model-new"] });
      }
      if (type === "control.session.effort.get") {
        return Promise.resolve({ current: "medium", available: ["medium", "high"] });
      }
      if (type === "control.session.model.set") {
        return new Promise((resolve) => { resolveModelSet = resolve; });
      }
      throw new Error(`unexpected rpc: ${type}`);
    });

    const controls = useSessionControlsStore();
    await Promise.all([
      controls.loadModel("i1", "backend"),
      controls.loadEffort("i1", "backend"),
    ]);
    const disconnect = connectEvents(() => {});
    const ws = FakeWS.instances[0]!;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-started", chatKey: "relay:control", sessionAlias: "backend" },
    });
    const pendingSet = controls.setModel("i1", "backend", "model-new");
    expect(controls.modelCurrent).toBe("model-new");

    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-output", chatKey: "relay:control", sessionAlias: "backend", chunk: "activity" },
    });
    await Promise.resolve();
    await Promise.resolve();
    // Initial model+effort GETs + the set RPC only. Passive refresh is waiting and has
    // not allocated a new load revision that could silence the set's failure handler.
    expect(rpc).toHaveBeenCalledTimes(3);

    resolveModelSet({ error: { code: "internal", message: "model switch failed" } });
    await expect(pendingSet).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(controls.modelCurrent).toBe("model-old");
      expect(useToasts().value.some((toast) => toast.key === "chat.modelSetFailed")).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(5);
    });
    expect(log).toHaveBeenCalledWith("[relay-web] model switch failed", "model switch failed");

    log.mockRestore();
    disconnect();
  });

  it("finish refresh waits for a pending effort set failure so rollback and toast are preserved", async () => {
    let resolveEffortSet!: (value: unknown) => void;
    rpc.mockImplementation((_instanceId: string, type: string) => {
      if (type === "control.session.model.get") {
        return Promise.resolve({ current: "model-old", available: ["model-old"] });
      }
      if (type === "control.session.effort.get") {
        return Promise.resolve({ current: "medium", available: ["medium", "high"] });
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
    const disconnect = connectEvents(() => {});
    const ws = FakeWS.instances[0]!;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pendingSet = controls.setEffort("i1", "backend", "high");
    expect(controls.effortCurrent).toBe("high");

    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-finished", chatKey: "relay:control", sessionAlias: "backend", ok: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(3);

    resolveEffortSet({ error: { code: "internal", message: "effort switch failed" } });
    await expect(pendingSet).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(controls.effortCurrent).toBe("medium");
      expect(useToasts().value.some((toast) => toast.key === "chat.effortSetFailed")).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(5);
    });
    expect(log).toHaveBeenCalledWith("[relay-web] effort switch failed", "effort switch failed");

    log.mockRestore();
    disconnect();
  });

  it("ignores live events for a background session", async () => {
    rpc.mockImplementation(async (_instanceId: string, type: string) => {
      if (type === "control.session.model.get") return { current: "selected-model", available: ["selected-model"] };
      if (type === "control.session.effort.get") return { current: "medium", available: ["medium"] };
      throw new Error(`unexpected rpc: ${type}`);
    });

    const controls = useSessionControlsStore();
    await Promise.all([
      controls.loadModel("i1", "selected"),
      controls.loadEffort("i1", "selected"),
    ]);
    const disconnect = connectEvents(() => {});
    const ws = FakeWS.instances[0]!;

    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-started", chatKey: "relay:control", sessionAlias: "background" },
    });
    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-usage", chatKey: "relay:control", sessionAlias: "background", used: 123, size: 1000 },
    });
    pushEvent(ws, {
      kind: "control-event",
      instanceId: "i1",
      event: { type: "turn-finished", chatKey: "relay:control", sessionAlias: "background", ok: true },
    });
    pushEvent(ws, {
      kind: "state-snapshot",
      instanceId: "i1",
      turns: [{
        instanceId: "i1",
        sessionAlias: "background",
        status: "working",
        startedAt: 10,
        parts: [],
      }],
      usage: [],
      commands: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(controls.modelCurrent).toBe("selected-model");
    expect(controls.effortCurrent).toBe("medium");

    disconnect();
  });
});