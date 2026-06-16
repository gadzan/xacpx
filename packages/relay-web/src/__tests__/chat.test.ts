// packages/relay-web/src/__tests__/chat.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, it, test, vi } from "vitest";
import { mount } from "@vue/test-utils";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    // Keep get working against the fetch stub used by loadHistory.
    get: async (path: string) => {
      const res = await fetch(path, { credentials: "include" });
      return res.json();
    },
    rpc: (instanceId: string, type: string, payload?: unknown) => rpc(instanceId, type, payload),
  },
}));

import { useChatStore, loadPersistedSelection } from "../stores/chat";
import { ApiError } from "../api/client";
import PromptInput from "../components/PromptInput.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

test("streaming turn output accumulates then commits on finish", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hel" } });
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "lo" } });
  expect(store.streaming).toBe("hello");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true } });
  expect(store.streaming).toBe("");
  expect(store.messages.at(-1)).toMatchObject({ direction: "out", text: "hello" });
});

test("events for a different session are ignored", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "x", sessionAlias: "other", chunk: "nope" } });
  expect(store.streaming).toBe("");
});

test("loadHistory pulls cached messages for the selected session", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    messages: [{ instanceId: "i1", sessionAlias: "backend", direction: "in", text: "hi", createdAt: "t" }],
  }), { status: 200 })));
  const store = useChatStore();
  store.select("i1", "backend");
  await store.loadHistory();
  expect(store.messages.map((m) => m.text)).toEqual(["hi"]);
});

test("seedActiveTurns rebuilds a live turn (working dot + HUD) lost on refresh", () => {
  const store = useChatStore();
  store.seedActiveTurns([
    { instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 1000, parts: [{ type: "text", text: "half-written" }] },
  ]);
  // The sidebar "working" dot lights up without the session being selected.
  expect(store.sessionAttention("i1", "backend")).toBe("working");
  expect(store.runningSince("i1", "backend")).toBe(1000);
  // Selecting the running session shows its live content + the busy HUD.
  store.select("i1", "backend");
  expect(store.busy).toBe(true);
  expect(store.streaming).toBe("half-written");
  // A later turn-finished finalizes the seeded turn into a persisted message.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a", sessionAlias: "backend", ok: true } });
  expect(store.busy).toBe(false);
  expect(store.messages.at(-1)).toMatchObject({ direction: "out", text: "half-written" });
});

test("a turn-finished racing ahead of seedActiveTurns does not resurrect the finished turn", () => {
  // Regression (review H1): the ws stream is live before the active-turns snapshot is
  // applied. If turn-finished arrives in that gap, seeding the stale snapshot must NOT
  // re-create the turn (which would wedge the session "working" forever). A different,
  // un-finished session in the same snapshot must still seed normally.
  const store = useChatStore();
  // The finish already arrived (no live turn existed to flush); then the stale snapshot lands.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a", sessionAlias: "raced", ok: true } });
  store.seedActiveTurns([
    { instanceId: "i1", sessionAlias: "raced", status: "streaming", startedAt: 1, parts: [{ type: "text", text: "stale" }] },
    { instanceId: "i1", sessionAlias: "fresh", status: "streaming", startedAt: 1, parts: [{ type: "text", text: "live" }] },
  ]);
  expect(store.sessionAttention("i1", "raced")).not.toBe("working"); // not resurrected
  expect(store.sessionAttention("i1", "fresh")).toBe("working"); // guard isn't over-broad
});

test("loadActiveTurns fetches the in-flight snapshot and seeds it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    turns: [{ instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 5, parts: [{ type: "text", text: "live" }] }],
  }), { status: 200 })));
  const store = useChatStore();
  await store.loadActiveTurns();
  expect(store.sessionAttention("i1", "backend")).toBe("working");
  store.select("i1", "backend");
  expect(store.streaming).toBe("live");
});

test("select persists the open session so a refresh can restore it", () => {
  const store = useChatStore();
  store.select("i9", "frontend");
  expect(loadPersistedSelection()).toEqual({ instanceId: "i9", alias: "frontend" });
});

test("surfaces an error when send fails", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("inst", "backend");
  await chat.send("hello");
  expect(chat.error).toBe("instance-offline");
  expect(chat.sending).toBe(false);
});

