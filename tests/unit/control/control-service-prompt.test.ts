import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import type { ChatRequest, ChatResponse } from "../../../src/weixin/agent/interface";

function makeControl(chatImpl: (request: ChatRequest) => Promise<ChatResponse>) {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const used: string[] = [];
  const control = new ControlService({
    agent: { chat: chatImpl },
    sessions: {
      listAllResolvedSessions: () => [],
      createSession: async () => {
        throw new Error("unused");
      },
      removeSession: async () => ({ wasActive: false }),
      useSession: async (chatKey: string, alias: string) => {
        if (alias === "missing") throw new Error("unknown session");
        used.push(`${chatKey}:${alias}`);
        return { alias, agent: "claude", workspace: "/ws" };
      },
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);
  return { control, seen, used };
}

test("prompt binds session, streams chunks as events, and reports completion", async () => {
  let captured: ChatRequest | undefined;
  const { control, seen, used } = makeControl(async (request) => {
    captured = request;
    await request.reply?.("chunk-1");
    return { text: "final" };
  });

  const result = await control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "run tests",
    senderId: "acct-1",
    isOwner: true,
  });

  expect(result).toEqual({ ok: true, text: "final" });
  expect(used).toEqual(["relay:acct-1:backend"]);
  expect(captured?.conversationId).toBe("relay:acct-1");
  expect(captured?.metadata).toEqual({
    channel: "control",
    chatType: "direct",
    senderId: "acct-1",
    isOwner: true,
  });
  expect(seen).toEqual([
    { type: "turn-started", chatKey: "relay:acct-1", sessionAlias: "backend" },
    { type: "turn-output", chatKey: "relay:acct-1", sessionAlias: "backend", chunk: "chunk-1" },
    // Subsequent chunks carry the restored paragraph break (segments arrive trimmed).
    { type: "turn-output", chatKey: "relay:acct-1", sessionAlias: "backend", chunk: "\n\nfinal" },
    // turn-finished carries the FULL accumulated reply (emitted chunks + response.text)
    // for hub-side fallback persistence — not just response.text, which streaming
    // adapters may leave undefined.
    { type: "turn-finished", chatKey: "relay:acct-1", sessionAlias: "backend", ok: true, text: "chunk-1\n\nfinal" },
  ]);
});

function makeControlWithArchived(archived: boolean) {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const control = new ControlService({
    agent: { chat: async () => ({ text: "ok" }) },
    sessions: {
      listAllResolvedSessions: () => [],
      createSession: async () => { throw new Error("unused"); },
      removeSession: async () => ({ wasActive: false }),
      useSession: async () => ({ alias: "backend", agent: "claude", workspace: "/ws" }),
      resolveAliasForChat: async (_chatKey: string, alias: string) => `relay:${alias}`,
      getSession: async () => ({ alias: "relay:backend", agent: "claude", workspace: "/ws", archived }),
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);
  return { control, seen };
}

test("prompting an archived session emits sessions-changed so the dashboard drops the stale badge", async () => {
  // useSession un-archives on message but emits nothing; without this the sidebar keeps
  // showing the "archived" badge until an unrelated refresh.
  const { control, seen } = makeControlWithArchived(true);
  await control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "hi", senderId: "acct-1" });
  expect(seen.some((e) => e.type === "sessions-changed")).toBe(true);
});

test("prompting a non-archived session does NOT emit sessions-changed (no needless refresh)", async () => {
  const { control, seen } = makeControlWithArchived(false);
  await control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "hi", senderId: "acct-1" });
  expect(seen.some((e) => e.type === "sessions-changed")).toBe(false);
});

