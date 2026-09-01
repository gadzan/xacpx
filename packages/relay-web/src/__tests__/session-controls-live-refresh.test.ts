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

describe("live session controls refresh", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    rpc.mockReset();
    FakeWS.instances = [];
    _resetTerminalRequestStateForTests();
    vi.stubGlobal("WebSocket", FakeWS as never);
    vi.stubGlobal("location", { protocol: "http:", host: "x" } as never);
  });

  afterEach(() => {
    _resetTerminalRequestStateForTests();
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
    await Promise.resolve();
    await Promise.resolve();

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(controls.modelCurrent).toBe("selected-model");
    expect(controls.effortCurrent).toBe("medium");

    disconnect();
  });
});