import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  RmuxDriverCrashedError,
  RmuxInvalidUtf8InputError,
} from "../../../../packages/channel-relay/src/terminal/rmux-driver";
import {
  RmuxSidecarDriver,
  type RmuxRecoveryEvent,
} from "../../../../packages/channel-relay/src/terminal/rmux-sidecar-driver";

function makeFakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const life = new EventEmitter();
  const written: string[] = [];
  stdin.on("data", (chunk: Buffer) => {
    written.push(chunk.toString("utf8"));
  });
  return {
    child: {
      stdin,
      stdout,
      stderr,
      kill: () => life.emit("exit", 0),
      on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => {
        life.on(event, listener);
      },
    },
    stdout,
    written,
    life,
    reply(obj: Record<string, unknown>) {
      stdout.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

async function withHandshake(driver: RmuxSidecarDriver, fake: ReturnType<typeof makeFakeChild>) {
  const hs = driver.handshake();
  await Promise.resolve();
  const line = fake.written.find((w) => w.includes('"handshake"'));
  expect(line).toBeTruthy();
  const req = JSON.parse(line!.trim()) as { id: string };
  fake.reply({
    type: "handshake-ok",
    id: req.id,
    bridge_version: "0.1.0",
    protocol_version: 2,
    rmux_wire_version: "0.10.0",
    capabilities: ["create", "list", "kill", "input", "resize", "recover"],
  });
  await hs;
}

const REBASE_CHUNK_BYTES = 48 * 1024;

function writeRebase(
  stdout: NodeJS.WritableStream,
  paneId: string,
  keyframe: Uint8Array | string,
  meta: { epoch?: number; nextSequence?: number; cols?: number; rows?: number } = {},
): void {
  const bytes = typeof keyframe === "string" ? Buffer.from(keyframe) : Buffer.from(keyframe);
  const epoch = meta.epoch ?? 1;
  const chunkCount = bytes.byteLength === 0 ? 0 : Math.ceil(bytes.byteLength / REBASE_CHUNK_BYTES);
  stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: paneId,
      event: {
        type: "rebase-start",
        epoch,
        next_sequence: meta.nextSequence ?? 1,
        cols: meta.cols ?? 80,
        rows: meta.rows ?? 24,
        alternate: false,
        total_bytes: bytes.byteLength,
        chunk_count: chunkCount,
      },
    })}\n`,
  );
  for (let index = 0; index < chunkCount; index++) {
    const chunk = bytes.subarray(index * REBASE_CHUNK_BYTES, (index + 1) * REBASE_CHUNK_BYTES);
    stdout.write(
      `${JSON.stringify({
        type: "event",
        pane_id: paneId,
        event: {
          type: "rebase-chunk",
          epoch,
          index,
          data_base64: Buffer.from(chunk).toString("base64"),
        },
      })}\n`,
    );
  }
  stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: paneId,
      event: { type: "rebase-end", epoch },
    })}\n`,
  );
}

test("sidecar driver handshake then diagnostics", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);
  const diag = await driver.diagnostics();
  expect(diag.bridgeVersion).toBe("0.1.0");
  expect(diag.rmuxWireVersion).toBe("0.10.0");
});

test("sidecar driver create/list/kill round-trip", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const createP = driver.create({
    name: "xacpx-relay-test",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    historyLimit: 1000,
    tags: ["xacpx:relay"],
    ownerLeaseTtlSeconds: 30,
  });
  await Promise.resolve();
  const createLine = fake.written.find((w) => w.includes('"create"'));
  const createReq = JSON.parse(createLine!.trim()) as { id: string };
  fake.reply({
    type: "session",
    id: createReq.id,
    session_id: "xacpx-relay-test",
    pane_id: "%1",
    name: "xacpx-relay-test",
    tags: ["xacpx:relay"],
  });
  const handle = await createP;
  expect(handle.sessionId).toBe("xacpx-relay-test");
  expect(handle.paneId).toBe("%1");

  const listP = driver.list();
  await Promise.resolve();
  const listLine = fake.written.find((w) => w.includes('"list"'));
  const listReq = JSON.parse(listLine!.trim()) as { id: string };
  fake.reply({
    type: "inventory",
    id: listReq.id,
    entries: [
      {
        session_id: "xacpx-relay-test",
        pane_id: "%1",
        name: "xacpx-relay-test",
        tags: ["xacpx:relay"],
      },
    ],
  });
  expect(await listP).toEqual([
    {
      sessionId: "xacpx-relay-test",
      paneId: "%1",
      name: "xacpx-relay-test",
      tags: ["xacpx:relay"],
    },
  ]);

  const killP = driver.kill("xacpx-relay-test");
  await Promise.resolve();
  const killLine = fake.written.find((w) => w.includes('"kill"'));
  const killReq = JSON.parse(killLine!.trim()) as { id: string };
  fake.reply({ type: "ok", id: killReq.id });
  await killP;
});

