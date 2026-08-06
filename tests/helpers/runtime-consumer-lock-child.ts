import { join } from "node:path";

import {
  ActiveRuntimeConsumerLockError,
  createRuntimeConsumerLock,
} from "../../src/daemon/runtime-consumer-lock";

const runtimeRoot = process.argv[2]!;
const hold = process.argv[3] === "hold";
const lock = createRuntimeConsumerLock({
  lockFilePath: join(runtimeRoot, "runtime-consumer.lock.json"),
});

try {
  await lock.acquire({
    pid: process.pid,
    mode: "daemon",
    startedAt: new Date().toISOString(),
    configPath: join(runtimeRoot, "config.json"),
    statePath: join(runtimeRoot, "state.json"),
  });
  process.stdout.write(`ACQUIRED:${process.pid}\n`);
  if (hold) {
    await new Promise(() => { setInterval(() => {}, 60_000); });
  } else {
    await lock.release();
  }
} catch (error) {
  if (error instanceof ActiveRuntimeConsumerLockError) {
    process.stdout.write("BUSY\n");
  } else {
    throw error;
  }
}
