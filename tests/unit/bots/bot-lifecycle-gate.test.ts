import { expect, test } from "bun:test";

import { BotLifecycleGate } from "../../../src/bots/bot-lifecycle-gate";

test("BotLifecycleGate serializes the same bot and allows different bots to overlap", async () => {
  const gate = new BotLifecycleGate();
  const events: string[] = [];
  let releaseA!: () => void;
  const holdA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const a = gate.run("bot_a", async () => {
    events.push("a-enter");
    await holdA;
    events.push("a-leave");
    return "a";
  });
  const b = gate.run("bot_a", async () => {
    events.push("b");
    return "b";
  });
  const c = gate.run("bot_c", async () => {
    events.push("c");
    return "c";
  });

  await c;
  expect(events).toEqual(["a-enter", "c"]);
  releaseA();
  expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  expect(events).toEqual(["a-enter", "c", "a-leave", "b"]);
});
