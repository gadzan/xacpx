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

test("a scheduled turn-started surfaces its prompt as a badged inbound message (selected session)", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend",
    prompt: "summarize commits", scheduled: { taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z" },
  } } as never);
  const last = store.messages.at(-1)!;
  expect(last).toMatchObject({ direction: "in", text: "summarize commits", scheduled: { taskId: "ab12" } });
});

test("a scheduled turn-started for an unselected session does not pollute the open transcript", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-started", chatKey: "relay:a1", sessionAlias: "other",
    prompt: "do thing", scheduled: { taskId: "zz99", executeAt: "2026-06-16T09:00:00.000Z" },
  } } as never);
  expect(store.messages.some((m) => m.text === "do thing")).toBe(false);
});

test("turn-usage updates sessionUsage (REPLACE) and survives turn-finished", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "relay:a1", sessionAlias: "backend", used: 34606, size: 200000 } } as never);
  expect(store.sessionUsage).toEqual({ used: 34606, size: 200000 });
  // The model corrects the window mid-turn → latest wins.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "relay:a1", sessionAlias: "backend", used: 34612, size: 1000000 } } as never);
  expect(store.sessionUsage).toEqual({ used: 34612, size: 1000000 });
  // Persists past turn-finished (session-scoped, decoupled from the live turn).
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true } });
  expect(store.sessionUsage).toEqual({ used: 34612, size: 1000000 });
});

test("turn-usage retains cost and breakdown for the selected session", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-usage", chatKey: "relay:a1", sessionAlias: "backend", used: 1000, size: 200000,
    cost: { amount: 0.42, currency: "USD" }, breakdown: { inputTokens: 800, totalTokens: 920 },
  } } as never);
  expect(store.sessionUsage).toEqual({
    used: 1000, size: 200000,
    cost: { amount: 0.42, currency: "USD" }, breakdown: { inputTokens: 800, totalTokens: 920 },
  });
});

test("turn-usage for an unselected session does not leak into sessionUsage", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "relay:a1", sessionAlias: "other", used: 1, size: 2 } } as never);
  expect(store.sessionUsage).toBeNull();
});

test("agent-commands populate sessionCommands for the selected session", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "agent-commands", chatKey: "relay:a1", sessionAlias: "backend",
    commands: [{ name: "compact", description: "Compact" }, { name: "run", hasInput: true }],
  } } as never);
  expect(store.sessionCommands).toEqual([{ name: "compact", description: "Compact" }, { name: "run", hasInput: true }]);
});

test("sessionCommands is empty for a session that advertised none", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  expect(store.sessionCommands).toEqual([]);
});

test("requestScrollToScheduled bumps a nonce-keyed scroll request", () => {
  const store = useChatStore();
  expect(store.scrollRequest).toBeNull();
  store.requestScrollToScheduled("ab12");
  expect(store.scrollRequest).toMatchObject({ taskId: "ab12" });
  const firstNonce = store.scrollRequest!.nonce;
  store.requestScrollToScheduled("ab12");
  expect(store.scrollRequest!.nonce).not.toBe(firstNonce); // repeat clicks re-trigger
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

test("loadHistory records hasMore; loadOlder prepends the older page and updates the cursor", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    calls.push(path);
    if (path.includes("before=")) {
      // Older page: two rows immediately before id 10, and no more remain.
      return new Response(JSON.stringify({
        messages: [
          { id: 8, instanceId: "i1", sessionAlias: "s1", direction: "in", text: "older-a", createdAt: "t" },
          { id: 9, instanceId: "i1", sessionAlias: "s1", direction: "out", text: "older-b", createdAt: "t" },
        ],
        hasMore: false,
      }), { status: 200 });
    }
    // Initial page: most recent row id 10, with older history available.
    return new Response(JSON.stringify({
      messages: [{ id: 10, instanceId: "i1", sessionAlias: "s1", direction: "in", text: "newest", createdAt: "t" }],
      hasMore: true,
    }), { status: 200 });
  }));

  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.loadHistory();
  expect(chat.messages.map((m) => m.text)).toEqual(["newest"]);
  expect(chat.hasMoreOlder).toBe(true);

  await chat.loadOlder();
  // Older rows PREPENDED, oldest-first, ahead of the existing newest row.
  expect(chat.messages.map((m) => m.text)).toEqual(["older-a", "older-b", "newest"]);
  expect(chat.hasMoreOlder).toBe(false);
  // The cursor was the oldest id we held (10).
  expect(calls.some((c) => c.includes("before=10"))).toBe(true);

  // No older remain → loadOlder is now a no-op (no extra fetch).
  const before = calls.length;
  await chat.loadOlder();
  expect(calls.length).toBe(before);
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

