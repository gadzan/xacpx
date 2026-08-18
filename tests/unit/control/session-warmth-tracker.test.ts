import { expect, test } from "bun:test";

import { SessionWarmthTracker } from "../../../src/control/session-warmth-tracker";
import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";
import type { ResolvedSession } from "../../../src/transport/types";

function makeSession(
  overrides: Partial<ResolvedSession> = {},
): ResolvedSession {
  return {
    alias: "backend",
    agent: "codex",
    workspace: "backend",
    transportSession: "xacpx-backend",
    cwd: "/ws/backend",
    ...overrides,
  } as ResolvedSession;
}

function makeTracker(opts: {
  sessions: ResolvedSession[];
  isWarm: (session: ResolvedSession) => Promise<boolean>;
}) {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const tracker = new SessionWarmthTracker({
    listSessions: () => opts.sessions,
    isWarm: opts.isWarm,
    events,
  });
  return { tracker, seen };
}

test("isWarm is undefined before the first check", () => {
  const { tracker } = makeTracker({ sessions: [], isWarm: async () => true });
  expect(tracker.isWarm(makeSession())).toBeUndefined();
});

test("tick records warmth and emits sessions-changed only on a flip", async () => {
  const session = makeSession();
  let warm = true;
  const { tracker, seen } = makeTracker({
    sessions: [session],
    isWarm: async () => warm,
  });

  await tracker.tick(); // undefined -> true is a flip (first observation)
  expect(tracker.isWarm(session)).toBe(true);
  expect(seen).toEqual([{ type: "sessions-changed" }]);

  await tracker.tick(); // steady state: no event
  expect(seen).toHaveLength(1);

  warm = false;
  await tracker.tick(); // true -> false flips again
  expect(tracker.isWarm(session)).toBe(false);
  expect(seen).toHaveLength(2);
});

test("concurrent tick is a no-op while one is in flight", async () => {
  const session = makeSession();
  let release!: (value: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  const { tracker } = makeTracker({
    sessions: [session],
    isWarm: () => {
      checks += 1;
      return gate;
    },
  });

  const first = tracker.tick();
  const second = tracker.tick(); // returns immediately without checking
  release(true);
  await Promise.all([first, second]);
  expect(checks).toBe(1);
});

test("a throwing check keeps the previous observation", async () => {
  const session = makeSession();
  let fail = false;
  const { tracker, seen } = makeTracker({
    sessions: [session],
    isWarm: async () => {
      if (fail) throw new Error("acpx exploded");
      return true;
    },
  });

  await tracker.tick();
  expect(tracker.isWarm(session)).toBe(true);

  fail = true;
  await tracker.tick();
  expect(tracker.isWarm(session)).toBe(true); // unchanged, no flap
  expect(seen).toHaveLength(1); // no extra event
});

test("markWarm/markCold correct the map without emitting", async () => {
  const session = makeSession();
  const { tracker, seen } = makeTracker({
    sessions: [session],
    isWarm: async () => true,
  });

  tracker.markWarm(session);
  expect(tracker.isWarm(session)).toBe(true);
  tracker.markCold(session);
  expect(tracker.isWarm(session)).toBe(false);
  expect(seen).toHaveLength(0);
});

test("aliases sharing a transport session share one warmth check", async () => {
  const a = makeSession({ alias: "a" });
  const b = makeSession({ alias: "b" }); // same agent/cwd/transportSession
  let checks = 0;
  const { tracker } = makeTracker({
    sessions: [a, b],
    isWarm: async () => {
      checks += 1;
      return true;
    },
  });

  await tracker.tick();
  expect(checks).toBe(1);
  expect(tracker.isWarm(a)).toBe(true);
  expect(tracker.isWarm(b)).toBe(true);
});

test("removed sessions are pruned from the warmth map", async () => {
  const session = makeSession();
  const sessions: ResolvedSession[] = [session];
  const { tracker } = makeTracker({ sessions, isWarm: async () => true });

  await tracker.tick();
  expect(tracker.isWarm(session)).toBe(true);

  sessions.length = 0;
  await tracker.tick();
  expect(tracker.isWarm(session)).toBeUndefined();
});

test("start schedules the interval and stop clears it", () => {
  const events = createControlEventBus();
  let scheduled = 0;
  let cleared = 0;
  const tracker = new SessionWarmthTracker({
    listSessions: () => [],
    isWarm: async () => true,
    events,
    intervalMs: 60_000,
    setIntervalFn: (_fn, delay) => {
      scheduled += 1;
      expect(delay).toBe(60_000);
      return "timer";
    },
    clearIntervalFn: (timer) => {
      cleared += 1;
      expect(timer).toBe("timer");
    },
  });

  tracker.start();
  tracker.start(); // idempotent
  expect(scheduled).toBe(1);
  tracker.stop();
  tracker.stop(); // idempotent
  expect(cleared).toBe(1);
});
