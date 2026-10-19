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
import { useInstancesStore } from "../stores/instances";
import { useAuthStore } from "../stores/auth";
import { read as readViewSnapshot } from "../lib/view-snapshot-cache";

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

function seedReadySession(): void {
  useInstancesStore().instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true,
    agents: [], workspaces: [], agentCatalog: [],
    sessions: [{ alias: "new-session", agent: "codex", workspace: "home", transportSession: "t-new", running: false, archived: false }],
  }];
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

  it("ignores early list changes and loads controls only for the ready session incarnation", async () => {
    seedReadySession();
    let ready = false;
    rpc.mockImplementation(async (_instanceId: string, type: string) => {
      if (!ready) return { available: [] };
      if (type === "control.session.model.get") return { current: "model-new", available: ["model-new", "model-alt"] };
      if (type === "control.session.effort.get") return { current: "high", available: ["medium", "high"] };
      throw new Error(`unexpected rpc: ${type}`);
    });
    const controls = useSessionControlsStore();
    await Promise.all([controls.loadModel("i1", "new-session"), controls.loadEffort("i1", "new-session")]);
    const disconnect = connectEvents(() => {});
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();

    // Rename/warmth changes can arrive while the selected adapter still returns empty.
    await controls.applyLiveEvent({ kind: "control-event", instanceId: "i1", event: { type: "sessions-changed" } });
    expect(controls.modelCurrent).toBeUndefined();
    expect(controls.effortAvailable).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(2);
    ready = true;
    for (const [instanceId, alias, transport] of [["other", "new-session", "t-new"], ["i1", "another", "t-new"], ["i1", "new-session", "t-old"]]) {
      await controls.applyLiveEvent({ kind: "control-event", instanceId, event: {
        type: "sessions-changed", readySessionAlias: alias, readyTransportSession: transport,
      } });
    }
    expect(rpc).toHaveBeenCalledTimes(2);
    pushEvent(ws, { kind: "control-event", instanceId: "i1", event: {
      type: "sessions-changed", readySessionAlias: "new-session", readyTransportSession: "t-new",
    } });
    await vi.waitFor(() => {
      expect(controls.modelCurrent).toBe("model-new");
      expect(controls.modelAvailable).toEqual(["model-new", "model-alt"]);
      expect(controls.effortCurrent).toBe("high");
      expect(controls.effortAvailable).toEqual(["medium", "high"]);
    });
    await controls.applyLiveEvent({ kind: "control-event", instanceId: "i1", event: { type: "sessions-changed" } });
    expect(rpc).toHaveBeenCalledTimes(4);
    disconnect();
  });

  it("retries transient ready-read failures and treats an empty effort catalog as supported absence", async () => {
    seedReadySession();
    let ready = false;
    let modelReads = 0;
    let effortReads = 0;
    rpc.mockImplementation(async (_instanceId: string, type: string) => {
      if (!ready) return { available: [] };
      if (type === "control.session.model.get") {
        if (++modelReads === 1) throw new Error("temporary network failure");
        return { current: "model-new", available: ["model-new"] };
      }
      if (type === "control.session.effort.get") {
        if (++effortReads === 1) return { error: { code: "timeout", message: "temporary read failure" } };
        return { available: [] };
      }
      throw new Error(`unexpected rpc: ${type}`);
    });
    const controls = useSessionControlsStore();
    await Promise.all([controls.loadModel("i1", "new-session"), controls.loadEffort("i1", "new-session")]);
    ready = true;
    await controls.applyLiveEvent({ kind: "control-event", instanceId: "i1", event: {
      type: "sessions-changed", readySessionAlias: "new-session", readyTransportSession: "t-new",
    } });
    expect(controls.modelCurrent).toBe("model-new");
    expect(controls.effortAvailable).toEqual([]);
    expect(modelReads).toBe(2);
    expect(effortReads).toBe(2);
    await controls.applyLiveEvent({ kind: "control-event", instanceId: "i1", event: { type: "sessions-changed" } });
    expect(modelReads).toBe(2);
    expect(effortReads).toBe(2);
  });

  it("bounds failed ready reads and permits a later explicit readiness refresh", async () => {
    seedReadySession();
    rpc.mockResolvedValue({ available: [] });
    const controls = useSessionControlsStore();
    await Promise.all([controls.loadModel("i1", "new-session"), controls.loadEffort("i1", "new-session")]);
    rpc.mockRejectedValue(new Error("offline"));
    const event: WebServerEvent = { kind: "control-event", instanceId: "i1", event: {
      type: "sessions-changed", readySessionAlias: "new-session", readyTransportSession: "t-new",
    } };
    await controls.applyLiveEvent(event);
    expect(rpc).toHaveBeenCalledTimes(8);
    expect(controls.modelCurrent).toBeUndefined();
    rpc.mockImplementation(async (_id: string, type: string) => type === "control.session.model.get"
      ? { current: "recovered", available: ["recovered"] }
      : { current: "high", available: ["high"] });
    await controls.applyLiveEvent(event);
    expect(controls.modelCurrent).toBe("recovered");
    expect(controls.effortCurrent).toBe("high");
  });

  it("drops a ready refresh when its incarnation changes while a mutation is pending", async () => {
    seedReadySession();
    rpc.mockResolvedValue({ available: [] });
    const controls = useSessionControlsStore();
    await Promise.all([controls.loadModel("i1", "new-session"), controls.loadEffort("i1", "new-session")]);
    const pendingSet = Promise.withResolvers<unknown>();
    rpc.mockImplementation((_id: string, type: string) => type === "control.session.model.set"
      ? pendingSet.promise
      : Promise.resolve({ current: "replacement", available: ["replacement"] }));
    const setting = controls.setModel("i1", "new-session", "chosen");
    const refreshing = controls.applyLiveEvent({ kind: "control-event", instanceId: "i1", event: {
      type: "sessions-changed", readySessionAlias: "new-session", readyTransportSession: "t-new",
    } });
    useInstancesStore().instances[0]!.sessions[0]!.transportSession = "t-replacement";
    pendingSet.resolve({ ok: true, current: "chosen" });
    await setting;
    await refreshing;
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(controls.modelCurrent).toBe("chosen");
  });

  it("discards in-flight ready GET results after incarnation replacement without poisoning rollback or snapshots", async () => {
    seedReadySession();
    const username = "ready-in-flight-incarnation";
    useAuthStore().account = { username };
    rpc.mockImplementation(async (_id: string, type: string) => type === "control.session.model.get"
      ? { current: "baseline-model", available: ["baseline-model"] }
      : { current: "medium", available: ["medium"] });
    const controls = useSessionControlsStore();
    await Promise.all([controls.loadModel("i1", "new-session"), controls.loadEffort("i1", "new-session")]);
    const modelGet = Promise.withResolvers<unknown>();
    const effortGet = Promise.withResolvers<unknown>();
    rpc.mockImplementation((_id: string, type: string) => type === "control.session.model.get"
      ? modelGet.promise : effortGet.promise);
    const refreshing = controls.applyLiveEvent({ kind: "control-event", instanceId: "i1", event: {
      type: "sessions-changed", readySessionAlias: "new-session", readyTransportSession: "t-new",
    } });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(4));
    useInstancesStore().instances[0]!.sessions[0]!.transportSession = "t-replacement";
    modelGet.resolve({ current: "stale-model", available: ["stale-model"] });
    effortGet.resolve({ current: "high", available: ["high"] });
    await refreshing;

    expect(controls.modelCurrent).toBe("baseline-model");
    expect(controls.modelAvailable).toEqual(["baseline-model"]);
    expect(controls.effortCurrent).toBe("medium");
    expect(controls.effortAvailable).toEqual(["medium"]);
    expect(controls.modelLoading).toBe(false);
    expect(controls.effortLoading).toBe(false);
    expect(await readViewSnapshot(username, "session-model", "i1", "new-session"))
      .toEqual({ current: "baseline-model", available: ["baseline-model"] });
    expect(await readViewSnapshot(username, "session-effort", "i1", "new-session"))
      .toEqual({ current: "medium", available: ["medium"] });

    rpc.mockResolvedValue({ error: { code: "internal", message: "set failed" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(controls.setEffort("i1", "new-session", "low")).resolves.toBe(false);
      await expect(controls.setModel("i1", "new-session", "chosen")).resolves.toBe(false);
      expect(controls.modelCurrent).toBe("baseline-model");
      expect(controls.effortCurrent).toBe("medium");
    } finally {
      log.mockRestore();
    }
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