test("sidecar driver rejects invalid UTF-8 input", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);
  await expect(driver.input("%1", new Uint8Array([0xff, 0xfe]))).rejects.toBeInstanceOf(
    RmuxInvalidUtf8InputError,
  );
});

test("sidecar driver fences after child exit", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);
  fake.life.emit("exit", 1);
  await expect(driver.list()).rejects.toBeInstanceOf(RmuxDriverCrashedError);
});

test("sidecar crash includes trailing stderr from the bridge", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  fake.child.stderr!.write(
    "xacpx-rmux-bridge fatal: bridge connect: rmux connect failed: no daemon\n",
  );
  fake.life.emit("exit", 1);
  await expect(driver.handshake()).rejects.toMatchObject({
    name: "RmuxDriverCrashedError",
    message: expect.stringContaining("no daemon"),
  });
});


test("protocol corruption kill child so supervisor can restart", async () => {
  const fake = makeFakeChild();
  let killed = false;
  const child = {
    ...fake.child,
    kill: () => {
      killed = true;
      fake.life.emit("exit", 1);
    },
  };
  const driver = new RmuxSidecarDriver(child);
  await withHandshake(driver, fake);
  let crashed = false;
  driver.onCrash(() => {
    crashed = true;
  });
  fake.stdout.write("this is not json\n");
  await Bun.sleep(10);
  expect(crashed).toBe(true);
  expect(killed).toBe(true);
  await expect(driver.list()).rejects.toBeInstanceOf(RmuxDriverCrashedError);
});

test("sidecar driver recover stream delivers rebase then exit", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const events: Array<{ type: string }> = [];
  const iterP = (async () => {
    for await (const ev of driver.recover("%1")) {
      events.push(ev);
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  const recoverLine = fake.written.find((w) => w.includes('"recover"'));
  const recoverReq = JSON.parse(recoverLine!.trim()) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });
  writeRebase(fake.stdout, "%1", "hi");
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: { type: "exit", code: 0 },
    })}\n`,
  );
  await iterP;
  expect(events.map((e) => e.type)).toEqual(["rebase", "exit"]);
});

test("sidecar driver fans out recover to a late second subscriber without restart", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aEvents: Array<{ type: string }> = [];
  const aP = (async () => {
    for await (const ev of driver.recover("%1")) {
      aEvents.push(ev);
      if (aEvents.length >= 2) break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  const recoverLines = fake.written.filter((w) => w.includes('"recover"'));
  expect(recoverLines.length).toBe(1);
  const recoverReq = JSON.parse(recoverLines[0]!.trim()) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });
  writeRebase(fake.stdout, "%1", "hi");
  await Bun.sleep(10);

  const bEvents: Array<{ type: string }> = [];
  const bP = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (bEvents.length >= 1) break;
    }
  })();
  await Bun.sleep(10);
  // Still a single recover request — second subscriber uses cached rebase.
  expect(fake.written.filter((w) => w.includes('"recover"')).length).toBe(1);
  expect(bEvents[0]?.type).toBe("rebase");

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: { type: "exit", code: 0 },
    })}\n`,
  );
  await Promise.all([aP, bP]);
  expect(aEvents.map((e) => e.type)).toContain("rebase");
});

