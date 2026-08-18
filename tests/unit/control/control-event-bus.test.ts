import { expect, test } from "bun:test";

import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";

test("delivers events to subscribers until unsubscribed", () => {
  const bus = createControlEventBus();
  const seen: ControlEvent[] = [];
  const unsubscribe = bus.subscribe((event) => seen.push(event));

  bus.emit({ type: "sessions-changed" });
  expect(seen).toEqual([{ type: "sessions-changed" }]);

  unsubscribe();
  bus.emit({ type: "orchestration-changed" });
  expect(seen).toHaveLength(1);
});

test("a throwing listener does not break other listeners", () => {
  const bus = createControlEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((event) => seen.push(event.type));

  bus.emit({ type: "scheduled-changed", chatKey: "relay:acct-1" });
  expect(seen).toEqual(["scheduled-changed"]);
});

test("bus forwards the new turn-status variants verbatim", () => {
  const bus = createControlEventBus();
  const seen: ControlEvent[] = [];
  bus.subscribe((e) => seen.push(e));

  bus.emit({
    type: "turn-started",
    chatKey: "relay:a",
    sessionAlias: "backend",
  });
  bus.emit({
    type: "tool-event",
    chatKey: "relay:a",
    sessionAlias: "backend",
    event: {
      toolCallId: "t1",
      toolName: "Read",
      kind: "read",
      status: "running",
    },
  });
  bus.emit({
    type: "turn-thought",
    chatKey: "relay:a",
    sessionAlias: "backend",
    chunk: "hmm",
  });
  bus.emit({
    type: "turn-finished",
    chatKey: "relay:a",
    sessionAlias: "backend",
    ok: false,
    cancelled: true,
  });

  expect(seen.map((e) => e.type)).toEqual([
    "turn-started",
    "tool-event",
    "turn-thought",
    "turn-finished",
  ]);
  expect(seen[3]).toMatchObject({ ok: false, cancelled: true });
});
