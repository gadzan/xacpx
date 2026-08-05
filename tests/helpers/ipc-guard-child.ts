import { acquireIpcGuard, IpcGuardBusyError } from "../../src/process/ipc-guard.ts";

const [configRoot, hold] = process.argv.slice(2);
if (!configRoot) throw new Error("usage: ipc-guard-child.ts <configRoot> [hold]");

try {
  const guard = await acquireIpcGuard({ role: "test", configRoot });
  process.stdout.write(`ACQUIRED:${process.pid}\n`);
  if (hold === "hold") {
    setInterval(() => {}, 1000);
  } else {
    await guard.release();
  }
} catch (error) {
  if (error instanceof IpcGuardBusyError) {
    process.stdout.write("BUSY\n");
    process.exitCode = 3;
  } else {
    throw error;
  }
}
