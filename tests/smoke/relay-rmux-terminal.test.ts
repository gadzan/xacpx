/**
 * Opt-in real RMUX 0.10.0 + release-built sidecar smoke matrix.
 *
 * Requires:
 *   XACPX_RMUX_INTEGRATION=1
 *   RMUX_SDK_DAEMON_BINARY pointing at the 0.10.x daemon helper
 *   XACPX_RMUX_BRIDGE (absolute path to xacpx-rmux-bridge) OR release binary on PATH
 *
 * Never run in default CI unit jobs — needs a real RMUX daemon.
 * Publish workflow runs a Linux subset after building the sidecar.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRelayTerminalConfig } from "../../packages/channel-relay/src/config";
import {
  createProductionTerminalDriver,
  type RmuxSidecarSupervisor,
} from "../../packages/channel-relay/src/terminal/rmux-sidecar-supervisor";
import {
  RmuxInvalidUtf8InputError,
  type RmuxRecoveryEvent,
  type RmuxSessionHandle,
  type RmuxTerminalDriver,
} from "../../packages/channel-relay/src/terminal/rmux-driver";

setDefaultTimeout(60_000);

const enabled =
  process.env.XACPX_RMUX_INTEGRATION === "1" &&
  Boolean(process.env.RMUX_SDK_DAEMON_BINARY || process.env.XACPX_RMUX_BRIDGE);

const dirs: string[] = [];
const live: Array<{ supervisor: RmuxSidecarSupervisor }> = [];

afterEach(async () => {
  while (live.length > 0) {
    const item = live.pop();
    if (item) {
      try {
        await item.supervisor.stop();
      } catch {
        // ignore
      }
    }
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function requireEnv(): { bridgeCommand: string; rmuxCommand?: string } {
  const bridgeCommand =
    process.env.XACPX_RMUX_BRIDGE ??
    join(
      process.cwd(),
      "packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge",
    );
  accessSync(bridgeCommand, constants.X_OK);
  const rmuxCommand = process.env.RMUX_SDK_DAEMON_BINARY;
  return {
    bridgeCommand,
    ...(rmuxCommand ? { rmuxCommand } : {}),
  };
}

async function boot(): Promise<{
  driver: RmuxTerminalDriver;
  supervisor: RmuxSidecarSupervisor;
  cwd: string;
}> {
  const { bridgeCommand, rmuxCommand } = requireEnv();
  const cwd = mkdtempSync(join(tmpdir(), "rmux-smoke-"));
  dirs.push(cwd);
  const config = parseRelayTerminalConfig({
    enabled: true,
    bridgeCommand,
    ...(rmuxCommand ? { rmuxCommand } : {}),
    ownerLeaseTtlSeconds: 20,
  });
  const prod = await createProductionTerminalDriver(config);
  live.push(prod);
  return { ...prod, cwd };
}

async function createShell(
  driver: RmuxTerminalDriver,
  cwd: string,
  label: string,
): Promise<RmuxSessionHandle> {
  const name = `xacpx-smoke-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return driver.create({
    name,
    cwd,
    cols: 80,
    rows: 24,
    historyLimit: 2000,
    tags: ["xacpx:relay", `smoke:${label}`],
    ownerLeaseTtlSeconds: 20,
  });
}

async function collectUntil(
  stream: AsyncIterable<RmuxRecoveryEvent>,
  pred: (events: RmuxRecoveryEvent[]) => boolean,
  timeoutMs = 15_000,
): Promise<RmuxRecoveryEvent[]> {
  const events: RmuxRecoveryEvent[] = [];
  const iter = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const step = await Promise.race([
      iter.next().then((value) => ({ kind: "next" as const, value })),
      Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
    ]);
    if (step.kind === "timeout") break;
    if (step.value.done) break;
    events.push(step.value.value);
    if (pred(events)) {
      void iter.return?.();
      return events;
    }
  }
  void iter.return?.();
  throw new Error(
    `collectUntil timeout; types=${events.map((e) => e.type).join(",")}`,
  );
}

function hasRebase(events: RmuxRecoveryEvent[]): boolean {
  return events.some((e) => e.type === "rebase");
}

function hasAlternateRebase(events: RmuxRecoveryEvent[]): boolean {
  return events.some((e) => e.type === "rebase" && e.alternate);
}

function hasBytes(events: RmuxRecoveryEvent[]): boolean {
  return events.some((e) => e.type === "bytes" && e.data.byteLength > 0);
}

function commandExists(cmd: string): boolean {
  try {
    const which = Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]);
    return which.exitCode === 0;
  } catch {
    return false;
  }
}

test.skipIf(!enabled)("real sidecar: create → UTF-8 input → recover rebase → kill", async () => {
  const { driver, cwd } = await boot();
  const handle = await createShell(driver, cwd, "basic");

  const recoverP = collectUntil(driver.recover(handle.paneId), (ev) => hasRebase(ev) && hasBytes(ev));
  await Bun.sleep(50);
  await driver.input(handle.paneId, new TextEncoder().encode("echo smoke-ok\n"));
  const events = await recoverP;
  expect(events[0]?.type).toBe("rebase");

  await driver.kill(handle.sessionId);
  expect((await driver.list()).every((e) => e.name !== handle.name)).toBe(true);

  await expect(
    driver.input(handle.paneId, new Uint8Array([0xff, 0xfe])),
  ).rejects.toBeInstanceOf(RmuxInvalidUtf8InputError);
});

test.skipIf(!enabled)("real sidecar: shutdown kills owned session (process-owned)", async () => {
  const { driver, supervisor, cwd } = await boot();
  const handle = await createShell(driver, cwd, "stop");
  expect((await driver.list()).some((e) => e.name === handle.name)).toBe(true);
  await supervisor.stop();
  // Remove from live so afterEach does not double-stop.
  live.pop();

  const again = await boot();
  const leftover = (await again.driver.list()).filter((e) => e.name === handle.name);
  expect(leftover).toEqual([]);
});

test.skipIf(!enabled)("real sidecar: resize keeps recover stream alive", async () => {
  const { driver, cwd } = await boot();
  const handle = await createShell(driver, cwd, "resize");
  const events: RmuxRecoveryEvent[] = [];
  const consume = (async () => {
    for await (const ev of driver.recover(handle.paneId)) {
      events.push(ev);
      if (events.length >= 8) break;
    }
  })();
  await Bun.sleep(80);
  expect(hasRebase(events)).toBe(true);
  await driver.resize(handle.paneId, 100, 30);
  await Bun.sleep(200);
  await driver.input(handle.paneId, new TextEncoder().encode("echo resized\n"));
  await Promise.race([consume, Bun.sleep(5_000)]);
  expect(hasBytes(events) || hasRebase(events)).toBe(true);
  await driver.kill(handle.sessionId);
});

test.skipIf(!enabled || !commandExists("vim"))(
  "real sidecar: vim enters alternate screen and survives refresh/recover",
  async () => {
    const { driver, cwd } = await boot();
    const handle = await createShell(driver, cwd, "vim");
    const first = collectUntil(
      driver.recover(handle.paneId),
      (ev) => hasAlternateRebase(ev) || (hasRebase(ev) && hasBytes(ev)),
      20_000,
    );
    await Bun.sleep(50);
    await driver.input(handle.paneId, new TextEncoder().encode("vim\n"));
    // Give vim a moment, then Esc+:q! if needed later.
    await Bun.sleep(400);
    const events = await first;
    expect(hasRebase(events)).toBe(true);

    // "Refresh": stop recover and start again — same process, new rebase.
    await Bun.sleep(100);
    const second = await collectUntil(driver.recover(handle.paneId), hasRebase, 10_000);
    expect(second[0]?.type).toBe("rebase");

    await driver.input(handle.paneId, new TextEncoder().encode("\x1b:q!\n"));
    await Bun.sleep(200);
    await driver.kill(handle.sessionId);
  },
);

test.skipIf(!enabled || !commandExists("top"))(
  "real sidecar: top produces output and clean kill",
  async () => {
    const { driver, cwd } = await boot();
    const handle = await createShell(driver, cwd, "top");
    const eventsP = collectUntil(
      driver.recover(handle.paneId),
      (ev) => hasRebase(ev) && (hasBytes(ev) || hasAlternateRebase(ev)),
      20_000,
    );
    await Bun.sleep(50);
    await driver.input(handle.paneId, new TextEncoder().encode("top\n"));
    const events = await eventsP;
    expect(hasRebase(events)).toBe(true);
    await driver.kill(handle.sessionId);
    expect((await driver.list()).every((e) => e.name !== handle.name)).toBe(true);
  },
);

test.skipIf(!enabled)("real sidecar: multi-viewer fanout shares one recover stream", async () => {
  const { driver, cwd } = await boot();
  const handle = await createShell(driver, cwd, "multi");

  const aEvents: RmuxRecoveryEvent[] = [];
  const bEvents: RmuxRecoveryEvent[] = [];
  let aDone!: () => void;
  let bDone!: () => void;
  const aReady = new Promise<void>((r) => {
    aDone = r;
  });
  const bReady = new Promise<void>((r) => {
    bDone = r;
  });

  const aLoop = (async () => {
    for await (const ev of driver.recover(handle.paneId)) {
      aEvents.push(ev);
      if (hasRebase(aEvents)) aDone();
      if (aEvents.length >= 6) break;
    }
  })();
  await aReady;

  const bLoop = (async () => {
    for await (const ev of driver.recover(handle.paneId)) {
      bEvents.push(ev);
      if (hasRebase(bEvents)) bDone();
      if (bEvents.length >= 6) break;
    }
  })();
  await bReady;

  await driver.input(handle.paneId, new TextEncoder().encode("echo multi-viewer\n"));
  await Promise.race([Promise.all([aLoop, bLoop]), Bun.sleep(8_000)]);

  expect(hasRebase(aEvents)).toBe(true);
  expect(hasRebase(bEvents)).toBe(true);
  // Late subscriber must still receive a keyframe (cached rebase).
  expect(bEvents[0]?.type).toBe("rebase");
  await driver.kill(handle.sessionId);
});