test("a prompt RPC timeout does not surface an error (results stream via events)", async () => {
  rpc.mockRejectedValueOnce(new ApiError("timeout", 504));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("hi");
  expect(chat.error).toBe("");
  expect(chat.messages.at(-1)?.failed).toBeUndefined(); // optimistic msg not marked failed
  expect(chat.sending).toBe(false);
});

test("a non-timeout prompt error still surfaces", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("hi");
  expect(chat.error).toBe("instance-offline");
  expect(chat.messages.at(-1)?.failed).toBe(true);
});

test("a /command timeout still surfaces (request/response, no streaming)", async () => {
  rpc.mockRejectedValueOnce(new ApiError("timeout", 504));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("/status");
  expect(chat.error).toBe("timeout");
  expect(chat.messages.at(-1)?.failed).toBe(true);
});

test("keeps a per-session streaming buffer across selection changes", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "relay:x", sessionAlias: "A", chunk: "partial-A" } });
  chat.select("inst", "B");
  expect(chat.streaming).toBe("");
  chat.select("inst", "A");
  expect(chat.streaming).toBe("partial-A");
});

test("command send carries sessionAlias", async () => {
  rpc.mockResolvedValueOnce({ output: "ok" });
  const chat = useChatStore();
  chat.select("inst", "backend");
  await chat.send("/status");
  expect(rpc).toHaveBeenCalledWith("inst", "control.command.execute", { sessionAlias: "backend", text: "/status" });
});

it("drops an instance's stream buffers when it goes offline", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "relay:x", sessionAlias: "A", chunk: "partial" } });
  expect(chat.streaming).toBe("partial");
  chat.applyEvent({ kind: "instance-status", instanceId: "inst", online: false });
  expect(chat.streaming).toBe("");
});

it("keys buffers by NUL so space-containing names do not collide", () => {
  const chat = useChatStore();
  chat.select("a b", "c");
  chat.applyEvent({ kind: "control-event", instanceId: "a b", event: { type: "turn-output", chatKey: "relay:x", sessionAlias: "c", chunk: "X" } });
  chat.select("a", "b c");
  // With a space delimiter both would map to "a b c" and collide; with NUL they are distinct.
  expect(chat.streaming).toBe("");
});

it("turn-finished with ok:false surfaces an error and marks the tail failed", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "c", sessionAlias: "A", chunk: "partial" } });
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-finished", chatKey: "c", sessionAlias: "A", ok: false, errorMessage: "boom" } });
  expect(chat.error).toBe("boom");
  const last = chat.messages[chat.messages.length - 1];
  expect(last?.failed ?? false).toBe(true);
});

it("turn-finished with ok:true does not set error", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "c", sessionAlias: "A", chunk: "hi" } });
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-finished", chatKey: "c", sessionAlias: "A", ok: true } });
  expect(chat.error).toBe("");
  expect(chat.messages[chat.messages.length - 1].failed ?? false).toBe(false);
});

it("clears error on session select", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.error = "stale";
  chat.select("inst", "B");
  expect(chat.error).toBe("");
});

it("marks the optimistic message failed when send rejects", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("inst", "A");
  await chat.send("hello");
  const last = chat.messages[chat.messages.length - 1];
  expect(last.direction).toBe("in");
  expect(last.failed).toBe(true);
  expect(chat.error).toBe("instance-offline");
});

it("cancel sends control.prompt.cancel for the selected session", async () => {
  rpc.mockResolvedValueOnce({ cancelled: true });
  const chat = useChatStore();
  chat.select("inst", "A");
  await chat.cancel();
  expect(rpc).toHaveBeenCalledWith("inst", "control.prompt.cancel", { sessionAlias: "A" });
});

it("cancel surfaces an error code on failure", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("inst", "A");
  await chat.cancel();
  expect(chat.error).toBe("instance-offline");
});

