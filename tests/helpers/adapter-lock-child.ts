import { withAdapterOperationLock } from "../../src/adapters/adapter-locks.ts";

const [runtimeRoot, adapterId, mode] = process.argv.slice(2);
if (!runtimeRoot || !adapterId) throw new Error("usage: adapter-lock-child.ts <root> <id> [hold]");

try {
  await withAdapterOperationLock({ runtimeRoot, id: adapterId }, async () => {
    process.stdout.write(`ACQUIRED:${process.pid}\n`);
    if (mode === "hold") await new Promise(() => setInterval(() => {}, 1_000));
  });
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ADAPTER_OP_LOCK_BUSY") {
    process.stdout.write("BUSY\n");
    process.exitCode = 3;
  } else {
    throw error;
  }
}
