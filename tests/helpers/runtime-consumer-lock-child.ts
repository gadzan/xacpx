import { join } from "node:path";

import {
  ActiveRuntimeConsumerLockError,
  createRuntimeConsumerLock,
} from "../../src/daemon/runtime-consumer-lock";

const runtimeRoot = process.argv[2]!;
const mode = process.argv[3];
const hold = mode === "hold" || mode === "lose-helper" || mode === "graceful-group";
if (mode === "lose-helper") {
  process.on("SIGTERM", () => {
    process.stdout.write("SIGTERM_CAUGHT\n");
  });
}
const lock = createRuntimeConsumerLock({
  lockFilePath: join(runtimeRoot, "runtime-consumer.lock.json"),
  onDiagnostic: (event, context) => {
    if (event === "lock_helper_started") {
      process.stdout.write(`HELPER:${context.helperPid}\n`);
    }
  },
});
if (mode === "graceful-group") {
  let releasing = false;
  process.on("SIGTERM", () => {
    if (releasing) return;
    releasing = true;
    void lock.release().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

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
