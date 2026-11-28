import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    get: async (path: string) => {
      const res = await fetch(path, { credentials: "include" });
      return res.json();
    },
    rpc: (instanceId: string, type: string, payload?: unknown) => rpc(instanceId, type, payload),
  },
}));

import { sessionKeyFor, useChatStore } from "../stores/chat";

function emptyHistory() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 })),
  );
}

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
  localStorage.clear();
  emptyHistory();
});

describe("chat multi-pane (Milestone 2B)", () => {
  it("exposes sessionKeyFor and per-session pane state", () => {
    expect(sessionKeyFor("i1", "backend")).toBe("i1::backend");
    const store = useChatStore();
    const pane = store.getSessionState("i1", "backend");
    expect(pane.messages).toEqual([]);
    expect(pane.hasMoreOlder).toBe(false);
    expect(pane.loadingOlder).toBe(false);
    expect(pane.loadingHistory).toBe(false);
    expect(pane.historyCapped).toBeNull();
    expect(pane.error).toBe("");
    expect(pane.sending).toBe(false);
    expect(store.sessionsByKey["i1::backend"]).toBe(pane);
  });

  it("keeps top-level refs as proxies for the selected key", async () => {
    const store = useChatStore();
    store.select("i1", "A");
    expect(store.sessionsByKey["i1::A"]).toBeDefined();
    // Proxy writes land in the selected pane.
    store.messages = [{ instanceId: "i1", sessionAlias: "A", direction: "in", text: "hi", createdAt: "t" }];
    expect(store.getSessionState("i1", "A").messages.map((m) => m.text)).toEqual(["hi"]);
    store.error = "boom";
    expect(store.getSessionState("i1", "A").error).toBe("boom");
    store.sending = true;
    expect(store.getSessionState("i1", "A").sending).toBe(true);
    store.hasMoreOlder = true;
    expect(store.getSessionState("i1", "A").hasMoreOlder).toBe(true);

    // Switching selection switches the proxy; other panes keep their state.
    store.select("i1", "B");
    expect(store.messages).toEqual([]);
    expect(store.error).toBe("");
    expect(store.getSessionState("i1", "A").messages.map((m) => m.text)).toEqual(["hi"]);
  });

  it("parallel streaming into two panes does not clobber", () => {
    const store = useChatStore();
    store.select("inst", "A");
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst",
      event: { type: "turn-output", chatKey: "x", sessionAlias: "A", chunk: "partial-A" },
    });
    // Background session streams without disturbing the selected proxy.
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst",
      event: { type: "turn-output", chatKey: "x", sessionAlias: "B", chunk: "partial-B" },
    });
    expect(store.streaming).toBe("partial-A");
    store.select("inst", "B");
    expect(store.streaming).toBe("partial-B");
    store.select("inst", "A");
    expect(store.streaming).toBe("partial-A");

    // Finishing each turn flushes into its own pane.
    store.select("inst", "A");
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst",
      event: { type: "turn-finished", chatKey: "x", sessionAlias: "A", ok: true },
    });
    expect(store.getSessionState("inst", "A").messages.at(-1)).toMatchObject({
      direction: "out",
      text: "partial-A",
    });
    // B's live turn is untouched by A's finish.
    store.select("inst", "B");
    expect(store.streaming).toBe("partial-B");
  });

  it("sendPromptFor routes by explicit key without moving selection", async () => {
    rpc.mockResolvedValue({ ok: true });
    const store = useChatStore();
    store.select("inst", "A");
    await store.sendPromptFor("inst", "B", "hello B");
    expect(store.sessionAlias).toBe("A");
    expect(store.getSessionState("inst", "B").messages.map((m) => m.text)).toEqual(["hello B"]);
    expect(store.getSessionState("inst", "A").messages).toEqual([]);
    expect(rpc).toHaveBeenCalledWith("inst", "control.prompt", {
      sessionAlias: "B",
      text: "hello B",
    });

    // Concurrent prompts into both panes stay isolated.
    rpc.mockResolvedValue({ ok: true });
    await Promise.all([
      store.sendPromptFor("inst", "A", "hello A"),
      store.sendPromptFor("inst", "B", "second B"),
    ]);
    expect(store.getSessionState("inst", "A").messages.map((m) => m.text)).toEqual(["hello A"]);
    expect(store.getSessionState("inst", "B").messages.map((m) => m.text)).toEqual(["hello B", "second B"]);
  });

  it("ensureSessionLoaded + loadOlderFor operate on explicit panes", async () => {
    const store = useChatStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (typeof path === "string" && path.includes("/sessions/B/messages?limit=")) {
          return new Response(
            JSON.stringify({
              messages: [{ id: 2, instanceId: "i1", sessionAlias: "B", direction: "out", text: "newest", createdAt: "t" }],
              hasMore: true,
            }),
            { status: 200 },
          );
        }
        if (typeof path === "string" && path.includes("before=2")) {
          return new Response(
            JSON.stringify({
              messages: [{ id: 1, instanceId: "i1", sessionAlias: "B", direction: "out", text: "older", createdAt: "t" }],
              hasMore: false,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 });
      }),
    );
    await store.ensureSessionLoaded("i1", "B");
    expect(store.getSessionState("i1", "B").messages.map((m) => m.text)).toEqual(["newest"]);
    expect(store.getSessionState("i1", "B").hasMoreOlder).toBe(true);
    // Selection untouched.
    expect(store.instanceId).toBeNull();

    await store.loadOlderFor("i1", "B");
    expect(store.getSessionState("i1", "B").messages.map((m) => m.text)).toEqual(["older", "newest"]);
  });

  it("cancelTurnFor clears the explicit pane turn without touching selection", async () => {
    rpc.mockResolvedValue({ cancelled: true });
    const store = useChatStore();
    store.select("inst", "A");
    // Seed a live turn for background session B via explicit event routing (liveTurns keyed).
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst",
      event: { type: "turn-output", chatKey: "x", sessionAlias: "B", chunk: "bg-partial" },
    });
    await store.cancelTurnFor("inst", "B");
    expect(rpc).toHaveBeenCalledWith("inst", "control.prompt.cancel", { sessionAlias: "B" });
    // Selected session A was never busy.
    expect(store.sessionAlias).toBe("A");
    expect(store.busy).toBe(false);
  });
});
