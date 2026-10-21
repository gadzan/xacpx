import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { queryJobAttestation, queryWindowsJob, queryJobMembership } from "../../../src/process/windows-job-query";
import { probeWindowsProcessIdentity } from "../../../src/process/windows-process-tree";

const windowsTest = process.platform === "win32" ? test : test.skip;

windowsTest("empty, populated and destroyed Jobs have distinct containment", { timeout: 45_000 }, async () => {
  const jobName = `Local\\Xacpx-RW-${randomUUID()}`;
  const script = String.raw`
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Holder {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a,string n);
[DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr h,IntPtr p);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h=[Holder]::CreateJobObject([IntPtr]::Zero,$env:XACPX_TEST_JOB)
[Console]::Out.WriteLine('ready')
[Console]::In.ReadLine() | Out-Null
if(-not [Holder]::AssignProcessToJobObject($h,[Holder]::GetCurrentProcess())){throw 'self assignment failed'}
[Console]::Out.WriteLine('joined')
[Console]::In.ReadLine() | Out-Null
[void][Holder]::CloseHandle($h)
`;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, XACPX_TEST_JOB: jobName }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  child.stdout.once("data", () => ready.resolve());
  child.once("error", ready.reject);
  child.once("close", () => { closed.resolve(); ready.reject(new Error("Job holder closed before readiness")); });
  try {
    await ready.promise;
    expect(await queryWindowsJob(jobName)).toEqual({ status: "empty" });
    expect(await queryJobMembership(jobName, [process.pid])).toEqual([{ pid: process.pid, inJob: false, verifiable: true }]);
    const joined = Promise.withResolvers<void>();
    child.stdout.once("data", () => joined.resolve());
    child.stdin.write("\n");
    await joined.promise;
    expect(await queryWindowsJob(jobName)).toEqual({ status: "active", activeProcesses: 1, processIds: [] });
    expect(await queryJobMembership(jobName, [child.pid!])).toEqual([{ pid: child.pid!, inJob: true, verifiable: true }]);
    child.stdin.end("\n");
    await closed.promise;
    expect(await queryWindowsJob(jobName)).toEqual({ status: "absent" });
  } finally {
    child.kill();
    await closed.promise;
  }
});
windowsTest("attestation reads Job membership and the handle birth in one transaction", { timeout: 60_000 }, async () => {
  const jobName = `Local\\Xacpx-RW-${randomUUID()}`;
  const script = String.raw`
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class Holder {
[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a,string n);
[DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr h,IntPtr p);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$h=[Holder]::CreateJobObject([IntPtr]::Zero,$env:XACPX_TEST_JOB)
[Console]::Out.WriteLine('ready')
[Console]::In.ReadLine() | Out-Null
if(-not [Holder]::AssignProcessToJobObject($h,[Holder]::GetCurrentProcess())){throw 'self assignment failed'}
[Console]::Out.WriteLine('joined')
[Console]::In.ReadLine() | Out-Null
[void][Holder]::CloseHandle($h)
`;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, XACPX_TEST_JOB: jobName }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  child.stdout.once("data", () => ready.resolve());
  child.once("error", ready.reject);
  child.once("close", () => { closed.resolve(); ready.reject(new Error("Job holder closed before readiness")); });
  try {
    await ready.promise;
    const before = await queryJobAttestation(jobName, [process.pid]);
    expect(before).toHaveLength(1);
    expect(before![0]).toMatchObject({ pid: process.pid, inJob: false, verifiable: true, status: "found" });
    // Birth must be the same kernel FILETIME the identity probe reads.
    const probed = await probeWindowsProcessIdentity(process.pid, { workerDeadlineMs: 30_000 });
    expect(probed.status).toBe("found");
    if (probed.status === "found") expect(before![0]!.creationDate).toBe(probed.identity.creationDate);
    const joined = Promise.withResolvers<void>();
    child.stdout.once("data", () => joined.resolve());
    child.stdin.write("\n");
    await joined.promise;
    const after = await queryJobAttestation(jobName, [child.pid!]);
    expect(after).toEqual([{ pid: child.pid!, inJob: true, verifiable: true, status: "found", creationDate: expect.any(String) }]);
  } finally {
    child.kill();
    await closed.promise;
  }
});

windowsTest("attestation refuses an absent Job and never decodes a missing pid as attested", { timeout: 60_000 }, async () => {
  // A Job that was never created cannot attest membership: absence must fail
  // closed, never become "not contained, therefore admitted".
  expect(await queryJobAttestation(`Local\\Xacpx-RW-${randomUUID()}`, [process.pid])).toBeNull();
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const deadPid = dead.pid!;
  await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
  expect(await queryJobAttestation(`Local\\Xacpx-RW-${randomUUID()}`, [deadPid])).toBeNull();
});

test("attestation decodes only a complete found readback and fails closed otherwise", async () => {
  const missing = { pid: 42, inJob: false, verifiable: false, status: "missing" as const, reason: "OpenProcess failed with code 87" };
  expect(await queryJobAttestation("job", [42], { runWorker: async () => ({ status: "attest", results: [missing] }) })).toEqual([missing]);
  expect(await queryJobAttestation("job", [42], { runWorker: async () => ({ status: "attest", results: [{ pid: 42, inJob: true, verifiable: true, status: "found", creationDate: "not-ticks" }] }) })).toBeNull();
  expect(await queryJobAttestation("job", [42], { runWorker: async () => ({ status: "contains", results: [] }) })).toBeNull();
  expect(await queryJobAttestation("job", [42], { runWorker: async () => { throw new Error("denied"); } })).toBeNull();
  expect(await queryJobAttestation("job", [42], { runWorker: async () => ({ status: "attest", results: [] }) })).toBeNull();
});

test("an unavailable or malformed native query never becomes empty containment", async () => {
  expect(await queryWindowsJob("job", { runWorker: async () => { throw new Error("denied"); } })).toEqual({ status: "unknown", reason: "denied" });
  expect(await queryWindowsJob("job", { runWorker: async () => ({ status: "active", activeProcesses: -1 }) })).toEqual({ status: "unknown", reason: "malformed job query response" });
});