test("late subscriber receives post-rebase bytes so live sequence does not gap", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      aEvents.push(ev);
      if (ev.type === "exit") break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  const recoverReq = JSON.parse(
    fake.written.find((w) => w.includes('"recover"'))!.trim(),
  ) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });

  writeRebase(fake.stdout, "%1", "base", { nextSequence: 0 });
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 1,
        sequence: 0,
        data_base64: Buffer.from("one").toString("base64"),
      },
    })}\n`,
  );
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 1,
        sequence: 1,
        data_base64: Buffer.from("two").toString("base64"),
      },
    })}\n`,
  );
  await Bun.sleep(15);
  expect(aEvents.map((e) => e.type)).toEqual(["rebase", "bytes", "bytes"]);

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "exit") break;
    }
  })();
  await Bun.sleep(15);

  // Catch-up must include both post-rebase bytes before any later live event.
  expect(bEvents.map((e) => e.type)).toEqual(["rebase", "bytes", "bytes"]);
  expect(bEvents[0]).toMatchObject({ type: "rebase", nextSequence: 0 });
  expect(bEvents[1]).toMatchObject({ type: "bytes", sequence: 0 });
  expect(bEvents[2]).toMatchObject({ type: "bytes", sequence: 1 });
  expect(fake.written.filter((w) => w.includes('"recover"')).length).toBe(1);

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 1,
        sequence: 2,
        data_base64: Buffer.from("three").toString("base64"),
      },
    })}\n`,
  );
  await Bun.sleep(15);
  expect(bEvents[3]).toMatchObject({ type: "bytes", sequence: 2 });

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: { type: "exit", code: 0 },
    })}\n`,
  );
  await Promise.all([aDone, bDone]);
});

test("sidecar driver reassembles a keyframe that would overflow a 96KiB NDJSON line", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const events: RmuxRecoveryEvent[] = [];
  const iterP = (async () => {
    for await (const ev of driver.recover("%1")) {
      events.push(ev);
      if (ev.type === "rebase") break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  const recoverReq = JSON.parse(
    fake.written.find((w) => w.includes('"recover"'))!.trim(),
  ) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });

  const keyframe = Buffer.alloc(100_000, 0x61);
  writeRebase(fake.stdout, "%1", keyframe);
  await iterP;
  expect(events[0]?.type).toBe("rebase");
  if (events[0]?.type !== "rebase") return;
  expect(events[0].keyframe.byteLength).toBe(100_000);
});

function ackLast(fake: ReturnType<typeof makeFakeChild>, type: string): boolean {
  for (let i = fake.written.length - 1; i >= 0; i--) {
    for (const line of fake.written[i]!.trim().split("\n")) {
      if (!line.includes(`"${type}"`)) continue;
      const req = JSON.parse(line) as { id: string; type: string };
      if (req.type === type) {
        fake.reply({ type: "ok", id: req.id });
        return true;
      }
    }
  }
  return false;
}

function nackLast(fake: ReturnType<typeof makeFakeChild>, type: string, message: string): boolean {
  for (let i = fake.written.length - 1; i >= 0; i--) {
    for (const line of fake.written[i]!.trim().split("\n")) {
      if (!line.includes(`"${type}"`)) continue;
      const req = JSON.parse(line) as { id: string; type: string };
      if (req.type === type) {
        fake.reply({ type: "error", id: req.id, message });
        return true;
      }
    }
  }
  return false;
}

function parsedWrites(fake: ReturnType<typeof makeFakeChild>): Array<{ id?: string; type?: string }> {
  const out: Array<{ id?: string; type?: string }> = [];
  for (const chunk of fake.written) {
    for (const line of chunk.trim().split("\n")) {
      if (!line) continue;
      out.push(JSON.parse(line) as { id?: string; type?: string });
    }
  }
  return out;
}

function requestCount(fake: ReturnType<typeof makeFakeChild>, type: string): number {
  return parsedWrites(fake).filter((r) => r.type === type).length;
}

