import { expect, test } from "bun:test";

import { InMemoryRmuxDriver } from "../../../../packages/channel-relay/src/terminal/in-memory-rmux-driver";
import {
  RmuxDriverCrashedError,
  RmuxPaneNotFoundError,
  RmuxSessionNameConflictError,
  type RmuxRecoveryEvent,
} from "../../../../packages/channel-relay/src/terminal/rmux-driver";

function baseCreateInput(overrides: Partial<Parameters<InMemoryRmuxDriver["create"]>[0]> = {}) {
  return {
    name: "xacpx-relay-abc123-term1",
    cwd: "/workspace",
    cols: 80,
    rows: 24,
    historyLimit: 10_000,
    tags: ["xacpx:relay", "owner:inst-1", "logical:logical-1", "terminal:term-1", "generation:gen-1", "schema:1"],
    ownerLeaseTtlSeconds: 90,
    ...overrides,
  };
}

async function collect<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) {
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
}

test("create returns stable session/pane identity and tags", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());
  expect(handle.sessionId).toBeTruthy();
  expect(handle.paneId).toBeTruthy();
  expect(handle.sessionId).not.toBe(handle.paneId);
  expect(handle.name).toBe("xacpx-relay-abc123-term1");
  expect(handle.tags).toEqual([
    "xacpx:relay",
    "owner:inst-1",
    "logical:logical-1",
    "terminal:term-1",
    "generation:gen-1",
    "schema:1",
  ]);
});

test("create rejects a reused session name", async () => {
  const driver = new InMemoryRmuxDriver();
  await driver.create(baseCreateInput());
  await expect(driver.create(baseCreateInput())).rejects.toBeInstanceOf(RmuxSessionNameConflictError);
});

test("list reflects created sessions and setInventory overrides/reverts it", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());

  const real = await driver.list();
  expect(real).toHaveLength(1);
  expect(real[0]?.sessionId).toBe(handle.sessionId);

  driver.setInventory([{ sessionId: "fake-sid", paneId: "fake-pane", name: "fake-name", tags: ["orphan"] }]);
  const overridden = await driver.list();
  expect(overridden).toEqual([{ sessionId: "fake-sid", paneId: "fake-pane", name: "fake-name", tags: ["orphan"] }]);

  driver.setInventory(null);
  const reverted = await driver.list();
  expect(reverted).toHaveLength(1);
  expect(reverted[0]?.sessionId).toBe(handle.sessionId);
});

test("kill is idempotent for an unknown session and removes a known one from list", async () => {
  const driver = new InMemoryRmuxDriver();
  await expect(driver.kill("never-existed")).resolves.toBeUndefined();

  const handle = await driver.create(baseCreateInput());
  await driver.kill(handle.sessionId);
  expect(await driver.list()).toHaveLength(0);
  await expect(driver.kill(handle.sessionId)).resolves.toBeUndefined();
});

test("kill ends an active recovery stream for that session", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());

  const events: RmuxRecoveryEvent[] = [];
  const drain = (async () => {
    for await (const event of driver.recover(handle.paneId)) {
      events.push(event);
    }
  })();

  await driver.kill(handle.sessionId);
  await drain;

  expect(events[0]?.type).toBe("rebase");
});

test("input and resize succeed against a live pane", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());
  await expect(driver.input(handle.paneId, new TextEncoder().encode("ls\n"))).resolves.toBeUndefined();
  await expect(driver.resize(handle.paneId, 120, 40)).resolves.toBeUndefined();
});

test("unknown pane rejects input/resize/recover with RmuxPaneNotFoundError", async () => {
  const driver = new InMemoryRmuxDriver();
  await expect(driver.input("nope", new Uint8Array())).rejects.toBeInstanceOf(RmuxPaneNotFoundError);
  await expect(driver.resize("nope", 80, 24)).rejects.toBeInstanceOf(RmuxPaneNotFoundError);
  await expect(collect(driver.recover("nope"), 1)).rejects.toBeInstanceOf(RmuxPaneNotFoundError);
});

test("recover yields a rebase first, then bytes with increasing sequence in the same epoch", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());

  const events: RmuxRecoveryEvent[] = [];
  const iterator = driver.recover(handle.paneId)[Symbol.asyncIterator]();

  const first = await iterator.next();
  expect(first.done).toBe(false);
  const firstEvent = first.value as RmuxRecoveryEvent;
  expect(firstEvent.type).toBe("rebase");
  if (firstEvent.type === "rebase") {
    expect(firstEvent.epoch).toBe(1);
    expect(firstEvent.nextSequence).toBe(0);
    expect(firstEvent.cols).toBe(80);
    expect(firstEvent.rows).toBe(24);
    expect(firstEvent.alternate).toBe(false);
    expect(firstEvent.keyframe).toBeInstanceOf(Uint8Array);
  }
  events.push(firstEvent);

  driver.injectOutput(handle.paneId, new TextEncoder().encode("hello"));
  driver.injectOutput(handle.paneId, new TextEncoder().encode("world"));

  const second = await iterator.next();
  const third = await iterator.next();
  events.push(second.value as RmuxRecoveryEvent, third.value as RmuxRecoveryEvent);

  expect(events[1]).toMatchObject({ type: "bytes", epoch: 1, sequence: 0 });
  expect(events[2]).toMatchObject({ type: "bytes", epoch: 1, sequence: 1 });

  await iterator.return?.();
});

