import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeConsumerLock } from "../../../src/daemon/runtime-consumer-lock";
import type { ConsumerLock, ConsumerLockMetadata } from "../../../src/channels/types";

const metadata: ConsumerLockMetadata = {
  pid: 70002,
  mode: "daemon",
  startedAt: "2026-08-06T13:00:00.000Z",
  configPath: "/cfg/config.json",
  statePath: "/cfg/state.json",
};

test("runtime ownership composes the core lock with a legacy channel lock", async () => {
  const events: string[] = [];
  const core = fakeLock("core", events);
  const channel = fakeLock("channel", events);
  const lock = createRuntimeConsumerLock({
    runtimeDir: "/runtime",
    channelLock: channel,
    createCoreLock: () => core,
  });

  await lock.acquire(metadata);
  await lock.release();

  expect(events).toEqual([
    "core:acquire:70002",
    "channel:acquire:70002",
    "channel:release",
    "core:release",
  ]);
});

test("channel lock failure releases the core ownership claim", async () => {
  const events: string[] = [];
  const lock = createRuntimeConsumerLock({
    runtimeDir: "/runtime",
    createCoreLock: () => fakeLock("core", events),
    channelLock: {
      acquire: async () => {
        events.push("channel:acquire");
        throw new Error("channel already owned");
      },
      release: async () => { events.push("channel:release"); },
    },
  });

  await expect(lock.acquire(metadata)).rejects.toThrow("channel already owned");
  expect(events).toEqual(["core:acquire:70002", "channel:acquire", "core:release"]);
});

test("the core runtime lock is exclusive without any channel lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-consumer-lock-"));
  const first = createRuntimeConsumerLock({ runtimeDir: join(root, "runtime") });
  const second = createRuntimeConsumerLock({ runtimeDir: join(root, "runtime") });
  const input: ConsumerLockMetadata = {
    ...metadata,
    pid: process.pid,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
  };

  await first.acquire(input);
  await expect(second.acquire(input)).rejects.toThrow("xacpx runtime is already running");
  await first.release();
  await second.acquire(input);
  await second.release();

  await rm(root, { recursive: true, force: true });
});

function fakeLock(name: string, events: string[]): ConsumerLock {
  return {
    acquire: async (input) => { events.push(`${name}:acquire:${input.pid}`); },
    release: async () => { events.push(`${name}:release`); },
  };
}
