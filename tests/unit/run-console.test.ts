import { expect, test } from "bun:test";

import type { ResolvedSession, SessionTransport } from "../../src/transport/types";
import type { OrchestrationServer } from "../../src/orchestration/orchestration-server";
import type { SessionService } from "../../src/sessions/session-service";
import type { ConsumerLock } from "../../src/runtime/consumer-lock";
import type { DaemonLifecycle } from "../../src/run-console";
import { createNoopAppLogger } from "../../src/logging/app-logger";
import { runConsole as runConsoleWithOwnership } from "../../src/run-console";
const noOpConsumerLock = {
  acquire: async () => {},
  release: async () => {},
};

const runConsole = (
  paths: Parameters<typeof runConsoleWithOwnership>[0],
  deps: Parameters<typeof runConsoleWithOwnership>[1],
) => runConsoleWithOwnership(paths, { consumerLock: noOpConsumerLock, ...deps });

function createScheduledRuntime() {
  return {
    service: {} as never,
    scheduler: {
      start: async () => {},
      stop: () => {},
    } as never,
  };
}

function createRuntime() {
  return {
    agent: {} as never,
    router: {} as never,
    sessions: {} as never,
    stateStore: {} as never,
    configStore: {} as never,
    scheduled: createScheduledRuntime(),
    logger: createNoopAppLogger(),
    quota: {} as never,
    orchestration: {
      server: { start: async () => {}, stop: async () => {} },
      service: {
        reconcileParallelSlots: async () => {},
      },
      endpoint: {} as never,
    },
    control: {} as never,
    reapStaleQueueOwners: async () => {},
    dispose: async () => {},
  };
}

test("registers and clears the heartbeat timer across daemon lifecycle", async () => {
  const events: string[] = [];
  let heartbeatTick: (() => void | Promise<void>) | null = null;
  const intervalDelays: number[] = [];
  const clearedTimers: unknown[] = [];

  await runConsole(
    {
      configPath: "/cfg",
      statePath: "/state",
    },
    {
      buildApp: async () => ({
        agent: {} as never,
        router: {} as never,
        sessions: {} as never,
        stateStore: {} as never,
        configStore: {} as never,
        scheduled: createScheduledRuntime(),
        logger: createNoopAppLogger(),
        orchestration: {
          server: {
            start: async () => {
              events.push("orchestration:start");
            },
            stop: async () => {
              events.push("orchestration:stop");
            },
          },
          service: {
            reconcileParallelSlots: async () => {},
          },
        },
        reapStaleQueueOwners: async () => {},
        dispose: async () => {
          events.push("dispose");
        },
      }),
      channels: {
        startAll: async () => {
          events.push("channel:start");
          await heartbeatTick?.();
        },
      },
      daemonRuntime: {
        start: async ({ configPath, statePath }) => {
          events.push(`daemon:start:${configPath}:${statePath}`);
        },
        heartbeat: async () => {
          events.push("daemon:heartbeat");
        },
        stop: async () => {
          events.push("daemon:stop");
        },
      },
      heartbeatIntervalMs: 5_000,
      setInterval: (fn, delay) => {
        intervalDelays.push(delay);
        if (delay === 5_000) {
          heartbeatTick = fn;
        }
        return `timer-${delay}`;
      },
      clearInterval: (timer) => {
        clearedTimers.push(timer);
      },
    },
  );

  expect(events).toEqual([
    "daemon:start:/cfg:/state",
    "orchestration:start",
    "channel:start",
    "daemon:heartbeat",
    "orchestration:stop",
    "dispose",
    "daemon:stop",
  ]);
  expect(intervalDelays).toEqual([5_000]);
  expect(clearedTimers).toEqual(["timer-5000"]);
});

test("reaps stale queue owners at startup after the consumer lock, before channels start", async () => {
  const events: string[] = [];

  await runConsole({ configPath: "/cfg", statePath: "/state" }, {
    buildApp: async () => ({
      ...createRuntime(),
      reapStaleQueueOwners: async () => { events.push("reap"); },
    }),
    consumerLock: {
      acquire: async () => { events.push("lock:acquire"); },
      release: async () => { events.push("lock:release"); },
    } as never,
    channels: {
      startAll: async () => { events.push("channel:start"); },
    },
    addProcessListener: () => {},
    removeProcessListener: () => {},
  });

  expect(events).toEqual(["lock:acquire", "reap", "channel:start", "lock:release"]);
});