it("cancel optimistically releases busy and preserves streamed content; the late echo is a no-op", async () => {
  rpc.mockResolvedValueOnce({ cancelled: true });
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-started", chatKey: "c", sessionAlias: "A" } } as never);
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "c", sessionAlias: "A", chunk: "half a" } } as never);
  expect(chat.busy).toBe(true);
  await chat.cancel();
  // input/HUD release immediately, without waiting for any server turn-finished echo
  expect(chat.busy).toBe(false);
  const flushed = chat.messages.at(-1);
  expect(flushed).toMatchObject({ direction: "out", text: "half a", status: "cancelled" });
  // a server echo arriving afterwards must not double-render
  const before = chat.messages.length;
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-finished", chatKey: "c", sessionAlias: "A", ok: false, cancelled: true } } as never);
  expect(chat.messages.length).toBe(before);
});

it("cancel is a no-op with no session selected", async () => {
  const chat = useChatStore();
  await chat.cancel();
  expect(rpc).not.toHaveBeenCalled();
});

test("PromptInput emits send with trimmed text and clears", async () => {
  const wrapper = mount(PromptInput);
  await wrapper.find("textarea").setValue("  do it  ");
  await wrapper.find("form").trigger("submit.prevent");
  expect(wrapper.emitted("send")?.[0]).toEqual(["do it"]);
  expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
});

test("live turn accumulates tool steps, reasoning, and flushes structured on finish", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  expect(store.busy).toBe(true);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "tool-event", chatKey: "c", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "running", title: "ls" } } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "tool-event", chatKey: "c", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" } } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-thought", chatKey: "c", sessionAlias: "backend", chunk: "reasoning" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "answer" } } as never);
  // Parts preserve arrival order: tool, then reasoning, then text.
  expect(store.liveTurn?.parts.map((p) => p.type)).toEqual(["tool", "reasoning", "text"]);
  expect(store.liveToolSteps.length).toBe(1);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: true } } as never);
  expect(store.busy).toBe(false);
  expect(store.liveTurn).toBeNull();
  const last = store.messages.at(-1)!;
  expect(last).toMatchObject({ direction: "out", text: "answer", status: "done" });
  expect(last.structured?.toolSteps.length).toBe(1);
  expect(last.structured?.reasoning).toBe("reasoning");
  // The ordered transcript is persisted for inline replay on history reload.
  expect(last.structured?.parts?.map((p) => p.type)).toEqual(["tool", "reasoning", "text"]);
});

test("a cancelled finish marks the turn stopped, not errored", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "partial" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: false, cancelled: true } } as never);
  expect(store.error).toBe("");
  expect(store.messages.at(-1)).toMatchObject({ status: "cancelled", text: "partial" });
});

test("PromptInput stays composable while busy but shows Stop and blocks send", async () => {
  const wrapper = mount(PromptInput, { props: { busy: true } });
  // Textarea is intentionally enabled while busy (pre-compose / Esc-to-stop).
  expect((wrapper.find("textarea").element as HTMLTextAreaElement).disabled).toBe(false);
  expect(wrapper.find('[data-test="composer-stop"]').exists()).toBe(true);
  await wrapper.find("textarea").setValue("queued while busy");
  await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
  expect(wrapper.emitted("send")).toBeFalsy(); // submit no-ops while busy
});

test("PromptInput Stop button and Esc-while-busy emit cancel", async () => {
  const wrapper = mount(PromptInput, { props: { busy: true } });
  await wrapper.find('[data-test="composer-stop"]').trigger("click");
  await wrapper.find("textarea").trigger("keydown", { key: "Escape" });
  expect(wrapper.emitted("cancel")?.length).toBe(2);
});

test("a finished turn on an unviewed session becomes unread, and select clears it", () => {
  const store = useChatStore();
  store.select("i1", "backend"); // viewing backend, not frontend
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("unread");
  expect(store.sessionAttention("i1", "backend")).toBe("idle"); // viewed → no unread
  store.select("i1", "frontend");
  expect(store.sessionAttention("i1", "frontend")).toBe("idle");
});

test("working (a live turn) outranks unread", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("unread");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "frontend" } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("working");
});

test("an instance going offline clears its unread signals", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("unread");
  store.applyEvent({ kind: "instance-status", instanceId: "i1", online: false } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("idle");
});

test("a cancelled turn on an unviewed session does NOT mark unread", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: false, cancelled: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("idle");
});
