import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

import {
  decodeWindowsTreeWorkerResponse,
  probeWindowsProcessIdentity,
  queryWindowsProcessIdentity,
  snapshotWindowsProcessesByToken,
  terminateWindowsResidual,
  terminateWindowsProcessTree,
  type BatchTarget,
} from "../../../src/process/windows-process-tree";

const root: BatchTarget = {
  pid: 100,
  creationDate: "133830000000000000",
  commandLine: "node daemon.js",
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
};

test("invalid or missing root identity fails closed without invoking the worker", async () => {
  let invoked = false;
  const result = await terminateWindowsProcessTree({ pid: 100, creationDate: null }, {
    runWorker: async () => { invoked = true; return {}; },
  });
  expect(invoked).toBe(false);
  expect(result.rootOutcome).toBe("query-failed");
});

test("accepts complete unique worker outcomes including a CIM-derived child identity", async () => {
  const result = await terminateWindowsProcessTree(root, {
    runWorker: async () => ({
      rootOutcome: "killed",
      outcomes: [
        { target: root, outcome: "killed", commandLine: root.commandLine, executablePath: root.executablePath },
        {
          target: { pid: 101, creationDate: "133830000000000009", commandLine: "agent", executablePath: "C:\\agent.exe" },
          outcome: "kill-requested-unconfirmed",
          commandLine: "agent",
          executablePath: "C:\\agent.exe",
        },
      ],
    }),
  });
  expect(result.rootOutcome).toBe("killed");
  expect(result.outcomes.map((item) => item.target.pid)).toEqual([100, 101]);
});

test("malformed, duplicate, missing-root, and inconsistent worker results fail closed", () => {
  const validRoot = { target: root, outcome: "killed" };
  expect(decodeWindowsTreeWorkerResponse({ rootOutcome: "killed", outcomes: [validRoot, validRoot] }, root)).toBeNull();
  expect(decodeWindowsTreeWorkerResponse({ rootOutcome: "killed", outcomes: [] }, root)).toBeNull();
  expect(decodeWindowsTreeWorkerResponse({ rootOutcome: "killed", outcomes: [{ ...validRoot, outcome: "unknown" }] }, root)).toBeNull();
  expect(decodeWindowsTreeWorkerResponse({ rootOutcome: "query-failed", outcomes: [validRoot] }, root)).toBeNull();
});

test("identity queries accept only handle-derived canonical fingerprints", async () => {
  const valid = await queryWindowsProcessIdentity(42, {
    runWorker: async () => ({ pid: 42, creationDate: "133830000000000000", executablePath: "C:\\node.exe" }),
  });
  expect(valid).toEqual({ pid: 42, creationDate: "133830000000000000", executablePath: "C:\\node.exe" });
  const invalid = await queryWindowsProcessIdentity(42, {
    runWorker: async () => ({ pid: 42, creationDate: "0133830000000000000", executablePath: "C:\\node.exe" }),
  });
  expect(invalid).toBeNull();
});

test("identity probes preserve missing versus unavailable", async () => {
  expect(await probeWindowsProcessIdentity(42, { runWorker: async () => ({ status: "missing" }) })).toEqual({ status: "missing" });
  expect(await probeWindowsProcessIdentity(42, { runWorker: async () => ({ status: "unavailable" }) })).toEqual({ status: "unavailable" });
  expect(await probeWindowsProcessIdentity(42, { runWorker: async () => ({
    status: "found",
    identity: { pid: 42, creationDate: "133830000000000000", executablePath: "C:\\node.exe" },
  }) })).toEqual({
    status: "found",
    identity: { pid: 42, creationDate: "133830000000000000", executablePath: "C:\\node.exe" },
  });
});

test("token snapshots and residual termination reject malformed worker responses", async () => {
  const token = "11111111-1111-4111-8111-111111111111";
  const snapshot = await snapshotWindowsProcessesByToken(token, { runWorker: async () => ({ items: [{
    pid: 42,
    creationDate: "133830000000000000",
    commandLine: `agent --xacpx-owner-token ${token}`,
    executablePath: "C:\\agent.exe",
  }] }) });
  expect(snapshot).toHaveLength(1);
  expect(await snapshotWindowsProcessesByToken("not-a-token", { runWorker: async () => { throw new Error("not invoked"); } })).toBeNull();
  expect(await snapshotWindowsProcessesByToken(token, { runWorker: async () => ({ items: [{ pid: 42 }] }) })).toBeNull();
  expect(await terminateWindowsResidual(root, { runWorker: async () => ({ outcome: "skipped-replaced" }) })).toBe("skipped-replaced");
  expect(await terminateWindowsResidual(root, { runWorker: async () => ({ outcome: "future" }) })).toBe("query-failed");
});

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("real worker rejects a replaced identity and kills a verified tree through retained handles", async () => {
  const rootProcess = spawn("node", ["-e", [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    "console.log(child.pid)",
    "setInterval(()=>{},1000)",
  ].join(";")], { stdio: ["ignore", "pipe", "pipe"] });
  const childPid = await new Promise<number>((resolvePid, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`fixture timeout: ${output}`)), 10_000);
    rootProcess.stdout.on("data", (chunk) => {
      output += String(chunk);
      const value = Number.parseInt(output.trim(), 10);
      if (Number.isSafeInteger(value) && value > 0) {
        clearTimeout(timer);
        resolvePid(value);
      }
    });
    rootProcess.once("error", reject);
  });
  const identity = await queryWindowsProcessIdentity(rootProcess.pid!);
  expect(identity).not.toBeNull();
  const mismatch = (BigInt(identity!.creationDate) + 1n).toString();
  const refused = await terminateWindowsProcessTree({ pid: rootProcess.pid!, creationDate: mismatch });
  expect(refused.rootOutcome).toBe("skipped-replaced");
  expect(() => process.kill(rootProcess.pid!, 0)).not.toThrow();

  const result = await terminateWindowsProcessTree({
    pid: rootProcess.pid!,
    creationDate: identity!.creationDate,
    executablePath: identity!.executablePath,
  });
  expect(result.rootOutcome).toBe("killed");
  expect(result.outcomes.some((item) => item.target.pid === childPid && item.outcome === "killed")).toBe(true);
  expect(() => process.kill(rootProcess.pid!, 0)).toThrow();
  expect(() => process.kill(childPid, 0)).toThrow();
}, 30_000);