test("reports daemon ready before the queue-owner sweep finishes, and channels wait for it", async () => {
  const events: string[] = [];
  let releaseReap!: () => void;
  const reapGate = new Promise<void>((resolve) => {
    releaseReap = resolve;
  });

  const runPromise = runConsole({ configPath: "/cfg", statePath: "/state" }, {
    buildApp: async () => ({
      ...createRuntime(),
      reapStaleQueueOwners: async () => {
        events.push("reap:start");
        await reapGate;
        events.push("reap:done");
      },
    }),
    channels: {
      startAll: async () => { events.push("channel:start"); },
    },
    daemonRuntime: {
      start: async () => { events.push("daemon:start"); },
      heartbeat: async () => {},
      stop: async () => { events.push("daemon:stop"); },
    },
    addProcessListener: () => {},
    removeProcessListener: () => {},
  });

  // Let startup run as far as it can while the sweep is still gated open.
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The ready signal must be out even though the sweep has not finished...
  expect(events).toContain("daemon:start");
  expect(events).toContain("reap:start");
  expect(events).not.toContain("reap:done");
  // ...and channels must NOT begin serving until the sweep is joined.
  expect(events).not.toContain("channel:start");

  releaseReap();
  await runPromise;

  // The sweep is joined before channels serve; ready was already signalled above.
  expect(events.indexOf("daemon:start")).toBeLessThan(events.indexOf("reap:done"));
  expect(events.indexOf("reap:done")).toBeLessThan(events.indexOf("channel:start"));
});

