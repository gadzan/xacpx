import { expect, test } from "bun:test";
import { runCapture } from "../../../../packages/relay/src/proc";

test("runCapture returns stdout and exit code 0 for a successful command", async () => {
  const r = await runCapture("node", ["-e", "process.stdout.write('hello')"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toBe("hello");
});

test("runCapture reports a non-zero exit code", async () => {
  const r = await runCapture("node", ["-e", "process.exit(3)"]);
  expect(r.code).toBe(3);
});
