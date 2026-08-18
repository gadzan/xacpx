import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";
import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";

function makeDeps(
  chat: (req: any) => Promise<{ text?: string }>,
  getSession?: (alias: string) => Promise<any>,
) {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const deps = {
    agent: { chat },
    sessions: {
      listAllResolvedSessions: () => [],
      removeSession: async () => ({ wasActive: false }),
      useSession: async () => ({
        alias: "backend",
        agent: "claude",
        workspace: "/ws",
      }),
      resolveAliasForChat: async (_c: string, a: string) => a,
      getSession: getSession ?? (async () => null),
    },
    createSessionWithTransport: async () => ({}),
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {
      listPending: () => [],
      createTask: async () => ({}),
      cancelPending: async () => false,
    },
    orchestration: {
      listTasks: async () => [],
      getTask: async () => null,
      requestTaskCancellation: async () => ({}),
    },
    agents: {
      list: () => [],
      catalog: () => [],
      create: async () => ({}),
      remove: async () => {},
    },
    workspaces: {
      list: () => [],
      create: async () => ({}),
      remove: async () => {},
    },
    events,
  };
  return { deps, seen };
}

test("prompt emits turn-started and forwards tool/thought events", async () => {
  const { deps, seen } = makeDeps(async (req) => {
    await req.onToolEvent?.({
      toolCallId: "t1",
      toolName: "Read",
      kind: "read",
      status: "success",
    });
    await req.onThought?.("thinking…");
    await req.reply("hello");
    return { text: "" };
  });
  const control = new ControlService(deps as never);
  await control.prompt({
    chatKey: "relay:a",
    sessionAlias: "backend",
    text: "hi",
    senderId: "s",
  });

  const types = seen.map((e) => e.type);
  expect(types[0]).toBe("turn-started");
  expect(types).toContain("tool-event");
  expect(types).toContain("turn-thought");
  expect(types.at(-1)).toBe("turn-finished");
  const tool = seen.find((e) => e.type === "tool-event") as Extract<
    ControlEvent,
    { type: "tool-event" }
  >;
  expect(tool.event.toolCallId).toBe("t1");
});

test("forwards an agent plan update as a plan ControlEvent", async () => {
  const { deps, seen } = makeDeps(async (req) => {
    await req.onPlan?.([{ content: "step", status: "in_progress" }]);
    await req.reply("hello");
    return { text: "" };
  });
  const control = new ControlService(deps as never);
  await control.prompt({
    chatKey: "relay:a",
    sessionAlias: "backend",
    text: "hi",
    senderId: "s",
  });

  expect(seen).toContainEqual({
    type: "plan",
    chatKey: "relay:a",
    sessionAlias: "backend",
    entries: [{ content: "step", status: "in_progress" }],
  });
});

test("an aborted turn finishes with cancelled:true", async () => {
  const { deps, seen } = makeDeps(async (req) => {
    const err = new Error("aborted");
    req.abortSignal?.dispatchEvent?.(new Event("abort"));
    throw err;
  });
  const control = new ControlService(deps as never);
  const p = control.prompt({
    chatKey: "relay:a",
    sessionAlias: "backend",
    text: "hi",
    senderId: "s",
  });
  control.cancelTurn("relay:a", "backend"); // aborts the in-flight controller
  await p;
  const fin = seen.find((e) => e.type === "turn-finished") as Extract<
    ControlEvent,
    { type: "turn-finished" }
  >;
  expect(fin.cancelled).toBe(true);
});

test("stream-mode session (effectiveReplyMode) concatenates reply chunks verbatim", async () => {
  // A relay session whose effectiveReplyMode resolves to "stream" must NOT have
  // "\n\n" re-inserted between chunks — the streaming dashboard concatenates as-is.
  const { deps, seen } = makeDeps(
    async (req) => {
      await req.reply("| a | b |");
      await req.reply("| - | - |");
      return { text: "" };
    },
    async () => ({ effectiveReplyMode: "stream", replyMode: undefined }),
  );
  const control = new ControlService(deps as never);
  await control.prompt({
    chatKey: "relay:a",
    sessionAlias: "backend",
    text: "hi",
    senderId: "s",
  });

  const outputs = seen
    .filter((e) => e.type === "turn-output")
    .map((e) => (e as Extract<ControlEvent, { type: "turn-output" }>).chunk);
  expect(outputs).toEqual(["| a | b |", "| - | - |"]);
  expect(outputs.some((c) => c.startsWith("\n\n"))).toBe(false);
});

test("non-stream session re-inserts \\n\\n between batched reply chunks", async () => {
  // Sanity check the batched path is still intact for non-stream sessions.
  const { deps, seen } = makeDeps(
    async (req) => {
      await req.reply("para one");
      await req.reply("para two");
      return { text: "" };
    },
    async () => ({ effectiveReplyMode: undefined, replyMode: "verbose" }),
  );
  const control = new ControlService(deps as never);
  await control.prompt({
    chatKey: "relay:a",
    sessionAlias: "backend",
    text: "hi",
    senderId: "s",
  });

  const outputs = seen
    .filter((e) => e.type === "turn-output")
    .map((e) => (e as Extract<ControlEvent, { type: "turn-output" }>).chunk);
  expect(outputs).toEqual(["para one", "\n\npara two"]);
});