function makeControlWithTransportChange(opts: { changes: boolean }) {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  // Model `/clear`: the turn (agent.chat) recreates the transport session under the same
  // alias, so getSession returns a new transportSession on the post-turn read.
  let reads = 0;
  const control = new ControlService({
    agent: { chat: async () => ({ text: "会话已重置" }) },
    sessions: {
      listAllResolvedSessions: () => [],
      createSession: async () => { throw new Error("unused"); },
      removeSession: async () => ({ wasActive: false }),
      useSession: async () => ({ alias: "backend", agent: "claude", workspace: "/ws" }),
      resolveAliasForChat: async (_chatKey: string, alias: string) => `relay:${alias}`,
      getSession: async () => {
        reads += 1;
        const transportSession = opts.changes && reads > 1 ? "/ws:backend:reset-2" : "/ws:backend";
        return { alias: "relay:backend", agent: "claude", workspace: "/ws", transportSession };
      },
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);
  return { control, seen };
}

test("a control-channel /clear (transport session recreated) emits sessions-changed", async () => {
  // session.reset rebuilds the transport session mid-turn; without this the dashboard row
  // keeps showing the stale transport id / native binding until an unrelated refresh.
  const { control, seen } = makeControlWithTransportChange({ changes: true });
  await control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "/clear", senderId: "acct-1" });
  expect(seen.some((e) => e.type === "sessions-changed")).toBe(true);
});

test("an ordinary prompt (transport session unchanged) does NOT emit sessions-changed", async () => {
  const { control, seen } = makeControlWithTransportChange({ changes: false });
  await control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "hi", senderId: "acct-1" });
  expect(seen.some((e) => e.type === "sessions-changed")).toBe(false);
});

test("multi-paragraph reply: each segment after the first restores the \\n\\n break", async () => {
  // Regression: the transport strips paragraph boundaries when splitting into
  // trimmed segments. Concatenating bare segments ran paragraphs together; the
  // control layer re-inserts "\n\n" so web live + persisted history reconstruct
  // the original structure.
  const { control, seen } = makeControl(async (request) => {
    await request.reply?.("Paragraph one.");
    await request.reply?.("Paragraph two.");
    await request.reply?.("Paragraph three.");
    return { text: "" }; // streaming mode: final text already pushed via reply()
  });

  await control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "explain",
    senderId: "acct-1",
    isOwner: true,
  });

  const chunks = seen.filter((e) => e.type === "turn-output").map((e) => (e as { chunk: string }).chunk);
  expect(chunks).toEqual(["Paragraph one.", "\n\nParagraph two.", "\n\nParagraph three."]);
  // Accumulating the chunks (as web + hub both do) yields proper paragraphs.
  expect(chunks.join("")).toBe("Paragraph one.\n\nParagraph two.\n\nParagraph three.");
});

test("stream-mode session emits chunks verbatim (no paragraph reinsertion)", async () => {
  // Raw streaming: the transport already forwards chunks with their real breaks, so the
  // control layer must NOT insert an extra "\n\n" between segments (that would double the
  // blank line and split a single paragraph). Batched sessions still get reinsertion.
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const control = new ControlService({
    agent: {
      chat: async (request: ChatRequest) => {
        await request.reply?.("Para one.\n\n");
        await request.reply?.("Para two.");
        return { text: "" };
      },
    },
    sessions: {
      listAllResolvedSessions: () => [],
      useSession: async () => ({ alias: "backend", agent: "claude", workspace: "/ws" }),
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias,
      getSession: async () => ({ alias: "backend", agent: "claude", workspace: "/ws", replyMode: "stream" }),
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);

  await control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "hi", senderId: "acct-1" });

  const chunks = seen.filter((e) => e.type === "turn-output").map((e) => (e as { chunk: string }).chunk);
  expect(chunks).toEqual(["Para one.\n\n", "Para two."]);
  expect(chunks.join("")).toBe("Para one.\n\nPara two.");
});

test("prompt rejects unknown session without emitting turn events", async () => {
  const { control, seen } = makeControl(async () => ({ text: "" }));
  const result = await control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "missing",
    text: "hi",
    senderId: "acct-1",
  });
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("unknown session");
  expect(seen).toHaveLength(0);
});