async function pumpUntil(pred: () => boolean, label: string, turns = 32): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("catch-up cache over budget asks RMUX for a fresh rebase instead of synthesizing an oversized keyframe", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      aEvents.push(ev);
      if (ev.type === "exit") break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  expect(ackLast(fake, "recover")).toBe(true);

  writeRebase(fake.stdout, "%1", "base", { nextSequence: 0 });
  await Bun.sleep(15);
  expect(aEvents[0]?.type).toBe("rebase");
  if (aEvents[0]?.type === "rebase") {
    expect(aEvents[0].keyframe.byteLength).toBeLessThan(16);
  }

  const chunk = Buffer.alloc(48 * 1024, 0x61);
  const chunkB64 = chunk.toString("base64");
  let sent = 0;
  let sequence = 0;
  while (sent <= 2 * 1024 * 1024) {
    fake.stdout.write(
      `${JSON.stringify({
        type: "event",
        pane_id: "%1",
        event: {
          type: "bytes",
          epoch: 1,
          sequence,
          data_base64: chunkB64,
        },
      })}\n`,
    );
    sent += chunk.byteLength;
    sequence += 1;
  }
  await Bun.sleep(30);
  expect(ackLast(fake, "stop-recover")).toBe(true);
  await Bun.sleep(10);
  expect(ackLast(fake, "recover")).toBe(true);

  writeRebase(fake.stdout, "%1", "fresh", { epoch: 2, nextSequence: 0 });
  await Bun.sleep(20);
  const lastRebase = [...aEvents].reverse().find((e) => e.type === "rebase");
  expect(lastRebase).toMatchObject({ type: "rebase", epoch: 2 });
  if (lastRebase?.type === "rebase") {
    expect(lastRebase.keyframe.byteLength).toBe(5);
  }

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "exit") break;
    }
  })();
  await Bun.sleep(20);
  expect(bEvents[0]).toMatchObject({ type: "rebase", epoch: 2 });
  if (bEvents[0]?.type === "rebase") {
    expect(bEvents[0].keyframe.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(bEvents[0].keyframe.byteLength).toBe(5);
  }

  fake.stdout.write(
    `${JSON.stringify({ type: "event", pane_id: "%1", event: { type: "exit", code: 0 } })}\n`,
  );
  await Promise.all([aDone, bDone]);
});

