import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";

import {
  isProcessAlive,
  resolveDaemonPaths,
  resolveRuntimeConsumerLockPath,
} from "../../../src/daemon/daemon-files";

function killError(code: string): NodeJS.ErrnoException {
  const error = new Error(`kill failed: ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("resolves runtime files under ~/.xacpx/runtime by default", () => {
  expect(
    resolveDaemonPaths({
      home: "/Users/tester",
    }),
  ).toEqual({
    runtimeDir: join("/Users/tester", ".xacpx", "runtime"),
    pidFile: join("/Users/tester", ".xacpx", "runtime", "daemon.pid"),
    statusFile: join("/Users/tester", ".xacpx", "runtime", "status.json"),
    stdoutLog: join("/Users/tester", ".xacpx", "runtime", "stdout.log"),
    stderrLog: join("/Users/tester", ".xacpx", "runtime", "stderr.log"),
    appLog: join("/Users/tester", ".xacpx", "runtime", "app.log"),
  });
});

test("allows overriding the runtime directory", () => {
  expect(
    resolveDaemonPaths({
      home: "/Users/tester",
      runtimeDir: "/tmp/weacpx-runtime",
    }),
  ).toEqual({
    runtimeDir: "/tmp/weacpx-runtime",
    pidFile: join("/tmp/weacpx-runtime", "daemon.pid"),
    statusFile: join("/tmp/weacpx-runtime", "status.json"),
    stdoutLog: join("/tmp/weacpx-runtime", "stdout.log"),
    stderrLog: join("/tmp/weacpx-runtime", "stderr.log"),
    appLog: join("/tmp/weacpx-runtime", "app.log"),
  });
});

test("centralizes the stable core runtime lock metadata path", () => {
  expect(resolveRuntimeConsumerLockPath("/tmp/xacpx-runtime")).toBe(
    join("/tmp/xacpx-runtime", "runtime-consumer.lock.json"),
  );
});

test("isProcessAlive reports the current process as alive", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
});

test("isProcessAlive treats ESRCH (no such process) as dead", () => {
  const spy = spyOn(process, "kill").mockImplementation(() => {
    throw killError("ESRCH");
  });
  try {
    expect(isProcessAlive(99999)).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test("isProcessAlive treats EPERM (exists, signal denied) as ALIVE", () => {
  // EPERM means the process exists but is owned by another user. Doctor gates
  // state-mutating repairs on liveness, so an existing process must never read
  // as dead.
  const spy = spyOn(process, "kill").mockImplementation(() => {
    throw killError("EPERM");
  });
  try {
    expect(isProcessAlive(1)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
