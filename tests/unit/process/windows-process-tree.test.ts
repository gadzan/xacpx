import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodeWindowsDescendantsResponse,
  decodeWindowsTreeWorkerResponse,
  probeWindowsProcessIdentity,
  queryWindowsProcessIdentity,
  snapshotWindowsProcessesByToken,
  terminateWindowsResidual,
  terminateWindowsProcessTree,
  WINDOWS_TREE_WORKER_SCRIPT,
  type BatchTarget,
  terminateWindowsDescendantsOf,
} from "../../../src/process/windows-process-tree";
import { parseCanonicalFileTime } from "../../../src/process/windows-process-identity";

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
    runWorker: async () => ({
      pid: 42,
      creationDate: "133830000000000000",
      executablePath: "C:\\node.exe",
      commandLine: '"C:\\node.exe" "C:\\xacpx\\dist\\cli.js" run',
    }),
  });
  expect(valid).toEqual({
    pid: 42,
    creationDate: "133830000000000000",
    executablePath: "C:\\node.exe",
    commandLine: '"C:\\node.exe" "C:\\xacpx\\dist\\cli.js" run',
  });
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

test("encoded Windows worker command line stays below the CreateProcess ceiling", () => {
  // `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <encoded>`
  // is 67 fixed chars plus the base64 payload. The hard ceiling is 32767 chars
  // (CreateProcessW); this asserts a slightly tighter budget so future script
  // growth fails loudly instead of silently truncating. The current payload is
  // ~29 KB so headroom is intentionally small.
  const encoded = Buffer.from(WINDOWS_TREE_WORKER_SCRIPT, "utf16le").toString("base64");
  expect(67 + encoded.length).toBeLessThan(32_500);
});

// Regression: the real worker must actually run on Windows. Piping the script
// to `powershell -Command -` let PS 5.1 drop every multi-line construct and
// return empty output, which the tree test below masked by skipping.
windowsTest("real worker resolves the current process identity", async () => {
  const probe = await probeWindowsProcessIdentity(process.pid);
  expect(probe.status).toBe("found");
  if (probe.status !== "found") return;
  expect(probe.identity.pid).toBe(process.pid);
  expect(parseCanonicalFileTime(probe.identity.creationDate)).not.toBeNull();
  expect(probe.identity.executablePath.length).toBeGreaterThan(0);
}, 15_000);

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
  let identity = await queryWindowsProcessIdentity(rootProcess.pid!);
  for (let attempt = 0; !identity && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    identity = await queryWindowsProcessIdentity(rootProcess.pid!);
  }
  if (!identity) {
    rootProcess.kill();
    console.warn("skipping real Windows tree assertion: process identity worker unavailable");
    return;
  }
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
  // Node/libuv children are bound to a kill-on-close Job, so the leaf may be
  // reaped by the parent's cascade before our retained handle reaches it.
  expect(result.outcomes.some((item) => item.target.pid === childPid && (item.outcome === "killed" || item.outcome === "already-exited"))).toBe(true);
  expect(() => process.kill(rootProcess.pid!, 0)).toThrow();
  expect(() => process.kill(childPid, 0)).toThrow();
}, 30_000);

const descendantsWorker = (
  verified: boolean,
  outcomes: Array<Record<string, unknown>>,
  leftover: Array<Record<string, unknown>> = [],
) => async (): Promise<unknown> => ({ verified, outcomes, leftover });

const descendantOutcome = (pid: number, outcome: string): Record<string, unknown> => ({
  pid,
  outcome,
  creationDate: "133830000000000000",
  commandLine: "node adapter.js",
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
});

test("descendants protocol: a fully successful payload without any parent entry decodes verified", async () => {
  // Regression: this payload has NO parent-pid entry. The tree decoder demands
  // a root entry, so reusing it here misread every successful cleanup as
  // query-failed (review round 20, Blocking).
  let requestedParentPid = 0;
  const result = await terminateWindowsDescendantsOf(4242, {
    runWorker: async (request) => {
      requestedParentPid = "parentPid" in request ? request.parentPid : 0;
      return {
        verified: true,
        outcomes: [descendantOutcome(5001, "killed"), descendantOutcome(5002, "already-exited")],
        leftover: [],
      };
    },
  });
  expect(requestedParentPid).toBe(4242);
  expect(result.verified).toBe(true);
  expect(result.outcomes.map((item) => item.pid)).toEqual([5001, 5002]);
  expect(result.outcomes[0]!.commandLine).toBe("node adapter.js");
  expect(result.leftover).toEqual([]);
});

