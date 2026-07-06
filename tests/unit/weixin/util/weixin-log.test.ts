import { afterEach, expect, test } from "bun:test";
import { resetWeixinLogForTest, setWeixinLog, weixinLog } from "../../../../src/weixin/util/weixin-log";

afterEach(() => resetWeixinLogForTest());

test("noop before a sink is injected (never throws)", () => {
  expect(() => weixinLog.info("weixin.test.ping", "hi", { a: 1 })).not.toThrow();
  expect(() => weixinLog.error("weixin.test.boom", "oops")).not.toThrow();
});

test("forwards to the injected sink with event/message/context", () => {
  const calls: Array<[string, string, string, unknown]> = [];
  setWeixinLog({
    debug: (e, m, c) => calls.push(["debug", e, m, c]),
    info: (e, m, c) => calls.push(["info", e, m, c]),
    error: (e, m, c) => calls.push(["error", e, m, c]),
  });
  weixinLog.debug("weixin.a.b", "d", { x: 1 });
  weixinLog.info("weixin.c.d", "i");
  weixinLog.error("weixin.e.f", "e", { y: 2 });
  expect(calls).toEqual([
    ["debug", "weixin.a.b", "d", { x: 1 }],
    ["info", "weixin.c.d", "i", undefined],
    ["error", "weixin.e.f", "e", { y: 2 }],
  ]);
});

test("a throwing sink does not propagate to the caller (fire-and-forget)", () => {
  setWeixinLog({
    debug: () => { throw new Error("sink down"); },
    info: () => { throw new Error("sink down"); },
    error: () => { throw new Error("sink down"); },
  });
  expect(() => weixinLog.info("weixin.x.y", "z")).not.toThrow();
});
