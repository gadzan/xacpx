import { sep } from "node:path";

import { expect, test } from "bun:test";

import { createChannelConsumerLocks } from "../../src/cli";
import type { ConsumerLock, ConsumerLockOptions } from "../../src/channels/types";

// Lives in its own file because `tests/unit/cli.test.ts` dies mid-run: its
// mcp-stdio tests end the process, so the ~15 tests declared after them never
// execute and the file still exits 0.
//
// Round 7 (High): the runtime used to hand `createRuntimeConsumerLock` only
// `lockCreators[0]`, so with Weixin and Discord both enabled exactly one of them
// had a cross-process fence. Registration order is not a contract, so the wiring
// must produce one fence per channel and keep each channel's own id on its
// diagnostics.
test("the runtime consumer lock gets one fence per lock-capable channel", async () => {
  const seen: ConsumerLockOptions[] = [];
  const logs: string[] = [];
  const creators = ["discord", "weixin", "relay"].map((id) => ({
    channel: { id },
    create: (options?: ConsumerLockOptions): ConsumerLock => {
      seen.push(options ?? {});
      return { acquire: async () => {}, release: async () => {} };
    },
  }));

  const locks = createChannelConsumerLocks(creators, {
    runtimeDir: "/rt",
    onDiagnostic: async (channelId, event) => { logs.push(`${channelId}.${event}`); },
  });

  expect(locks).toHaveLength(3);
  expect(seen.map((options) => options.lockFilePath)).toEqual([
    `/rt${sep}discord-consumer.lock.json`,
    `/rt${sep}relay-consumer.lock.json`,
    `/rt${sep}weixin-consumer.lock.json`,
  ]);

  await Promise.all(seen.map((options) => options.onDiagnostic?.("lock_acquired", {})));
  expect([...logs].sort()).toEqual([
    "discord.lock_acquired",
    "relay.lock_acquired",
    "weixin.lock_acquired",
  ]);
});