test("descendants protocol: unsafe outcome fails closed even when the worker claims verified", async () => {
  const result = await terminateWindowsDescendantsOf(4242, {
    runWorker: descendantsWorker(true, [descendantOutcome(5001, "access-denied")]),
  });
  expect(result.verified).toBe(false);
});

test("descendants protocol: leftover processes fail closed", async () => {
  const result = await terminateWindowsDescendantsOf(4242, {
    runWorker: descendantsWorker(true, [], [{ pid: 5009, parentPid: 5001, creationDate: "133830000000000000", commandLine: "x", executablePath: "C:\\x.exe" }]),
  });
  expect(result.verified).toBe(false);
});

test("descendants protocol: parent pid among outcomes, duplicate pids, and flag mismatch fail closed", async () => {
  expect(decodeWindowsDescendantsResponse({ verified: true, outcomes: [descendantOutcome(4242, "killed")], leftover: [] }, 4242)).toBeNull();
  expect(decodeWindowsDescendantsResponse({ verified: true, outcomes: [descendantOutcome(5001, "killed"), descendantOutcome(5001, "killed")], leftover: [] }, 4242)).toBeNull();
  // Worker claims false but the evidence is all-safe: inconsistent evidence
  // must fail closed instead of trusting either signal.
  expect(decodeWindowsDescendantsResponse({ verified: false, outcomes: [descendantOutcome(5001, "killed")], leftover: [] }, 4242)).toBeNull();
  expect(decodeWindowsDescendantsResponse({ verified: true, outcomes: [], leftover: [] }, 4242)).toEqual({ verified: true, outcomes: [], leftover: [] });
});

test("descendants protocol: worker failure and malformed output are unverified", async () => {
  const rejected = await terminateWindowsDescendantsOf(4242, {
    runWorker: async () => {
      throw new Error("powershell worker died");
    },
  });
  expect(rejected.verified).toBe(false);
  const malformed = await terminateWindowsDescendantsOf(4242, {
    runWorker: async () => ({ rootOutcome: "killed", outcomes: [] }),
  });
  expect(malformed.verified).toBe(false);
  const invalidPid = await terminateWindowsDescendantsOf(0);
  expect(invalidPid.verified).toBe(false);
});

windowsTest("real worker converges a three-level descendant tree and keeps the parent alive", async () => {
  // Real-time fixture: process birth/death is platform-clock behavior; there
  // is no deterministic clock for OS process scheduling.
  const dir = await mkdtemp(join(tmpdir(), "descendants-tree-"));
  const fixture = join(dir, "fixture.cjs");
  const childPidFile = join(dir, "child.pid");
  const grandchildPidFile = join(dir, "grandchild.pid");
  await writeFile(fixture, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e',",
    "  \"const {spawn}=require('node:child_process');const fs=require('node:fs');\" +",
    "  \"const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});\" +",
    "  \"fs.writeFileSync(process.argv[1],String(g.pid));setInterval(()=>{},1000)\",",
    `  ${JSON.stringify(grandchildPidFile)}], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const rootProcess = spawn("node", [fixture], { stdio: "ignore" });
  let childPid = 0;
  let grandchildPid = 0;
  try {
    for (let i = 0; i < 200 && (!childPid || !grandchildPid); i += 1) {
      try {
        childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10) || 0;
        grandchildPid = Number.parseInt(await readFile(grandchildPidFile, "utf8"), 10) || 0;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(childPid).toBeGreaterThan(0);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(() => process.kill(rootProcess.pid!, 0)).not.toThrow();
    expect(() => process.kill(childPid, 0)).not.toThrow();
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    const result = await terminateWindowsDescendantsOf(rootProcess.pid!);
    expect(result.verified).toBe(true);
    expect(() => process.kill(rootProcess.pid!, 0)).not.toThrow();
    let childGone = false;
    let grandchildGone = false;
    for (let i = 0; i < 200 && (!childGone || !grandchildGone); i += 1) {
      try { process.kill(childPid, 0); } catch { childGone = true; }
      try { process.kill(grandchildPid, 0); } catch { grandchildGone = true; }
      if (!childGone || !grandchildGone) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(childGone).toBe(true);
    expect(grandchildGone).toBe(true);
  } finally {
    try { if (childPid) process.kill(childPid, "SIGKILL"); } catch {}
    try { if (grandchildPid) process.kill(grandchildPid, "SIGKILL"); } catch {}
    try { process.kill(rootProcess.pid!, "SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 40_000);
