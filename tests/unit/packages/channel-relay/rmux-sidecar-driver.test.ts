import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  RmuxDriverCrashedError,
  RmuxInvalidUtf8InputError,
} from "../../../../packages/channel-relay/src/terminal/rmux-driver";
import { RmuxSidecarDriver } from "../../../../packages/channel-relay/src/terminal/rmux-sidecar-driver";

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
    protocol_version: 1,
    rmux_wire_version: "0.10.0",
    capabilities: ["create", "list", "kill", "input", "resize", "recover"],
  });
  await hs;
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
  await Promise.resolve();
  const recoverLine = fake.written.find((w) => w.includes('"recover"'));
  const recoverReq = JSON.parse(recoverLine!.trim()) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });
  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "rebase",
        epoch: 1,
        next_sequence: 1,
        cols: 80,
        rows: 24,
        alternate: false,
        keyframe_base64: Buffer.from("hi").toString("base64"),
      },
    })}\n`,
  );
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
  await Promise.resolve();
  const recoverLines = fake.written.filter((w) => w.includes('"recover"'));
  expect(recoverLines.length).toBe(1);
  const recoverReq = JSON.parse(recoverLines[0]!.trim()) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });
  const rebase = {
    type: "event",
    pane_id: "%1",
    event: {
      type: "rebase",
      epoch: 1,
      next_sequence: 1,
      cols: 80,
      rows: 24,
      alternate: false,
      keyframe_base64: Buffer.from("hi").toString("base64"),
    },
  };
  fake.stdout.write(`${JSON.stringify(rebase)}\n`);
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
  await Promise.resolve();
  const recoverReq = JSON.parse(
    fake.written.find((w) => w.includes('"recover"'))!.trim(),
  ) as { id: string };
  fake.reply({ type: "ok", id: recoverReq.id });

  fake.stdout.write(
    `${JSON.stringify({
      type: "event",
      pane_id: "%1",
      event: {
        type: "rebase",
        epoch: 1,
        next_sequence: 0,
        cols: 80,
        rows: 24,
        alternate: false,
        keyframe_base64: Buffer.from("base").toString("base64"),
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
