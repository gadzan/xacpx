import { TerminalRegistryLockedError, TerminalRegistryStore } from "../../packages/channel-relay/src/terminal/terminal-registry-store";

const store = new TerminalRegistryStore({ dir: process.argv[2]!, exclusiveWriter: true });
try {
  await store.load();
  process.stdout.write("ACQUIRED\n");
  process.stdin.resume();
  process.stdin.once("data", () => {
    void store.close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  });
} catch (error) {
  if (!(error instanceof TerminalRegistryLockedError)) throw error;
  process.stdout.write("BUSY\n");
  process.exitCode = 3;
}
