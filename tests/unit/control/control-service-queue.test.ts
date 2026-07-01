import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import type { ChatRequest, ChatResponse } from "../../../src/weixin/agent/interface";

// Harness mirrors control-service-prompt.test.ts's makeControl, but the fake
// agent.chat blocks on a gate so a turn can be held "in flight" while the test
// sends follow-up prompts / scheduled turns at it.
function makeService() {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chat = async (_request: ChatRequest): Promise<ChatResponse> => {
    await gate;
    return { text: "done" };
  };

  const service = new ControlService({
    agent: { chat },
    sessions: {
      listAllResolvedSessions: () => [],
      useSession: async (_chatKey: string, alias: string) => ({ alias, agent: "claude", workspace: "/ws" }),
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias,
      getSession: async () => null,
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);

  return { service, events: seen, releaseChat: () => release() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a second prompt while a turn is running is queued, not rejected, and emits queue-updated", async () => {
  const { service, events, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  // let turn 1 register as in-flight before sending the second
  await tick();
  const r2 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  expect(r2.ok).toBe(true);
  expect(r2.queued).toBe(true);
  expect(typeof r2.queueItemId).toBe("string");
  const qEvents = events.filter((e) => e.type === "queue-updated");
  expect(qEvents.at(-1)).toMatchObject({ chatKey: "c", sessionAlias: "s" });
  expect((qEvents.at(-1) as Extract<ControlEvent, { type: "queue-updated" }>).items.map((i) => i.textPreview)).toEqual([
    "second",
  ]);
  releaseChat();
  await p1;
});

test("scheduled turns are NOT queued (still reject) while a turn runs", async () => {
  const { service, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  const r = await service.runScheduledTurn({
    chatKey: "c",
    sessionAlias: "s",
    promptText: "sched",
    taskId: "t1",
    executeAt: "2026-07-01T00:00:00Z",
  });
  expect(r.ok).toBe(false);
  expect(r.errorMessage).toBe("turn-already-running");
  releaseChat();
  await p1;
});
