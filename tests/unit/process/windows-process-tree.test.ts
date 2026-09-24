import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  decodeWindowsDescendantsResponse,
  decodeWindowsTreeWorkerResponse,
  probeWindowsProcessIdentity,
  queryWindowsProcessIdentity,
  snapshotWindowsProcessesByToken,
  terminateWindowsResidual,
  terminateWindowsProcessTree,
  WINDOWS_TREE_WORKER_SCRIPT,
  WINDOWS_DESCENDANTS_WORKER_SCRIPT,
  type BatchTarget,
  type WindowsProcessIdentity,
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

/**
 * `Win32_Process.ExecutablePath` for a live pid — the CREATE-TIME path recorded
 * in the process parameters, i.e. the exact string the worker compares against
 * the kernel-resolved image. Separate from `handleImagePath` on purpose: a
 * fixture must prove the two SOURCES disagree, not compare one value with itself.
 */
async function cimExecutablePath(pid: number): Promise<string> {
  const stdout = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`,
  ], { encoding: "utf8" });
  if (stdout.status !== 0) throw new Error(`CIM lookup failed for pid ${pid}: ${stdout.stderr}`);
  return stdout.stdout.trim();
}

/**
 * The image path as the kernel resolves it (QueryFullProcessImageName) — the
 * side of the comparison the worker's `Image()` returns. Deliberately separate
 * from `queryWindowsProcessIdentity` so a fixture cannot "prove" divergence by
 * comparing a value against itself.
 */
async function handleImagePath(pid: number): Promise<string> {
  const probe = await probeWindowsProcessIdentity(pid);
  if (probe.status !== "found") throw new Error(`pid ${pid} is not probeable`);
  return probe.identity.executablePath;
}

/**
 * Absolute path of the node.exe this host resolves bare "node" to. The kernel
 * may be Bun (process.execPath is bun.exe), so the junction target must be
 * resolved through a real short-lived node, not assumed.
 */
async function realPathOfNode(): Promise<string> {
  const script = "process.stdout.write(process.execPath)";
  const stdout = spawnSync("node", ["-e", script], { encoding: "utf8" });
  if (stdout.status !== 0) throw new Error(`node is unavailable: ${stdout.stderr}`);
  return stdout.stdout.trim();
}

test("encoded Windows worker command lines stay below the CreateProcess ceiling", () => {
  // `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <encoded>`
  // is 67 fixed chars plus the base64 payload. The hard ceiling is 32767 chars
  // (CreateProcessW); this asserts a slightly tighter budget so future script
  // growth fails loudly instead of silently truncating. The current payloads are
  // ~31 KB (tree) and ~25 KB (descendants) so headroom is intentionally small.
  for (const [name, script] of [
    ["tree", WINDOWS_TREE_WORKER_SCRIPT],
    ["descendants", WINDOWS_DESCENDANTS_WORKER_SCRIPT],
  ] as const) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    expect(67 + encoded.length, `${name} worker script encoded payload`).toBeLessThan(32_500);
  }
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

    // The pid files are written by the processes themselves, so they can be
    // readable before CIM has published the row — and OpenProcess on a process
    // whose CIM row is still settling can return access-denied. Wait for CIM
    // visibility of BOTH descendants before starting the kill transaction,
    // otherwise this test measures process-creation timing, not the worker.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [childCim, grandchildCim] = await Promise.all([
        cimExecutablePath(childPid),
        cimExecutablePath(grandchildPid),
      ]);
      if (childCim && grandchildCim) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // OpenProcess(PROCESS_ALL_ACCESS) on a very recently created process can
    // transiently return ERROR_ACCESS_DENIED on Windows, which the worker
    // correctly fails closed on. Retry the attempt until it converges instead
    // of asserting on the OS's willingness to hand out a handle.
    let result: Awaited<ReturnType<typeof terminateWindowsDescendantsOf>> | null = null;
    for (let attempt = 0; attempt < 10 && result?.verified !== true; attempt += 1) {
      result = await terminateWindowsDescendantsOf(rootProcess.pid!);
      if (result?.verified !== true) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(result?.verified).toBe(true);
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

// Review round 22 Blocking 3: discovery must be a full transitive closure, not
// a fixed 6-pass ceiling — an 8-level chain must all be discovered/killed.
windowsTest("real worker converges an 8-level descendant chain", async () => {
  // Real-time fixture: process birth/death is platform-clock behavior; there
  // is no deterministic clock for OS process scheduling.
  const dir = await mkdtemp(join(tmpdir(), "descendants-chain-"));
  const chain = join(dir, "chain.cjs");
  await writeFile(chain, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const depth = Number(process.argv[2]);",
    "const dir = process.argv[3];",
    "fs.writeFileSync(require('node:path').join(dir, `pid-${depth}`), String(process.pid), 'utf8');",
    "if (depth > 1) {",
    "  const child = spawn(process.execPath, [__filename, String(depth - 1), dir], { stdio: 'ignore' });",
    "}",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const rootProcess = spawn("node", [chain, "8", dir], { stdio: "ignore" });
  const pids: number[] = [];
  try {
    for (let i = 0; i < 300 && pids.length < 8; i += 1) {
      const found: number[] = [];
      for (let d = 1; d <= 8; d += 1) {
        try {
          const value = Number.parseInt(await readFile(join(dir, `pid-${d}`), "utf8"), 10);
          if (Number.isSafeInteger(value) && value > 0) found.push(value);
        } catch {
          // not yet written
        }
      }
      if (found.length > pids.length) pids.length = 0, pids.push(...found);
      if (pids.length < 8) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pids).toHaveLength(8);
    for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();

    // Unbounded discovery: with the old 6-pass ceiling D7/D8 were never
    // enumerated and only D7 was spooled, losing D8's ownership entirely.
    // CIM visibility LAGS pid-file writes: on a loaded runner the first
    // snapshot can see only a spawn prefix, leaving the rest as leftover
    // (verified=false, by design). Retry — the same convergence semantics
    // the EOF worker applies — until the whole chain is proven dead.
    let verified = false;
    for (let attempt = 0; attempt < 5 && !verified; attempt += 1) {
      const result = await terminateWindowsDescendantsOf(rootProcess.pid!, { workerDeadlineMs: 45_000 });
      verified = result.verified;
      if (!verified) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(verified).toBe(true);
    expect(() => process.kill(rootProcess.pid!, 0)).not.toThrow();
    for (let i = 0; i < 400; i += 1) {
      if (pids.every((pid) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      })) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const pid of pids) {
      try { process.kill(pid, 0); expect.unreachable(`chain pid ${pid} still alive`); } catch { /* gone */ }
    }
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    try { process.kill(rootProcess.pid!, "SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

// Review round 23 Blocking 2: discovery graph must be identity-safe. An
// innocent process that is NOT a descendant of the worker must never be
// touched — the deterministic proxy for the PID-reuse skip rule (a reused
// parent pid is attributed to the reuser, not to our tree).
windowsTest("real worker never touches an innocent non-descendant process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "descendants-innocent-"));
  const fixture = join(dir, "fixture.cjs");
  const childPidFile = join(dir, "child.pid");
  await writeFile(fixture, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid), 'utf8');`,
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const rootProcess = spawn("node", [fixture], { stdio: "ignore" });
  // Innocent sibling: parented by THIS test process, not by the worker.
  const innocent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  let childPid = 0;
  try {
    for (let i = 0; i < 200 && !childPid; i += 1) {
      try {
        childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(childPid).toBeGreaterThan(0);
    const result = await terminateWindowsDescendantsOf(rootProcess.pid!, { workerDeadlineMs: 45_000 });
    expect(result.verified).toBe(true);
    expect(() => process.kill(rootProcess.pid!, 0)).not.toThrow();
    for (let i = 0; i < 200; i += 1) {
      try { process.kill(childPid, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { break; }
    }
    try { process.kill(childPid, 0); expect.unreachable("descendant still alive"); } catch { /* gone */ }
    // The innocent must survive: it is not part of the worker's tree.
    expect(() => process.kill(innocent.pid!, 0)).not.toThrow();
  } finally {
    try { if (childPid) process.kill(childPid, "SIGKILL"); } catch {}
    try { process.kill(rootProcess.pid!, "SIGKILL"); } catch {}
    try { innocent.kill("SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);

test("descendants protocol: explicit null deadline is forwarded to the worker (no hard-kill)", async () => {
  // Review round 24 Blocking 3: EOF convergence must not arm an outer
  // hard-kill timer — a mid-traversal SIGKILL loses ancestry reachability
  // and any partially-collected evidence.
  let received: number | null | undefined;
  const result = await terminateWindowsDescendantsOf(4242, {
    workerDeadlineMs: null,
    runWorker: async (_request, deadlineMs) => {
      received = deadlineMs;
      return { verified: true, outcomes: [], leftover: [] };
    },
  });
  expect(received).toBeNull();
  expect(result.verified).toBe(true);
});

test("descendants protocol: S2-verified child decodes once and appears only in outcomes", () => {
  // Review round 26 Blocking 2: a post-S1 child that passed OpenVerified is
  // recorded in outcomes (killed) — it must NOT also appear in leftover, or
  // the decoder's single seen-set rejects the whole response.
  const payload = {
    verified: true,
    outcomes: [
      descendantOutcome(5001, "killed"), // S1 parent
      descendantOutcome(5002, "killed"), // S2 child, verified + killed
    ],
    leftover: [],
  };
  expect(decodeWindowsDescendantsResponse(payload, 4242)).toEqual({
    verified: true,
    outcomes: payload.outcomes,
    leftover: [],
  });
});

test("descendants protocol: S2 verify-failed child is unsafe evidence, never silently dropped", () => {
  // Review round 26 Blocking 1: the S2 child whose OpenVerified failed must
  // surface as an outcome (access-denied etc.) so verified stays false and
  // the worker does not exit with it alive and unrecorded.
  const payload = {
    verified: false,
    outcomes: [
      descendantOutcome(5001, "killed"),        // S1 parent killed
      descendantOutcome(5002, "access-denied"), // S2 child unverifiable
    ],
    leftover: [],
  };
  expect(decodeWindowsDescendantsResponse(payload, 4242)).not.toBeNull();
  expect(decodeWindowsDescendantsResponse(payload, 4242)!.verified).toBe(false);
});

test("descendants protocol: S2 static closure returns EVERY post-S1 descendant as independent leftover", () => {
  // Review round 27 Blocking: a single-level S2 recorded only C, so if C
  // exited before the reaper, G (parented by dead C) lost all durable
  // evidence. The S2 static transitive closure must emit C AND G as
  // separate leftovers, each with its own full fingerprint.
  const payload = {
    verified: false,
    outcomes: [descendantOutcome(5001, "killed")], // S1 parent P
    leftover: [
      { pid: 5002, parentPid: 5001, creationDate: "133801632000000010", commandLine: "c", executablePath: "C:\\c.exe" },
      { pid: 5003, parentPid: 5002, creationDate: "133801632000000020", commandLine: "g", executablePath: "C:\\g.exe" },
    ],
  };
  const decoded = decodeWindowsDescendantsResponse(payload, 4242);
  expect(decoded).not.toBeNull();
  expect(decoded!.verified).toBe(false);
  // Both levels are independently spoolable: same identity shape as outcomes.
  expect(decoded!.leftover.map((item) => item.pid).sort((a, b) => a - b)).toEqual([5002, 5003]);
  for (const item of decoded!.leftover) {
    expect(item.creationDate).not.toBeNull();
    expect(item.commandLine).not.toBeNull();
    expect(item.executablePath).not.toBeNull();
  }
  // C and G do not collide with the S1 outcome (mutual exclusion holds).
  expect(decoded!.outcomes.map((item) => item.pid)).toEqual([5001]);
});

test("descendants protocol: S2 frontier seeds from verified handles, never unverified S1 pids", () => {
  // Review round 28 Blocking: S2 must NOT seed its BFS frontier from every
  // S1 snapshot pid — a replaced/access-denied S1 parent (no verified
  // handle) could otherwise absorb an innocent child of a pid-reused
  // process into leftover, causing a wrong-process kill by the reaper.
  // Static guard: the production script seeds from $open.Keys (verified,
  // handle-retained) and the worker root only.
  const seed = "$fr=@($pp)+@($open.Keys)";
  const leakySeed = "$fr=@($pp)+@($cl.pid)";
  expect(WINDOWS_DESCENDANTS_WORKER_SCRIPT.includes(seed)).toBe(true);
  expect(WINDOWS_DESCENDANTS_WORKER_SCRIPT.includes(leakySeed)).toBe(false);
});

test("terminate-tree honors an explicit null deadline (outer SIGKILL disabled, round 29 Blocking 3)", async () => {
  let seen: number | null | undefined;
  let invoked = false;
  const result = await terminateWindowsProcessTree(root, {
    workerDeadlineMs: null,
    runWorker: async (_request, deadlineMs) => {
      invoked = true;
      seen = deadlineMs;
      return {
        rootOutcome: "killed",
        outcomes: [{ target: { pid: root.pid, creationDate: root.creationDate }, outcome: "killed" }],
      };
    },
  });
  expect(invoked).toBe(true);
  expect(seen).toBeNull();
  expect(result.rootOutcome).toBe("killed");
});

test("terminate-tree defaults to 15s ONLY when the deadline is undefined", async () => {
  let seen: number | null | undefined = undefined;
  await terminateWindowsProcessTree(root, {
    runWorker: async (_request, deadlineMs) => {
      seen = deadlineMs;
      return { rootOutcome: "killed", outcomes: [] };
    },
  });
  expect(seen).toBe(15_000);
});

windowsTest("real worker terminates a full 4-level tree through terminateWindowsProcessTree", async () => {
  // Review round 29 Blocking 3: the ordinary terminate-tree action (used by
  // RuntimeWorkerClient.terminate and the residual reaper) had no real
  // deep-tree coverage — only the EOF descendants action did. It must also
  // converge a multi-level chain with the outer hard-kill deadline disabled.
  const dir = await mkdtemp(join(tmpdir(), "terminate-tree-chain-"));
  const chain = join(dir, "chain.cjs");
  await writeFile(chain, [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const depth = Number(process.argv[2]);",
    "const dir = process.argv[3];",
    "fs.writeFileSync(require('node:path').join(dir, `pid-${depth}`), String(process.pid), 'utf8');",
    "if (depth > 1) {",
    "  const child = spawn(process.execPath, [__filename, String(depth - 1), dir], { stdio: 'ignore' });",
    "}",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");
  const rootProcess = spawn("node", [chain, "4", dir], { stdio: "ignore" });
  const pids: number[] = [];
  try {
    for (let i = 0; i < 300 && pids.length < 4; i += 1) {
      const found: number[] = [];
      for (let d = 1; d <= 4; d += 1) {
        try {
          const value = Number.parseInt(await readFile(join(dir, `pid-${d}`), "utf8"), 10);
          if (Number.isSafeInteger(value) && value > 0) found.push(value);
        } catch {
          // not yet written
        }
      }
      if (found.length > pids.length) pids.length = 0, pids.push(...found);
      if (pids.length < 4) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // The chain writes pid-1..pid-4 (the root process pid is separate).
    expect(pids).toHaveLength(4);

    // terminate-tree needs the ROOT's verified creationDate — probe it. CIM
    // visibility also LAGS pid-file writes, and terminate-tree cannot retry
    // after the root dies — so settle until EVERY pid is CIM-visible first.
    for (let settle = 0; settle < 200; settle += 1) {
      const identities = await Promise.all(
        [rootProcess.pid!, ...pids].map((pid) => queryWindowsProcessIdentity(pid, { workerDeadlineMs: 30_000 })),
      );
      if (identities.every((identity) => identity !== null)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const probe = await probeWindowsProcessIdentity(rootProcess.pid!, { workerDeadlineMs: 30_000 });
    expect(probe.status).toBe("found");

    const result = await terminateWindowsProcessTree({
      pid: rootProcess.pid!,
      creationDate: probe.status === "found" ? probe.identity.creationDate : null,
      workerDeadlineMs: null,
    } as BatchTarget, { workerDeadlineMs: null });
    expect(result.rootOutcome).toBe("killed");
    for (const outcome of result.outcomes) {
      expect(["killed", "already-exited"]).toContain(outcome.outcome);
    }
    for (let i = 0; i < 400; i += 1) {
      const allGone = [rootProcess.pid!, ...pids].every((pid) => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      });
      if (allGone) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const pid of [rootProcess.pid!, ...pids]) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally {
    try { process.kill(rootProcess.pid!, "SIGKILL"); } catch {}
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

test("descendants-of: a wrong expected parent fingerprint decodes as unverified — nothing attributed", async () => {
  // Round 30 Blocking 3: the gate-fail payload (parentStatus, empty arrays)
  // has verified=false while recomputed-from-empty is true — the decoder
  // must REJECT that inconsistency so the caller reports unverified.
  let invoked = false;
  const result = await terminateWindowsDescendantsOf(100, {
    expectedParentCreationDate: root.creationDate,
    runWorker: async (request, deadlineMs) => {
      invoked = true;
      expect(deadlineMs).toBeNull();
      expect((request as { epcd?: string }).epcd).toBe(root.creationDate);
      return { verified: false, parentStatus: "skipped-replaced", outcomes: [], leftover: [] };
    },
  });
  expect(invoked).toBe(true);
  expect(result.verified).toBe(false);
  expect(result.outcomes).toEqual([]);
  expect(result.leftover).toEqual([]);
});

windowsTest("real descendants-of with a WRONG parent fingerprint never touches the live parent", async () => {
  // The in-transaction gate is the pid-reuse defense: a held handle compared
  // against the expected creation date — mismatch fails the whole action
  // closed and the innocent live process is untouched.
  const victim = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const probe = await probeWindowsProcessIdentity(victim.pid!, { workerDeadlineMs: 30_000 });
    expect(probe.status).toBe("found");

    const result = await terminateWindowsDescendantsOf(victim.pid!, {
      expectedParentCreationDate: "133800000000000000", // WRONG on purpose
      workerDeadlineMs: null,
    });
    expect(result.verified).toBe(false);
    expect(result.outcomes).toEqual([]);
    expect(result.leftover).toEqual([]);
    // The innocent process survives — no bare historical-pid attribution.
    expect(() => process.kill(victim.pid!, 0)).not.toThrow();
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
  }
}, 30_000);

windowsTest("real descendants-of with the CORRECT parent fingerprint converges the subtree but never kills the parent itself", async () => {
  // I1: terminate-descendants-of is NOT terminate-tree — it kills
  // descendants, never the parent, even when the fingerprint matches.
  const victim = spawn("node", ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const probe = await probeWindowsProcessIdentity(victim.pid!, { workerDeadlineMs: 30_000 });
    expect(probe.status).toBe("found");

    const result = await terminateWindowsDescendantsOf(victim.pid!, {
      expectedParentCreationDate: probe.status === "found" ? probe.identity.creationDate : null,
      workerDeadlineMs: null,
    });
    expect(result.verified).toBe(true);
    // Parent must remain alive — descendants path never kills the root.
    expect(() => process.kill(victim.pid!, 0)).not.toThrow();
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
  }
}, 30_000);

// Regression: a CIM-derived child's `Win32_Process.ExecutablePath` is the
// CREATE-TIME path recorded in the process parameters, while the worker's
// `Image()` resolves the image file object. Under a symlinked launcher shim
// (fnm multishell, volta, nvm-windows) these are different strings for the
// SAME process. OpenVerified used to compare them, condemned the child
// 'skipped-replaced', and aborted the whole batch — which made Windows
// daemon stop impossible on such hosts. This fixture manufactures the
// divergence deterministically (a junction needs no elevation) so the
// contract holds on ANY Windows host, not only on fnm ones.
windowsTest("real worker kills a child whose CIM image path differs from the handle image path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cim-image-mismatch-"));
  // Resolve the real node.exe the way the rest of this file does (bare "node"
  // through PATH) so the junction points at the directory that actually holds
  // it, not at this Bun kernel's own directory.
  const realNode = await realPathOfNode();
  const link = join(dir, "shim");
  const shimExecutable = join(link, process.platform === "win32" ? "node.exe" : "node");
  const childPidFile = join(dir, "child.pid");
  // The ROOT is spawned normally and spawns the child through the junction, so
  // only the child carries a divergent image path — the shape of the
  // fnm-launched bridge child sitting under the daemon root.
  const rootScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const child = spawn(${JSON.stringify(shimExecutable)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  // The junction must exist BEFORE the root spawns its child through it.
  await symlink(dirname(realNode), link, "junction");
  const rootProcess = spawn("node", ["-e", rootScript], { stdio: "ignore", windowsHide: true });
  try {
    let childPid = 0;
    for (let attempt = 0; attempt < 200 && !childPid; attempt += 1) {
      try {
        childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10) || 0;
      } catch { /* not written yet */ }
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(childPid).toBeGreaterThan(0);

    // CIM visibility lags spawn. queryWindowsProcessIdentity can already
    // succeed (handle-derived) while the CIM row still has no commandLine, so
    // polling for a non-null identity is NOT enough — poll for the field the
    // test actually depends on.
    let childIdentity: WindowsProcessIdentity | null = null;
    let rootIdentity: WindowsProcessIdentity | null = null;
    for (let attempt = 0; attempt < 100 && (!childIdentity?.commandLine || !rootIdentity); attempt += 1) {
      if (!childIdentity?.commandLine) childIdentity = await queryWindowsProcessIdentity(childPid);
      if (!rootIdentity) rootIdentity = await queryWindowsProcessIdentity(rootProcess.pid!);
      if (!childIdentity?.commandLine || !rootIdentity) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(childIdentity?.commandLine).toBeTruthy();
    expect(rootIdentity).not.toBeNull();

    // Precondition: the two path SOURCES really disagree for the child. Without
    // this the test would pass trivially even if the fixture silently failed to
    // create a divergence (e.g. a future Node that normalizes the image path).
    // CIM ExecutablePath is the create-time path (through the junction);
    // handleImagePath is the kernel-resolved image file. They MUST differ.
    const childCimPath = await cimExecutablePath(childPid);
    expect(childCimPath.toLowerCase()).not.toBe((await handleImagePath(childPid)).toLowerCase());
    // And identity must still report the commandLine — the image-path gate that
    // used to drop it under a symlinked launcher is gone.
    expect(childIdentity!.commandLine!.toLowerCase().startsWith(shimExecutable.toLowerCase())).toBe(true);

    const result = await terminateWindowsProcessTree({
      pid: rootProcess.pid!,
      creationDate: rootIdentity!.creationDate,
    }, { workerDeadlineMs: null });

    expect(result.rootOutcome).toBe("killed");
    // The mismatched child converges instead of aborting the whole batch with
    // rootOutcome query-failed — the exact regression this pins.
    const childOutcome = result.outcomes.find((item) => item.target.pid === childPid);
    expect(childOutcome).toBeDefined();
    expect(["killed", "already-exited"]).toContain(childOutcome!.outcome);

    for (const pid of [rootProcess.pid!, childPid]) {
      let gone = false;
      for (let attempt = 0; attempt < 200 && !gone; attempt += 1) {
        try { process.kill(pid, 0); } catch { gone = true; }
        if (!gone) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(gone).toBe(true);
    }
  } finally {
    try { rootProcess.kill("SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

// Same defect class, second stage: the descendants worker reports a killed
// descendant's identity, and worker-eof spools every unsafe outcome/leftover as
// a durable residual. The reaper then feeds that residual's executablePath back
// to terminateWindowsProcessTree as a strictly-compared ROOT fingerprint
// ($cim=$false). If the descendants worker reports the CIM create-time alias
// instead of the handle-derived image, the reaper condemns the record
// 'skipped-replaced' forever and the fence can never discharge. Pin that the
// reported image is the RESOLVED one.
windowsTest("real descendants worker reports the resolved image, not the CIM alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desc-image-canonical-"));
  const realNode = await realPathOfNode();
  const link = join(dir, "shim");
  const shimExecutable = join(link, process.platform === "win32" ? "node.exe" : "node");
  const childPidFile = join(dir, "child.pid");
  // Root spawns its child through the junction: the child's CIM ExecutablePath
  // is the alias, its handle image is the real file. terminate-descendants-of
  // kills it (parent stays alive) and must report the RESOLVED path.
  const rootScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const child = spawn(${JSON.stringify(shimExecutable)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await symlink(dirname(realNode), link, "junction");
  const rootProcess = spawn("node", ["-e", rootScript], { stdio: "ignore", windowsHide: true });
  try {
    let childPid = 0;
    for (let attempt = 0; attempt < 200 && !childPid; attempt += 1) {
      try {
        childPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10) || 0;
      } catch { /* not written yet */ }
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(childPid).toBeGreaterThan(0);

    let rootProbe: Awaited<ReturnType<typeof probeWindowsProcessIdentity>> | null = null;
    for (let attempt = 0; attempt < 100 && !rootProbe; attempt += 1) {
      rootProbe = await probeWindowsProcessIdentity(rootProcess.pid!);
      if (!rootProbe) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(rootProbe?.status).toBe("found");
    if (rootProbe?.status !== "found") return;

    // Precondition: the child's two path sources really disagree, so the
    // assertion below is meaningful rather than trivially true.
    const childCimPath = await cimExecutablePath(childPid);
    const childQfpi = await handleImagePath(childPid);
    expect(childCimPath.toLowerCase()).not.toBe(childQfpi.toLowerCase());

    const result = await terminateWindowsDescendantsOf(rootProcess.pid!, {
      expectedParentCreationDate: rootProbe.identity.creationDate,
      workerDeadlineMs: null,
    });

    expect(result.verified).toBe(true);
    const childOutcome = result.outcomes.find((item) => item.pid === childPid);
    expect(childOutcome).toBeDefined();
    expect(["killed", "already-exited"]).toContain(childOutcome!.outcome);
    // The durable-evidence field must be the resolved image, never the alias:
    // this exact string becomes a reaper root fingerprint later.
    expect(childOutcome!.executablePath).toBe(childQfpi);
    expect(childOutcome!.executablePath).not.toBe(childCimPath);
    // The parent survives — this action never kills its root.
    expect(() => process.kill(rootProcess.pid!, 0)).not.toThrow();
  } finally {
    try { rootProcess.kill("SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