test("sidecar oversized rebase error is forwarded instead of dropped", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const events: RmuxRecoveryEvent[] = [];
  const iterP = (async () => {
    for await (const ev of driver.recover("%1")) {
      events.push(ev);
      if (ev.type === "error") break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  expect(ackLast(fake, "recover")).toBe(true);
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: { type: "error", code: "rebase-too-large", message: "rebase keyframe too large" },
    })}\n`,
  );
  await iterP;
  expect(events).toEqual([
    { type: "error", code: "rebase-too-large", message: "rebase keyframe too large" },
  ]);
});

test("post-start recovery stream error fails live subscribers", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const events: RmuxRecoveryEvent[] = [];
  const thrown: { current?: unknown } = {};
  const iterP = (async () => {
    try {
      for await (const ev of driver.recover("%1")) {
        events.push(ev);
      }
    } catch (err) {
      thrown.current = err;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "hi", { nextSequence: 0 });
  await pumpUntil(() => events.some((e) => e.type === "rebase"), "rebase");
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: { type: "bytes", epoch: 1, sequence: 0, data_base64: Buffer.from("x").toString("base64") },
    })}\n`,
  );
  await pumpUntil(() => events.some((e) => e.type === "bytes"), "bytes");
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "error",
        code: "recovery-stream-failed",
        message: "recover_output failed: connection reset",
      },
    })}\n`,
  );
  await iterP;
  expect(events.map((e) => e.type)).toEqual(["rebase", "bytes"]);
  expect(thrown.current).toBeInstanceOf(Error);
  expect(String(thrown.current)).toContain("recover_output failed");
});

test("protocol fatal crash fails recover iterators as RmuxDriverCrashedError", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const thrown: { current?: unknown } = {};
  const iterP = (async () => {
    try {
      for await (const _ev of driver.recover("%1")) {
        // wait for crash
      }
    } catch (err) {
      thrown.current = err;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "recover written");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "hi");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  fake.stdout.write("this is not json\n");
  await iterP;
  expect(thrown.current).toBeInstanceOf(RmuxDriverCrashedError);
});

test("replacement after last-subscriber stop does not see old-stream bytes first", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aAbort = new AbortController();
  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    for await (const ev of driver.recover("%1", aAbort.signal)) {
      aEvents.push(ev);
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "old", { nextSequence: 0 });
  await pumpUntil(() => aEvents.some((e) => e.type === "rebase"), "A rebase");

  aAbort.abort();
  await Promise.resolve();

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "bytes") break;
    }
  })();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 1,
        sequence: 0,
        data_base64: Buffer.from("stale").toString("base64"),
      },
    })}\n`,
  );
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(bEvents).toEqual([]);
  await pumpUntil(() => requestCount(fake, "stop-recover") === 1, "queued stop still runs");
  expect(requestCount(fake, "recover")).toBe(1);
  expect(ackLast(fake, "stop-recover")).toBe(true);
  await pumpUntil(() => requestCount(fake, "recover") === 2, "replacement recover after stop");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "fresh", { epoch: 2, nextSequence: 0 });
  await pumpUntil(() => bEvents.some((e) => e.type === "rebase"), "B fresh rebase");
  expect(bEvents[0]).toMatchObject({ type: "rebase", epoch: 2 });
  expect(bEvents.some((e) => e.type === "bytes")).toBe(false);

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 2,
        sequence: 0,
        data_base64: Buffer.from("live").toString("base64"),
      },
    })}\n`,
  );
  await pumpUntil(() => bEvents.some((e) => e.type === "bytes"), "B live bytes after rebase");
  expect(bEvents.map((e) => e.type)).toEqual(["rebase", "bytes"]);
  await Promise.all([aDone, bDone]);
});

test("stop-recover request timeout does not arm a late joiner on the old stream", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child, { stopRecoverTimeoutMs: 40 });
  await withHandshake(driver, fake);

  const aAbort = new AbortController();
  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    for await (const ev of driver.recover("%1", aAbort.signal)) {
      aEvents.push(ev);
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "old", { nextSequence: 0 });
  await pumpUntil(() => aEvents.some((e) => e.type === "rebase"), "A rebase");

  aAbort.abort();
  await pumpUntil(() => requestCount(fake, "stop-recover") === 1, "stop written");
  const stopReq = parsedWrites(fake).findLast((r) => r.type === "stop-recover");
  expect(stopReq?.id).toBeTruthy();

  await Bun.sleep(80);

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "bytes") break;
    }
  })();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 1,
        sequence: 0,
        data_base64: Buffer.from("stale").toString("base64"),
      },
    })}\n`,
  );
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(bEvents).toEqual([]);
  await pumpUntil(() => requestCount(fake, "recover") === 2, "replacement recover after timeout");

  fake.reply({ type: "ok", id: stopReq!.id! });
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "fresh", { epoch: 2, nextSequence: 0 });
  await pumpUntil(() => bEvents.some((e) => e.type === "rebase"), "B fresh rebase");
  expect(bEvents[0]).toMatchObject({ type: "rebase", epoch: 2 });
  expect(bEvents.some((e) => e.type === "bytes")).toBe(false);

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 2,
        sequence: 0,
        data_base64: Buffer.from("live").toString("base64"),
      },
    })}\n`,
  );
  await pumpUntil(() => bEvents.some((e) => e.type === "bytes"), "B live bytes after rebase");
  expect(bEvents.map((e) => e.type)).toEqual(["rebase", "bytes"]);
  await Promise.all([aDone, bDone]);
});

test("in-flight stop-recover completes before a replacement recover is written", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aAbort = new AbortController();
  const aGotRebase = { value: false };
  const aDone = (async () => {
    for await (const ev of driver.recover("%1", aAbort.signal)) {
      if (ev.type === "rebase") {
        aGotRebase.value = true;
        break;
      }
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "old", { nextSequence: 0 });
  await pumpUntil(() => aGotRebase.value, "A consumed rebase");
  await pumpUntil(() => requestCount(fake, "stop-recover") === 1, "stop-recover written");
  expect(requestCount(fake, "recover")).toBe(1);

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "bytes") break;
    }
  })();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(requestCount(fake, "recover")).toBe(1);

  expect(ackLast(fake, "stop-recover")).toBe(true);
  await pumpUntil(() => requestCount(fake, "recover") === 2, "replacement recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "fresh", { epoch: 2, nextSequence: 0 });
  await pumpUntil(() => bEvents.some((e) => e.type === "rebase"), "B fresh rebase");
  expect(bEvents[0]).toMatchObject({ type: "rebase", epoch: 2 });

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 2,
        sequence: 0,
        data_base64: Buffer.from("live").toString("base64"),
      },
    })}\n`,
  );
  await pumpUntil(() => bEvents.some((e) => e.type === "bytes"), "B bytes after fresh rebase");
  await Promise.all([aDone, bDone]);
});

