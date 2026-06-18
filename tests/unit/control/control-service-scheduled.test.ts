import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import type { ScheduledTaskRecord } from "../../../src/scheduled/scheduled-types";

const record: ScheduledTaskRecord = {
  id: "ab12",
  chat_key: "relay:acct-1",
  session_alias: "backend",
  execute_at: "2026-06-14T10:00:00.000Z",
  message: "check CI",
  status: "pending",
  created_at: "2026-06-13T10:00:00.000Z",
};

function makeControl() {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const calls: Record<string, unknown[]> = { create: [], cancel: [], chat: [] };
  const control = new ControlService({
    agent: { chat: async (req: unknown) => { calls.chat.push(req); return { text: "ran ok" }; } },
    sessions: { useSession: async () => {} },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {
      listPending: (chatKey: string) => (chatKey === "relay:acct-1" ? [record] : []),
      listRecentForChat: (chatKey: string) => (chatKey === "relay:acct-1" ? [record] : []),
      createTask: async (input: unknown) => {
        calls.create.push(input);
        return record;
      },
      cancelPending: async (id: string, _chatKey: string) => {
        calls.cancel.push(id);
        return id === "ab12";
      },
    },
    orchestration: {} as never,
    events,
  } as never);
  return { control, seen, calls };
}

test("listScheduledTasks scopes to the chat key (web panel: recent runs included)", () => {
  const { control } = makeControl();
  expect(control.listScheduledTasks("relay:acct-1")).toEqual([record]);
  expect(control.listScheduledTasks("relay:other")).toEqual([]);
});

test("runScheduledTurn streams a real turn tagged with prompt + schedule origin", async () => {
  const { control, seen, calls } = makeControl();
  const result = await control.runScheduledTurn({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    promptText: "summarize commits",
    taskId: "ab12",
    executeAt: "2026-06-14T10:00:00.000Z",
  });
  expect(result).toEqual({ ok: true, text: "ran ok" });
  // The agent ran with the scheduled prompt.
  expect(calls.chat).toHaveLength(1);
  expect((calls.chat[0] as { text: string }).text).toBe("summarize commits");
  // turn-started carries the prompt + origin so the hub persists the inbound message
  // and the web badges it; turn-finished closes the turn.
  const started = seen.find((e) => e.type === "turn-started");
  expect(started).toMatchObject({
    type: "turn-started", chatKey: "relay:acct-1", sessionAlias: "backend",
    prompt: "summarize commits", scheduled: { taskId: "ab12", executeAt: "2026-06-14T10:00:00.000Z" },
  });
  expect(seen.some((e) => e.type === "turn-finished" && e.ok === true)).toBe(true);
});

test("a normal prompt's turn-started carries no scheduled origin", async () => {
  const { control, seen } = makeControl();
  await control.prompt({ chatKey: "relay:acct-1", sessionAlias: "backend", text: "hi", senderId: "acct-1", isOwner: true });
  const started = seen.find((e) => e.type === "turn-started");
  expect(started).toEqual({ type: "turn-started", chatKey: "relay:acct-1", sessionAlias: "backend" });
});

test("createScheduledTask delegates and emits scheduled-changed", async () => {
  const { control, seen, calls } = makeControl();
  const task = await control.createScheduledTask({
    chatKey: "relay:acct-1",
    sessionAlias: "backend",
    executeAt: new Date("2026-06-14T10:00:00.000Z"),
    message: "check CI",
  });
  expect(task.id).toBe("ab12");
  expect(calls.create).toHaveLength(1);
  expect(seen).toContainEqual({ type: "scheduled-changed", chatKey: "relay:acct-1" });
});

test("cancelScheduledTask emits only when something was cancelled", async () => {
  const { control, seen } = makeControl();
  expect(await control.cancelScheduledTask("zz99", "relay:acct-1")).toBe(false);
  expect(seen).toHaveLength(0);
  expect(await control.cancelScheduledTask("ab12", "relay:acct-1")).toBe(true);
  expect(seen).toContainEqual({ type: "scheduled-changed", chatKey: "relay:acct-1" });
});