test("triggerRebase bumps the epoch and restarts sequence numbering", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());

  const iterator = driver.recover(handle.paneId)[Symbol.asyncIterator]();
  await iterator.next();

  driver.injectOutput(handle.paneId, new TextEncoder().encode("a"));
  await iterator.next();

  driver.triggerRebase(handle.sessionId, { cols: 100, rows: 40, alternate: true, reason: "resize" });
  const rebased = (await iterator.next()).value as RmuxRecoveryEvent;
  expect(rebased).toMatchObject({ type: "rebase", epoch: 2, nextSequence: 0, cols: 100, rows: 40, alternate: true, reason: "resize" });

  driver.injectOutput(handle.paneId, new TextEncoder().encode("b"));
  const bytesAfterRebase = (await iterator.next()).value as RmuxRecoveryEvent;
  expect(bytesAfterRebase).toMatchObject({ type: "bytes", epoch: 2, sequence: 0 });

  await iterator.return?.();
});

test("exitSession delivers exit and completes the recovery stream", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());

  const events: RmuxRecoveryEvent[] = [];
  for await (const event of driver.recover(handle.paneId)) {
    events.push(event);
    if (event.type === "rebase") {
      driver.exitSession(handle.sessionId, 0);
    }
  }

  expect(events.map((e) => e.type)).toEqual(["rebase", "exit"]);
});

test("a new recover() subscription after natural exit observes the exit immediately", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());
  driver.exitSession(handle.sessionId);

  const events = await collect(driver.recover(handle.paneId), 2);
  expect(events.map((e) => e.type)).toEqual(["rebase", "exit"]);
});

test("configureFailure makes an operation reject a bounded number of times", async () => {
  const driver = new InMemoryRmuxDriver();
  const boom = new Error("boom");
  driver.configureFailure("create", boom, 1);

  await expect(driver.create(baseCreateInput())).rejects.toBe(boom);
  const handle = await driver.create(baseCreateInput());
  expect(handle.name).toBe("xacpx-relay-abc123-term1");
});

test("configureFailure with no explicit count fails every call until cleared", async () => {
  const driver = new InMemoryRmuxDriver();
  const boom = new Error("always boom");
  driver.configureFailure("diagnostics", boom);

  await expect(driver.diagnostics()).rejects.toBe(boom);
  await expect(driver.diagnostics()).rejects.toBe(boom);

  driver.clearFailure("diagnostics");
  await expect(driver.diagnostics()).resolves.toBeTruthy();
});

test("configureDelay invokes the injectable sleep instead of a real wait", async () => {
  const sleepCalls: number[] = [];
  const driver = new InMemoryRmuxDriver({ sleep: async (ms) => { sleepCalls.push(ms); } });
  driver.configureDelay("list", 5_000);

  const start = Date.now();
  await driver.list();
  const elapsed = Date.now() - start;

  expect(sleepCalls).toEqual([5_000]);
  expect(elapsed).toBeLessThan(200);
});

test("crashDriver rejects future calls and tears down active recovery streams", async () => {
  const driver = new InMemoryRmuxDriver();
  const handle = await driver.create(baseCreateInput());

  const events: RmuxRecoveryEvent[] = [];
  let sawError: unknown;
  const drain = (async () => {
    try {
      for await (const event of driver.recover(handle.paneId)) {
        events.push(event);
      }
    } catch (err) {
      sawError = err;
    }
  })();

  await Promise.resolve();
  await Promise.resolve();

  driver.crashDriver();
  await drain;

  expect(events.map((e) => e.type)).toEqual(["rebase", "exit"]);
  expect(sawError).toBeUndefined();
  await expect(driver.input(handle.paneId, new Uint8Array())).rejects.toBeInstanceOf(RmuxDriverCrashedError);
  await expect(driver.list()).rejects.toBeInstanceOf(RmuxDriverCrashedError);
});

test("diagnostics reports a version/capability stub and is overridable", async () => {
  const driver = new InMemoryRmuxDriver();
  const diag = await driver.diagnostics();
  expect(diag.bridgeVersion).toBeTruthy();
  expect(diag.rmuxWireVersion).toBeTruthy();
  expect(diag.capabilities).toContain("terminal.rmux.recovery.v1");
  expect(diag.capabilities).toContain("terminal.multi-view.v1");

  driver.setDiagnostics({ bridgeVersion: "9.9.9" });
  expect((await driver.diagnostics()).bridgeVersion).toBe("9.9.9");
});