test("cache hit still writes recover so a finished server-side task restarts", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aAbort = new AbortController();
  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    for await (const ev of driver.recover("%1", aAbort.signal)) {
      aEvents.push(ev);
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "stale", { nextSequence: 0 });
  await pumpUntil(() => aEvents.some((e) => e.type === "rebase"), "A rebase");

  aAbort.abort();
  await Promise.resolve();

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "bytes" && ev.sequence === 0) break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "stop-recover") === 1, "gap still stops old stream");
  expect(ackLast(fake, "stop-recover")).toBe(true);
  await pumpUntil(() => requestCount(fake, "recover") === 2, "replacement recover despite cache");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "restarted", { epoch: 2, nextSequence: 0 });
  await pumpUntil(
    () => bEvents.some((e) => e.type === "rebase" && e.epoch === 2),
    "B fresh rebase after silent finish",
  );

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 2,
        sequence: 0,
        data_base64: Buffer.from("live").toString("base64"),
      },
    })}\n`,
  );
  await pumpUntil(() => bEvents.some((e) => e.type === "bytes"), "B live bytes after restart");
  await Promise.all([aDone, bDone]);
});

test("recover RPC failure rejects waiters that joined during start", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aErr: { current?: unknown } = {};
  const aDone = (async () => {
    try {
      for await (const _ev of driver.recover("%1")) {
        // should not yield
      }
    } catch (err) {
      aErr.current = err;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");

  const bErr: { current?: unknown } = {};
  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    try {
      for await (const ev of driver.recover("%1")) {
        bEvents.push(ev);
      }
    } catch (err) {
      bErr.current = err;
    }
  })();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(requestCount(fake, "recover")).toBe(1);
  expect(nackLast(fake, "recover", "recover_output failed")).toBe(true);

  await Promise.all([aDone, bDone]);
  expect(aErr.current).toBeInstanceOf(Error);
  expect(String(aErr.current)).toContain("recover_output failed");
  expect(bErr.current).toBeInstanceOf(Error);
  expect(String(bErr.current)).toContain("recover_output failed");
  expect(bEvents).toEqual([]);
});

test("snapshot refresh stop pending does not let a late joiner see old-stream bytes first", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      aEvents.push(ev);
      if (ev.type === "exit") break;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "base", { nextSequence: 0 });
  await pumpUntil(() => aEvents.some((e) => e.type === "rebase"), "A rebase");

  const chunk = Buffer.alloc(48 * 1024, 0x61);
  const chunkB64 = chunk.toString("base64");
  let sent = 0;
  let sequence = 0;
  while (sent <= 2 * 1024 * 1024) {
    fake.stdout.write(
      `${JSON.stringify({
        type: "event",
        pane_id: "%1",
        event: {
          type: "bytes",
          epoch: 1,
          sequence,
          data_base64: chunkB64,
        },
      })}\n`,
    );
    sent += chunk.byteLength;
    sequence += 1;
  }
  await pumpUntil(() => requestCount(fake, "stop-recover") === 1, "refresh stop written", 256);
  expect(requestCount(fake, "recover")).toBe(1);

  const bEvents: RmuxRecoveryEvent[] = [];
  const bDone = (async () => {
    for await (const ev of driver.recover("%1")) {
      bEvents.push(ev);
      if (ev.type === "bytes") break;
    }
  })();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 1,
        sequence,
        data_base64: Buffer.from("stale").toString("base64"),
      },
    })}\n`,
  );
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(bEvents).toEqual([]);
  expect(requestCount(fake, "recover")).toBe(1);

  expect(ackLast(fake, "stop-recover")).toBe(true);
  await pumpUntil(() => requestCount(fake, "recover") === 2, "refresh recover after stop");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "fresh", { epoch: 2, nextSequence: 0 });
  await pumpUntil(() => bEvents.some((e) => e.type === "rebase"), "B fresh rebase");
  expect(bEvents[0]).toMatchObject({ type: "rebase", epoch: 2 });
  expect(bEvents.some((e) => e.type === "bytes")).toBe(false);

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "bytes",
        epoch: 2,
        sequence: 0,
        data_base64: Buffer.from("live").toString("base64"),
      },
    })}\n`,
  );
  await pumpUntil(() => bEvents.some((e) => e.type === "bytes"), "B live bytes after rebase");
  expect(bEvents.map((e) => e.type)).toEqual(["rebase", "bytes"]);

  fake.stdout.write(
    `${JSON.stringify({ type: "event", pane_id: "%1", event: { type: "exit", code: 0 } })}\n`,
  );
  await Promise.all([aDone, bDone]);
});

test("snapshot refresh recover failure fails every live subscriber", async () => {
  const fake = makeFakeChild();
  const driver = new RmuxSidecarDriver(fake.child);
  await withHandshake(driver, fake);

  const aErr: { current?: unknown } = {};
  const aEvents: RmuxRecoveryEvent[] = [];
  const aDone = (async () => {
    try {
      for await (const ev of driver.recover("%1")) {
        aEvents.push(ev);
      }
    } catch (err) {
      aErr.current = err;
    }
  })();
  await pumpUntil(() => requestCount(fake, "recover") === 1, "A recover");
  expect(ackLast(fake, "recover")).toBe(true);
  writeRebase(fake.stdout, "%1", "base", { nextSequence: 0 });
  await pumpUntil(() => aEvents.some((e) => e.type === "rebase"), "A rebase");

  const bErr: { current?: unknown } = {};
  const bDone = (async () => {
    try {
      for await (const _ev of driver.recover("%1")) {
        // stay subscribed through refresh
      }
    } catch (err) {
      bErr.current = err;
    }
  })();
  await pumpUntil(() => bErr.current === undefined && aEvents.length >= 1, "B joined");
  for (let i = 0; i < 8; i++) await Promise.resolve();

  const chunk = Buffer.alloc(48 * 1024, 0x61);
  const chunkB64 = chunk.toString("base64");
  let sent = 0;
  let sequence = 0;
  while (sent <= 2 * 1024 * 1024) {
    fake.stdout.write(
      `${JSON.stringify({
        type: "event",
        pane_id: "%1",
        event: {
          type: "bytes",
          epoch: 1,
          sequence,
          data_base64: chunkB64,
        },
      })}\n`,
    );
    sent += chunk.byteLength;
    sequence += 1;
  }
  await pumpUntil(() => requestCount(fake, "stop-recover") === 1, "refresh stop-recover", 256);
  expect(ackLast(fake, "stop-recover")).toBe(true);
  await pumpUntil(() => requestCount(fake, "recover") === 2, "refresh recover", 64);
  expect(nackLast(fake, "recover", "recover_output failed")).toBe(true);

  await Promise.all([aDone, bDone]);
  expect(aErr.current).toBeInstanceOf(Error);
  expect(String(aErr.current)).toContain("recover_output failed");
  expect(bErr.current).toBeInstanceOf(Error);
  expect(String(bErr.current)).toContain("recover_output failed");
});
