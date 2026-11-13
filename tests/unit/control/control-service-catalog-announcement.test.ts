import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";

const session = {
  alias: "internal-backend",
  agent: "codex",
  workspace: "w",
  transportSession: "t",
  cwd: "/c",
  model: "mock-alpha",
};

const EFFORT_FRESH_AT_MS = 60_000;

/** Each sleep advances virtual time by its own delay, so a 60s worker can be
 *  exercised without waiting on wall-clock time. */
async function withVirtualClock(run: (now: () => number) => Promise<void>): Promise<void> {
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  let virtualNow = 0;
  Date.now = () => virtualNow;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    virtualNow += ms;
    queueMicrotask(fn);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    await run(() => virtualNow);
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
  }
}

function makeDeps(options: {
  now: () => number;
  withModelReader?: boolean;
  modelRead?: () => Promise<Record<string, unknown>>;
}) {
  const events: Array<Record<string, unknown>> = [];
  const deps = {
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) => `internal-${alias}`,
      getSession: async (internalAlias: string) => internalAlias === "internal-backend" ? { ...session } : null,
      setSessionModel: async () => {},
      setSessionEffort: async () => {},
    },
    transport: {
      ...(options.withModelReader === false && !options.modelRead
        ? {}
        : {
            getSessionModel: options.modelRead ?? (async () => ({
              current: "mock-alpha",
              available: ["mock-alpha", "mock-beta"],
            })),
          }),
      getSessionEffort: async () =>
        options.now() < EFFORT_FRESH_AT_MS
          ? { available: [], pending: true }
          : { current: "medium", available: ["low", "medium", "high"] },
      setModel: async () => {},
      setSessionEffort: async () => {},
    },
    logger: { error: async () => {}, debug: async () => {} },
    events: {
      emit: (event: Record<string, unknown>) => { events.push({ ...event, at: options.now() }); },
    },
  };
  return { deps, events };
}

test("a pending effort catalog is not announced while the model catalog is fresh", async () => {
  await withVirtualClock(async (now) => {
    const { deps, events } = makeDeps({ now });
    const control = new ControlService(deps as never);

    await expect(control.getSessionEffort("relay:acc", "backend")).resolves.toEqual({ available: [] });
    await control.whenBackgroundIdle();

    expect(events.length).toBe(1);
    expect(events[0].at).toBeGreaterThanOrEqual(EFFORT_FRESH_AT_MS);
  });
});

test("a pending effort catalog is not announced when the model reader is absent", async () => {
  await withVirtualClock(async (now) => {
    const { deps, events } = makeDeps({ now, withModelReader: false });
    const control = new ControlService(deps as never);

    await expect(control.getSessionEffort("relay:acc", "backend")).resolves.toEqual({ available: [] });
    await control.whenBackgroundIdle();

    expect(events.length).toBe(1);
    expect(events[0].at).toBeGreaterThanOrEqual(EFFORT_FRESH_AT_MS);
  });
});

function midReadDeps(modelRead: () => Promise<Record<string, unknown>>) {
  const events: Array<Record<string, unknown>> = [];
  const deps = {
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) => `internal-${alias}`,
      getSession: async () => ({ ...session }),
      setSessionModel: async () => {},
      setSessionEffort: async () => {},
    },
    transport: {
      getSessionModel: modelRead,
      getSessionEffort: async () => ({ current: "medium", available: ["low", "medium", "high"] }),
      setModel: async () => {},
      setSessionEffort: async () => {},
    },
    logger: { error: async () => {}, debug: async () => {} },
    events: { emit: (event: Record<string, unknown>) => { events.push(event); } },
  };
  return { deps, events };
}

test("shutdown during an in-flight model read emits no readiness event", async () => {
  await withVirtualClock(async () => {
    const readStarted = Promise.withResolvers<void>();
    const readResult = Promise.withResolvers<Record<string, unknown>>();
    let modelReads = 0;
    const { deps, events } = midReadDeps(async () => {
      modelReads += 1;
      if (modelReads === 1) return { available: [], pending: true };
      readStarted.resolve();
      return await readResult.promise;
    });
    const control = new ControlService(deps as never);

    await expect(control.getSessionModel("relay:acc", "backend")).resolves.toEqual({ available: [] });
    await readStarted.promise;
    control.cancelPendingCatalogWaits();
    readResult.resolve({ current: "mock-alpha", available: ["mock-alpha", "mock-beta"] });
    await control.whenBackgroundIdle();

    expect(events).toEqual([]);
  });
});

test("shutdown during an in-flight read leaves whenBackgroundIdle settled", async () => {
  await withVirtualClock(async () => {
    const readStarted = Promise.withResolvers<void>();
    const readResult = Promise.withResolvers<Record<string, unknown>>();
    let modelReads = 0;
    const { deps } = midReadDeps(async () => {
      modelReads += 1;
      if (modelReads === 1) return { available: [], pending: true };
      readStarted.resolve();
      return await readResult.promise;
    });
    const control = new ControlService(deps as never);

    await expect(control.getSessionModel("relay:acc", "backend")).resolves.toEqual({ available: [] });
    await readStarted.promise;
    control.cancelPendingCatalogWaits();
    const idle = control.whenBackgroundIdle();
    let idleSettled = false;
    void idle.then(() => { idleSettled = true; });
    for (let turn = 0; turn < 50; turn += 1) {
      const tick = Promise.withResolvers<void>();
      setImmediate(tick.resolve);
      await tick.promise;
    }
    try {
      expect(idleSettled).toBe(true);
    } finally {
      readResult.resolve({ available: [], pending: true });
      await idle;
    }
  });
});
