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
    const result = await terminateWindowsDescendantsOf(rootProcess.pid!, { workerDeadlineMs: 45_000 });
    expect(result.verified).toBe(true);
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
  expect(WINDOWS_TREE_WORKER_SCRIPT.includes(seed)).toBe(true);
  expect(WINDOWS_TREE_WORKER_SCRIPT.includes(leakySeed)).toBe(false);
});