test("a concurrent prompt while a turn runs is queued; cancelTurn aborts the running turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { control } = makeControl(async (request) => {
    await new Promise<void>((resolve) => {
      request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      void gate.then(resolve);
    });
    if (request.abortSignal?.aborted) throw new Error("aborted");
    return { text: "done" };
  });

  const first = control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "long task",
    senderId: "acct-1",
  });
  await Promise.resolve();

  const second = await control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "again",
    senderId: "acct-1",
  });
  expect(second.ok).toBe(true);
  expect(second.queued).toBe(true);
  expect(typeof second.queueItemId).toBe("string");

  expect(control.cancelTurn("relay:acct-1", "backend")).toBe(true);
  const result = await first;
  expect(result.ok).toBe(false);
  release();
});

test("a follow-up prompt after Stop waits for the cancelled turn to drain, then runs", async () => {
  // Regression: pressing Stop aborts the turn, but the transport teardown (acpx cancel
  // + agent wind-down) is async, so the turn stays in `inFlight` for a moment. The web
  // UI releases its busy state optimistically, so a follow-up message could land in that
  // drain window and used to bounce with "turn-already-running". It must instead wait for
  // the cancelled turn to settle and then start fresh.
  let call = 0;
  let releaseTeardown!: () => void;
  const teardown = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const { control } = makeControl(async (request) => {
    call += 1;
    if (call === 1) {
      // First turn: block until aborted, then simulate a slow teardown before settling.
      // Handle an already-aborted signal too (the abort may land before this listener
      // registers), so the test doesn't depend on microtask ordering.
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) return resolve();
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await teardown; // the turn is still registered while this drains
      throw new Error("aborted");
    }
    return { text: "second-done" };
  });

  const first = control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "long", senderId: "acct-1" });
  await Promise.resolve();
  expect(control.cancelTurn("relay:acct-1", "backend")).toBe(true);

  // Follow-up issued while the first turn is still draining (teardown not yet released).
  const second = control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "next", senderId: "acct-1" });
  await Promise.resolve();

  // Let the first turn finish unwinding; the follow-up should then proceed and succeed.
  releaseTeardown();
  const firstResult = await first;
  expect(firstResult.ok).toBe(false);

  const secondResult = await second;
  expect(secondResult).toEqual({ ok: true, text: "second-done" });
});

test("prompt failure emits turn-finished with the error", async () => {
  const { control, seen } = makeControl(async () => {
    throw new Error("transport exploded");
  });
  const result = await control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "hi",
    senderId: "acct-1",
  });
  expect(result).toEqual({ ok: false, errorMessage: "transport exploded" });
  expect(seen).toContainEqual({
    type: "turn-finished",
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    ok: false,
    errorMessage: "transport exploded",
  });
});

test("executeCommand concatenates reply chunks and final text", async () => {
  const { control } = makeControl(async (request) => {
    expect(request.text).toBe("/status");
    await request.reply?.("part-1");
    await request.reply?.("part-2");
    return { text: "tail" };
  });
  const output = await control.executeCommand({
    chatKey: "relay:acct-1",
    text: "/status",
    senderId: "acct-1",
  });
  expect(output).toBe("part-1\npart-2\ntail");
});

test("two prompts issued in the same tick: exactly one wins, the other is queued", async () => {
  // Regression for the TOCTOU race between `inFlight.has` and `inFlight.set`.
  // The guard must register synchronously, BEFORE the `await useSession`,
  // otherwise both calls slip past the guard while awaiting the session bind.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { control } = makeControl(async (request) => {
    await new Promise<void>((resolve) => {
      request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      void gate.then(resolve);
    });
    return { text: "done" };
  });

  // Both invoked in the SAME synchronous tick — no await in between. With the
  // race present, both would pass the `has` guard before either ran `set`.
  const promiseA = control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "first",
    senderId: "acct-1",
  });
  const promiseB = control.prompt({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    text: "second",
    senderId: "acct-1",
  });

  // Let the winning (gated) turn's agent.chat complete so neither promise hangs.
  release();
  const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
  const queued = [resultA, resultB].filter((r) => r.ok === true && r.queued === true);
  expect(queued).toHaveLength(1);
});