test("periodic orphan sweeps never overlap and cleanup waits for the active sweep", async () => {
  let tick: (() => void | Promise<void>) | undefined;
  let periodicCalls = 0;
  let releaseSweep!: () => void;
  const gate = new Promise<void>((resolve) => { releaseSweep = resolve; });
  const runPromise = runConsole({ configPath: "/cfg", statePath: "/state" }, {
    buildApp: async () => ({
      ...createRuntime(),
      reconcileOrphans: async () => {
        periodicCalls += 1;
        await gate;
      },
    }),
    channels: {
      startAll: async () => {
        void tick?.();
        void tick?.();
      },
    },
    daemonRuntime: {
      start: async () => {},
      heartbeat: async () => {},
      stop: async () => {},
    },
    setInterval: (callback, delay) => {
      if (delay === 60_000) tick = callback;
      return { unref() {} };
    },
    clearInterval: () => {},
    addProcessListener: () => {},
    removeProcessListener: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(periodicCalls).toBe(1);
  let settled = false;
  void runPromise.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  releaseSweep();
  await runPromise;
});

test("runs afterBuild before beforeReady and channel startup", async () => {
  const events: string[] = [];
  const runtime = createRuntime();

  await runConsole({ configPath: "/cfg", statePath: "/state" }, {
    buildApp: async () => { events.push("build"); return runtime; },
    afterBuild: async () => { events.push("afterBuild"); },
    beforeReady: async () => { events.push("beforeReady"); },
    channels: {
      startAll: async () => { events.push("startAll"); },
    },
    addProcessListener: () => {},
    removeProcessListener: () => {},
  });

  expect(events).toEqual(["build", "afterBuild", "beforeReady", "startAll"]);
});

test("starts the scheduler while channel startup is still running", async () => {
  const events: string[] = [];
  const signalHandlers = new Map<string, () => void>();

  const runPromise = runConsole(
    {
      configPath: "/cfg",
      statePath: "/state",
    },
    {
      buildApp: async () => ({
        ...createRuntime(),
        scheduled: {
          service: {} as never,
          scheduler: {
            start: async () => {
              events.push("scheduled:start");
            },
            stop: () => {
              events.push("scheduled:stop");
            },
          } as never,
        },
        dispose: async () => {
          events.push("dispose");
        },
      }),
      channels: {
        startAll: async (input) => {
          events.push("channel:start");
          await new Promise<void>((resolve) => {
            input.abortSignal.addEventListener(
              "abort",
              () => {
                events.push("channel:abort");
                resolve();
              },
              { once: true },
            );
          });
        },
      },
      addProcessListener: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      removeProcessListener: (signal, handler) => {
        if (signalHandlers.get(signal) === handler) {
          signalHandlers.delete(signal);
        }
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(events).toEqual(["channel:start", "scheduled:start"]);

  signalHandlers.get("SIGTERM")?.();
  await runPromise;

  expect(events).toEqual(["channel:start", "scheduled:start", "channel:abort", "dispose"]);
});

test("best-effort channel startup keeps running when all channels fail until shutdown", async () => {
  const events: string[] = [];
  const logErrors: Array<{ event: string; message: string; context: unknown }> = [];
  const signalHandlers = new Map<string, () => void>();
  let settled = false;

  const runPromise = runConsole(
    {
      configPath: "/cfg",
      statePath: "/state",
    },
    {
      buildApp: async () => ({
        agent: {} as never,
        router: {} as never,
        sessions: {} as never,
        stateStore: {} as never,
        configStore: {} as never,
        scheduled: createScheduledRuntime(),
        logger: {
          ...createNoopAppLogger(),
          error: async (event, message, context) => {
            logErrors.push({ event, message, context });
          },
        },
        orchestration: {
          server: {
            start: async () => {
              events.push("orchestration:start");
            },
            stop: async () => {
              events.push("orchestration:stop");
            },
          },
          service: {
            reconcileParallelSlots: async () => {},
          },
        },
        reapStaleQueueOwners: async () => {},
        dispose: async () => {
          events.push("dispose");
        },
      }),
      channels: {
        startAll: async () => {
          events.push("channel:start");
          throw new Error("all channels failed to start");
        },
      },
      channelStartupPolicy: "best-effort",
      daemonRuntime: {
        start: async () => {
          events.push("daemon:start");
        },
        heartbeat: async () => {
          events.push("daemon:heartbeat");
        },
        stop: async () => {
          events.push("daemon:stop");
        },
      },
      addProcessListener: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      removeProcessListener: (signal, handler) => {
        if (signalHandlers.get(signal) === handler) {
          signalHandlers.delete(signal);
        }
      },
    },
  ).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  expect(events).toEqual(["daemon:start", "orchestration:start", "channel:start"]);
  expect(logErrors).toEqual([
    {
      event: "daemon.channels.start_failed",
      message: "all channels failed to start; daemon remains alive for orchestration IPC",
      context: { error: "all channels failed to start" },
    },
  ]);

  signalHandlers.get("SIGTERM")?.();
  await runPromise;

  expect(events).toEqual(["daemon:start", "orchestration:start", "channel:start", "orchestration:stop", "dispose", "daemon:stop"]);
  expect(signalHandlers.size).toBe(0);
});

test("require-one channel startup still rejects when all channels fail", async () => {
  const events: string[] = [];

  await expect(
    runConsole(
      {
        configPath: "/cfg",
        statePath: "/state",
      },
      {
        buildApp: async () => ({
          agent: {} as never,
          router: {} as never,
          sessions: {} as never,
          stateStore: {} as never,
          configStore: {} as never,
          scheduled: createScheduledRuntime(),
          logger: createNoopAppLogger(),
          orchestration: {
            server: {
              start: async () => {
                events.push("orchestration:start");
              },
              stop: async () => {
                events.push("orchestration:stop");
              },
            },
            service: {
              reconcileParallelSlots: async () => {},
            },
          },
          reapStaleQueueOwners: async () => {},
          dispose: async () => {
            events.push("dispose");
          },
        }),
        channels: {
          startAll: async () => {
            events.push("channel:start");
            throw new Error("all channels failed to start");
          },
        },
        channelStartupPolicy: "require-one",
        daemonRuntime: {
          start: async () => {
            events.push("daemon:start");
          },
          heartbeat: async () => {},
          stop: async () => {
            events.push("daemon:stop");
          },
        },
      },
    ),
  ).rejects.toThrow("all channels failed to start");

  expect(events).toEqual(["daemon:start", "orchestration:start", "channel:start", "orchestration:stop", "dispose", "daemon:stop"]);
});

test("propagates scheduler startup failures after channels start", async () => {
  const events: string[] = [];

  await expect(
    runConsole(
      {
        configPath: "/cfg",
        statePath: "/state",
      },
      {
        buildApp: async () => ({
          ...createRuntime(),
          scheduled: {
            service: {} as never,
            scheduler: {
              start: async () => {
                events.push("scheduled:start");
                throw new Error("scheduler failed");
              },
              stop: () => {},
            } as never,
          },
          dispose: async () => {
            events.push("dispose");
          },
        }),
        channels: {
          startAll: async () => {
            events.push("channel:start");
          },
        },
        channelStartupPolicy: "best-effort",
      },
    ),
  ).rejects.toThrow("scheduler failed");

  expect(events).toEqual(["channel:start", "scheduled:start", "dispose"]);
});

test("disposes runtime when loading the sdk fails before startup", async () => {
  const events: string[] = [];

  await expect(
    runConsole(
      {
        configPath: "/cfg",
        statePath: "/state",
      },
      {
        buildApp: async () => ({
          agent: {} as never,
          router: {} as never,
          sessions: {} as never,
          stateStore: {} as never,
          configStore: {} as never,
          scheduled: createScheduledRuntime(),
          logger: createNoopAppLogger(),
          orchestration: {
            server: {
              start: async () => {
                events.push("orchestration:start");
              },
              stop: async () => {
                events.push("orchestration:stop");
              },
            },
            service: {
              reconcileParallelSlots: async () => {},
            },
          },
          reapStaleQueueOwners: async () => {},
          dispose: async () => {
            events.push("dispose");
          },
        }),
        channels: {
          startAll: async () => {
            throw new Error("sdk load failed");
          },
        },
      },
    ),
  ).rejects.toThrow("sdk load failed");

  expect(events).toEqual(["dispose"]);
});

test("swallows heartbeat failures inside the timer callback", async () => {
  let heartbeatTick: (() => void | Promise<void>) | null = null;

  await runConsole(
    {
      configPath: "/cfg",
      statePath: "/state",
    },
    {
      buildApp: async () => ({
        agent: {} as never,
        router: {} as never,
        sessions: {} as never,
        stateStore: {} as never,
        configStore: {} as never,
        scheduled: createScheduledRuntime(),
        logger: createNoopAppLogger(),
        orchestration: {
          server: {
            start: async () => {},
            stop: async () => {},
          },
          service: {
            reconcileParallelSlots: async () => {},
          },
        },
        reapStaleQueueOwners: async () => {},
        dispose: async () => {},
      }),
      channels: {
        startAll: async () => {
          await heartbeatTick?.();
        },
      },
      daemonRuntime: {
        start: async () => {},
        heartbeat: async () => {
          throw new Error("heartbeat failed");
        },
        stop: async () => {},
      },
      setInterval: (fn, delay) => {
        if (delay === 30_000) {
          heartbeatTick = fn;
        }
        return `timer-${delay}`;
      },
      clearInterval: () => {},
    },
  );
});

test("does not register gc interval in foreground mode", async () => {
  const intervalDelays: number[] = [];

  await runConsole(
    {
      configPath: "/cfg",
      statePath: "/state",
    },
    {
      buildApp: async () => ({
        agent: {} as never,
        router: {} as never,
        sessions: {} as never,
        stateStore: {} as never,
        configStore: {} as never,
        scheduled: createScheduledRuntime(),
        logger: createNoopAppLogger(),
        orchestration: {
          server: {
            start: async () => {},
            stop: async () => {},
          },
          service: {
            reconcileParallelSlots: async () => {},
          },
        },
        reapStaleQueueOwners: async () => {},
        dispose: async () => {},
      }),
      channels: {
        startAll: async () => {},
      },
      setInterval: (_fn, delay) => {
        intervalDelays.push(delay);
        return `timer-${delay}`;
      },
      clearInterval: () => {},
    },
  );

  expect(intervalDelays).toEqual([]);
});

test("still stops daemon runtime when dispose fails", async () => {
  const events: string[] = [];

  await expect(
    runConsole(
      {
        configPath: "/cfg",
        statePath: "/state",
      },
      {
        buildApp: async () => ({
          agent: {} as never,
          router: {} as never,
          sessions: {} as never,
          stateStore: {} as never,
          configStore: {} as never,
          scheduled: createScheduledRuntime(),
          logger: createNoopAppLogger(),
          orchestration: {
            server: {
              start: async () => {
                events.push("orchestration:start");
              },
              stop: async () => {
                events.push("orchestration:stop");
              },
            },
            service: {
              reconcileParallelSlots: async () => {},
            },
          },
          reapStaleQueueOwners: async () => {},
          dispose: async () => {
            events.push("dispose");
            throw new Error("dispose failed");
          },
        }),
        channels: {
          startAll: async () => {
            events.push("channel:start");
          },
        },
        daemonRuntime: {
          start: async () => {
            events.push("daemon:start");
          },
          heartbeat: async () => {},
          stop: async () => {
            events.push("daemon:stop");
          },
        },
      },
    ),
  ).rejects.toThrow("dispose failed");

  expect(events).toEqual(["daemon:start", "orchestration:start", "channel:start", "orchestration:stop", "dispose", "daemon:stop"]);
});

test("handles SIGINT by aborting the sdk start and running cleanup", async () => {
  const events: string[] = [];
  const signalHandlers = new Map<string, () => void>();

  await runConsole(
    {
      configPath: "/cfg",
      statePath: "/state",
    },
    {
      buildApp: async () => ({
        agent: {} as never,
        router: {} as never,
        sessions: {} as never,
        stateStore: {} as never,
        configStore: {} as never,
        scheduled: createScheduledRuntime(),
        logger: createNoopAppLogger(),
        orchestration: {
          server: {
            start: async () => {
              events.push("orchestration:start");
            },
            stop: async () => {
              events.push("orchestration:stop");
            },
          },
          service: {
            reconcileParallelSlots: async () => {},
          },
        },
        control: {} as never,
        reapStaleQueueOwners: async () => {},
        dispose: async () => {
          events.push("dispose");
        },
      }),
      channels: {
        startAll: async (input) => {
          events.push("channel:start");
          await new Promise<void>((resolve) => {
            input.abortSignal.addEventListener(
              "abort",
              () => {
                events.push("channel:abort");
                resolve();
              },
              { once: true },
            );
            signalHandlers.get("SIGINT")?.();
          });
        },
      },
      daemonRuntime: {
        start: async () => {
          events.push("daemon:start");
        },
        heartbeat: async () => {},
        stop: async () => {
          events.push("daemon:stop");
        },
      },
      addProcessListener: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      removeProcessListener: (signal, handler) => {
        if (signalHandlers.get(signal) === handler) {
          signalHandlers.delete(signal);
        }
      },
    },
  );

  expect(events).toEqual(["daemon:start", "orchestration:start", "channel:start", "channel:abort", "orchestration:stop", "dispose", "daemon:stop"]);
  expect(signalHandlers.size).toBe(0);
});

test("passes the control facade through to channel startup", async () => {
  const signalHandlers = new Map<string, () => void>();
  let startInput: { control?: unknown } | undefined;

  const runPromise = runConsole(
    { configPath: "/cfg", statePath: "/state" },
    {
      buildApp: async () => ({
        ...createRuntime(),
        control: { marker: "control-facade" } as never,
      }),
      channels: {
        startAll: async (input) => {
          startInput = input as { control?: unknown };
        },
      },
      addProcessListener: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      removeProcessListener: () => {},
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(startInput?.control).toEqual({ marker: "control-facade" });

  signalHandlers.get("SIGTERM")?.();
  await runPromise;
});

test("passes the session resource catalog through to channel startup", async () => {
  const signalHandlers = new Map<string, () => void>();
  let startInput: { sessionResources?: unknown } | undefined;
  const sessionResources = { marker: "session-resources" };

  const runPromise = runConsole(
    { configPath: "/cfg", statePath: "/state" },
    {
      buildApp: async () => ({
        ...createRuntime(),
        sessionResources: sessionResources as never,
      }),
      channels: {
        startAll: async (input) => {
          startInput = input as { sessionResources?: unknown };
        },
      },
      addProcessListener: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      removeProcessListener: () => {},
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(startInput?.sessionResources).toBe(sessionResources);

  signalHandlers.get("SIGTERM")?.();
  await runPromise;
});
test("primes runtime queues only after consumer lock and orchestration IPC are ready", async () => {
  const events: string[] = [];
  const signalHandlers = new Map<string, () => void>();
  let primeCallOrder: string[] = [];
  let primedSessions: unknown[] = [];
  const mockTransport = {
    primeRuntimeQueues: async (sessions: unknown[]) => {
      primeCallOrder.push("prime");
      primedSessions = sessions;
      events.push("prime");
    },
    dispose: async () => { events.push("transport:dispose"); },
    isSessionWarm: async () => ({ warm: false }),
  } as unknown as SessionTransport;
  const mockOrchestrationServer = {
    start: async () => { events.push("orchestration:start"); },
    stop: async () => { events.push("orchestration:stop"); },
  } as unknown as OrchestrationServer;
  // Two logical aliases sharing one physical acpx session: the physical
  // catalog would dedupe them, but queue recovery needs both journals.
  const mockSessions = {
    listRuntimeQueueRecoverySessions: () => [
      { alias: "a", agent: "codex", workspace: "backend", transport_session: "backend:shared", transportEngine: "runtime", logical_session_id: "id-a" } as unknown as ResolvedSession,
      { alias: "b", agent: "codex", workspace: "backend", transport_session: "backend:shared", transportEngine: "runtime", logical_session_id: "id-b" } as unknown as ResolvedSession,
    ],
    listAllResolvedLogicalSessions: () => [
      { alias: "a", agent: "codex", workspace: "backend", transport_session: "backend:shared", transportEngine: "runtime", logical_session_id: "id-a" } as unknown as ResolvedSession,
    ],
    listAllResolvedSessions: () => [{ alias: "a", agent: "codex", workspace: "backend", transport_session: "backend:shared", transportEngine: "runtime", logical_session_id: "id-a" } as unknown as ResolvedSession],
  } as unknown as SessionService;
  const runPromise = runConsole(
    { configPath: "/cfg", statePath: "/state" },
    {
      buildApp: async () => ({
        agent: { handle: async () => {} } as never,
        router: {} as never,
        sessions: mockSessions as never,
        sessionResources: {} as never,
        activeTurns: {} as never,
        stateStore: { save: async () => {}, saveNow: async () => {} } as never,
        configStore: {} as never,
        logger: { info: async () => {}, error: async () => {}, warn: async () => {}, debug: async () => {} } as never,
        perfTracer: { flush: async () => {} } as never,
        quota: {} as never,
        transport: mockTransport as never,
        orchestration: { service: { reconcileParallelSlots: async () => {} } as never, server: mockOrchestrationServer as never, endpoint: {} as never },
        agentMessaging: {} as never,
        scheduled: { service: {} as never, scheduler: { start: async () => {}, stop: () => {} } as never },
        control: {} as never,
        reapStaleQueueOwners: async () => { events.push("reap"); },
        dispose: async () => { events.push("dispose"); },
      }),
      channels: {
        startAll: async () => { events.push("channel:start"); },
      },
      consumerLock: {
        acquire: async () => { events.push("lock:acquire"); },
        release: async () => { events.push("lock:release"); },
      } as unknown as ConsumerLock,
      daemonRuntime: {
        start: async () => { events.push("daemon:start"); },
        heartbeat: async () => {},
        stop: async () => { events.push("daemon:stop"); },
      } as unknown as DaemonLifecycle,
      addProcessListener: (signal, handler) => { signalHandlers.set(signal, handler); },
      removeProcessListener: (signal, handler) => { if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal); },
    },
  );
  // Integration test exercising real wall-clock ordering of daemon startup (lock + IPC + reap before queue prime)
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 50);
  await promise;
  const lockIdx = events.indexOf("lock:acquire");
  const orchIdx = events.indexOf("orchestration:start");
  const reapIdx = events.indexOf("reap");
  const primeIdx = events.indexOf("prime");
  const channelIdx = events.indexOf("channel:start");
  expect(lockIdx).toBeGreaterThanOrEqual(0);
  expect(orchIdx).toBeGreaterThanOrEqual(0);
  expect(reapIdx).toBeGreaterThanOrEqual(0);
  expect(primeIdx).toBeGreaterThan(lockIdx);
  expect(primeIdx).toBeGreaterThan(orchIdx);
  expect(primeIdx).toBeGreaterThan(reapIdx);
  expect(primeIdx).toBeLessThan(channelIdx);
  expect(primeCallOrder).toEqual(["prime"]);
  // The recovery catalog must carry both logical aliases (no physical dedupe).
  expect((primedSessions as { logical_session_id?: string }[]).map((s) => s.logical_session_id).sort()).toEqual(["id-a", "id-b"]);
  signalHandlers.get("SIGTERM")?.();
  await runPromise;
});

test("a form capability lost mid-startup ends the run instead of starting anyway", async () => {
  // The readiness listener records the fatal condition and aborts the daemon, but
  // nothing READS it back. Under `best-effort` a partial failure still resolves
  // the channel start on the strength of its healthy siblings, so
  // `await channelStartPromise` succeeded and `runConsole` returned normally —
  // a daemon that had already aborted itself, with the agent still holding the
  // form-Elicitation flag it was handed at construction.
  const events: string[] = [];
  const logErrors: Array<{ event: string; message: string }> = [];
  const signalHandlers = new Map<string, () => void>();
  let notify: (formCapable: boolean) => void = () => {};

  const runPromise = runConsole(
    { configPath: "/cfg", statePath: "/state" },
    {
      buildApp: async () => ({
        agent: {} as never,
        router: {} as never,
        sessions: {} as never,
        stateStore: {} as never,
        configStore: {} as never,
        scheduled: createScheduledRuntime(),
        logger: {
          ...createNoopAppLogger(),
          error: async (event, message) => {
            logErrors.push({ event, message });
          },
        },
        orchestration: {
          server: {
            start: async () => { events.push("orchestration:start"); },
            stop: async () => { events.push("orchestration:stop"); },
          },
          service: { reconcileParallelSlots: async () => {} },
        },
        reapStaleQueueOwners: async () => {},
        dispose: async () => { events.push("dispose"); },
      }),
      channels: {
        startAll: async () => {
          events.push("channel:start");
          // A healthy channel keeps running; the form-capable one has failed
          // by the time the readiness listener fires. The listener fires from
          // INSIDE the real registry's start, so this is the production shape.
          notify(false);
        },
        setElicitationReadinessListener: (listener) => {
          notify = (formCapable) => listener({ formCapable } as never);
        },
        // Without a declared form channel the audit has nothing to compare
        // against and would silently pass, which is the vacuous-check bug the
        // audit's own comment warns about.
        declaredElicitationFormChannelIds: () => ["channel-feishu"],
        formElicitationChannelIds: () => [],
        stopAll: async () => { events.push("channel:stop"); },
      },
      channelStartupPolicy: "best-effort",
      daemonRuntime: {
        start: async () => { events.push("daemon:start"); },
        heartbeat: async () => {},
        stop: async () => { events.push("daemon:stop"); },
      },
      addProcessListener: (signal, handler) => {
        signalHandlers.set(signal, handler);
      },
      removeProcessListener: (signal, handler) => {
        if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal);
      },
    },
  );

  // The run REJECTS with the readiness failure, and it names the reason rather
  // than returning success with the daemon already aborted.
  await expect(runPromise).rejects.toThrow(/form elicitation is advertised but no form-capable channel started/);
  // And the eligibility loss was surfaced through the daemon logger.
  expect(logErrors.some((entry) => entry.event === "daemon.channels.elicit_form_lost")).toBe(true);
});

test("a form capability lost AFTER a clean startup audit still ends the run", async () => {
  // The listener fires once, the audit finds nothing broken, the scheduler
  // starts — and only then does Feishu fail to bind. A readiness gate that
  // RESOLVES on success cannot act on this: once resolved, a later reject is a
  // no-op, so the daemon aborts itself and then finishes starting normally.
  const events: string[] = [];
  const signalHandlers = new Map<string, () => void>();
  let notify: (formCapable: boolean) => void = () => {};
  let liveForm = ["channel-feishu"];
  let releaseChannelStart: () => void = () => {};
  // Held pending, like a healthy channel's loop in production.
  const channelStarted = new Promise<void>((resolve) => { releaseChannelStart = resolve; });

  const runPromise = runConsole(
    { configPath: "/cfg", statePath: "/state" },
    {
      buildApp: async () => ({
        ...createRuntime(),
        scheduled: {
          service: {} as never,
          scheduler: {
            start: async () => { events.push("scheduler:start"); },
            stop: () => { events.push("scheduler:stop"); },
          } as never,
        },
        logger: {
          ...createNoopAppLogger(),
          error: async (event) => { events.push(`log:${event}`); },
        },
        dispose: async () => { events.push("dispose"); },
      }),
      channels: {
        startAll: async () => {
          events.push("channel:start");
          // HEALTHY at this instant, so the first audit passes.
          notify(true);
          return channelStarted;
        },
        setElicitationReadinessListener: (listener) => {
          notify = (formCapable) => listener({ formCapable } as never);
        },
        declaredElicitationFormChannelIds: () => ["channel-feishu"],
        // Read fresh on every call — this is what makes the delayed loss visible
        // to the audit the listener triggers.
        formElicitationChannelIds: () => liveForm,
        stopAll: async () => { events.push("channel:stop"); },
      },
      channelStartupPolicy: "best-effort",
      daemonRuntime: {
        start: async () => { events.push("daemon:start"); },
        heartbeat: async () => {},
        stop: async () => { events.push("daemon:stop"); },
      },
      addProcessListener: (signal, handler) => { signalHandlers.set(signal, handler); },
      removeProcessListener: (signal, handler) => {
        if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal);
      },
    },
  );

  // Let the initial audit run clean and the scheduler start, so the loss arrives
  // after startup would otherwise already have succeeded.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toContain("scheduler:start");
  expect(events).toContain("channel:start");
  // NOW the form channel dies: the window the success-resolving gate closed off.
  liveForm = [];
  notify(false);
  // The healthy sibling channel's loop finally yields — the event that used to
  // let the run return successfully.
  releaseChannelStart();

  await expect(runPromise).rejects.toThrow(/form elicitation is advertised but no form-capable channel started/);
});

test("an immediately-failing form channel under best-effort is not an ordinary channel failure", async () => {
  // The channel early-return used to sit BEFORE the readiness listener was even
  // installed, so the only form channel failing at that instant took the
  // "all channels failed, daemon stays for IPC" exit — the exact case the
  // audit's comment calls fatal regardless of policy.
  const events: string[] = [];
  const logErrors: Array<{ event: string; message: string }> = [];
  const signalHandlers = new Map<string, () => void>();

  const runPromise = runConsole(
    { configPath: "/cfg", statePath: "/state" },
    {
      buildApp: async () => ({
        ...createRuntime(),
        logger: {
          ...createNoopAppLogger(),
          error: async (event, message) => { logErrors.push({ event, message }); },
        },
        scheduled: {
          service: {} as never,
          scheduler: {
            start: async () => { events.push("scheduler:start"); },
            stop: () => { events.push("scheduler:stop"); },
          } as never,
        },
        dispose: async () => { events.push("dispose"); },
      }),
      channels: {
        // Rejects immediately — the shape that used to escape through the
        // pre-listener early return.
        startAll: async () => {
          throw new Error("all channels failed to start");
        },
        setElicitationReadinessListener: (listener) => {
          listener({ formCapable: false } as never);
        },
        declaredElicitationFormChannelIds: () => ["channel-feishu"],
        formElicitationChannelIds: () => [],
        stopAll: async () => { events.push("channel:stop"); },
      },
      channelStartupPolicy: "best-effort",
      daemonRuntime: {
        start: async () => { events.push("daemon:start"); },
        heartbeat: async () => {},
        stop: async () => { events.push("daemon:stop"); },
      },
      addProcessListener: (signal, handler) => { signalHandlers.set(signal, handler); },
      removeProcessListener: (signal, handler) => {
        if (signalHandlers.get(signal) === handler) signalHandlers.delete(signal);
      },
    },
  );

  // Fatal: the form capability was advertised to the bridge and the agent, and
  // no channel can deliver it any more.
  await expect(runPromise).rejects.toThrow(/form elicitation is advertised but no form-capable channel started/);
  expect(logErrors.some((entry) => entry.event === "daemon.channels.elicit_form_lost")).toBe(true);
});