test("resend drops the failed attempt and re-sends, leaving one clean entry on success", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  // First attempt fails (non-timeout) → the optimistic user message is marked failed.
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  await chat.send("play");
  const failed = chat.messages.at(-1)!;
  expect(failed.failed).toBe(true);
  expect(chat.messages.filter((m) => m.direction === "in")).toHaveLength(1);

  // Retry succeeds → exactly one "in" entry remains (the failed one was dropped), not two.
  rpc.mockResolvedValueOnce({ ok: true });
  await chat.resend(failed);
  const ins = chat.messages.filter((m) => m.direction === "in");
  expect(ins).toHaveLength(1);
  expect(ins[0]?.text).toBe("play");
  expect(ins[0]?.failed).toBeUndefined();
  expect(chat.error).toBe("");
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

test("a /-prefixed message is a prompt: a timeout is treated as pending, not an error", async () => {
  // `/` commands are no longer request/response — the web forwards them to the agent as
  // prompts, so a 504/timeout means "the turn may still be running" (pending), exactly
  // like a plain prompt, rather than a hard failure.
  rpc.mockRejectedValueOnce(new ApiError("timeout", 504));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("/status");
  expect(chat.error).toBe("");
  expect(chat.messages.at(-1)?.failed).toBeUndefined();
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

test("sends `/`-prefixed text as a prompt (web forwards slash commands to the agent)", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("inst", "backend");
  await chat.send("/status");
  // The web dashboard never invokes xacpx command handling; `/status` streams as a turn.
  expect(rpc).toHaveBeenCalledWith("inst", "control.prompt", { sessionAlias: "backend", text: "/status" });
  expect(rpc).not.toHaveBeenCalledWith("inst", "control.command.execute", expect.anything());
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
  expect(wrapper.emitted("send")?.[0]).toEqual(["do it", []]);
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
  expect(last.structured?.toolSteps?.length).toBe(1);
  expect(last.structured?.reasoning).toBe("reasoning");
  // The ordered transcript is persisted for inline replay on history reload.
  expect(last.structured?.parts?.map((p) => p.type)).toEqual(["tool", "reasoning", "text"]);
});

it("sets the session plan on a plan event and replaces it on the next", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const ev = (entries: unknown) => chat.applyEvent({ kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "relay:i1", sessionAlias: "backend", entries } } as never);
  ev([{ content: "a", status: "in_progress" }]);
  expect(chat.sessionPlan).toEqual([{ content: "a", status: "in_progress" }]);
  ev([{ content: "a", status: "completed" }, { content: "b", status: "pending" }]);
  expect(chat.sessionPlan?.length).toBe(2); // replace, not append
});

it("keeps the session plan after the turn finishes (does not vanish)", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const apply = (event: unknown) => chat.applyEvent({ kind: "control-event", instanceId: "i1", event } as never);
  // a turn is running and emits a plan
  apply({ type: "turn-started", chatKey: "relay:i1", sessionAlias: "backend" });
  apply({ type: "plan", chatKey: "relay:i1", sessionAlias: "backend", entries: [{ content: "a", status: "in_progress" }] });
  expect(chat.sessionPlan?.length).toBe(1);
  expect(chat.busy).toBe(true);
  // turn ends (agent paused to ask a question)
  apply({ type: "turn-finished", chatKey: "relay:i1", sessionAlias: "backend", ok: true });
  // the live turn is gone but the plan persists
  expect(chat.busy).toBe(false);
  expect(chat.sessionPlan?.length).toBe(1);
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

test("blank thought chunks never open an empty reasoning block", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const ev = (event: unknown) => store.applyEvent({ kind: "control-event", instanceId: "i1", event } as never);
  ev({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  // Some models (e.g. glm-5.2) stream empty / whitespace-only thought deltas.
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "   \n" });
  ev({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hi" });
  ev({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  const m = store.messages.at(-1)!;
  expect(m.structured?.reasoning).toBeUndefined();
  expect((m.structured?.parts ?? []).some((p) => p.type === "reasoning")).toBe(false);
});

test("whitespace between non-blank reasoning chunks is preserved", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const ev = (event: unknown) => store.applyEvent({ kind: "control-event", instanceId: "i1", event } as never);
  ev({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "line1" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "\n\n" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "line2" });
  ev({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  expect(store.messages.at(-1)!.structured?.reasoning).toBe("line1\n\nline2");
});
