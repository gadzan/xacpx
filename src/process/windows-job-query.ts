import { spawn } from "node:child_process";
import { parseCanonicalFileTime } from "./windows-process-identity";

/**
 * Transient Windows Job Object query. A recover caller MUST close the query
 * handle before any wait: a held query handle is a persistent Job handle and
 * suppresses KILL_ON_JOB_CLOSE. Every query opens, reads, closes — never holds.
 */
export type WindowsJobQueryResult =
  | { status: "active"; activeProcesses: number; processIds: number[] }
  | { status: "empty" }
  | { status: "absent" }
  | { status: "unknown"; reason: string };
export type JobQueryRequest =
  | { jobName: string; action?: "query" | "contains"; pids?: number[] }
  | { jobName: string; action: "attest"; pids: number[] };

export interface WindowsJobQueryRunWorkerOptions {
  runWorker?: (request: JobQueryRequest, deadlineMs: number) => Promise<unknown>;
  workerDeadlineMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_JOB_QUERY_DEADLINE_MS = 20_000;

export function windowsJobNameForGeneration(generation: string): string | null {
  if (!UUID.test(generation)) return null;
  return `Local\\Xacpx-RW-${generation}`;
}

export const WINDOWS_JOB_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:XACPX_JOB_REQUEST)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XacpxJobQuery {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public ulong TotalUserTime; public ulong TotalKernelTime;
    public ulong ThisPeriodTotalUserTime; public ulong ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool QueryInformationJobObject(IntPtr h, int cls, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int size, out int returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetProcessTimes(IntPtr h, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool IsProcessInJob(IntPtr proc, IntPtr h, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  public static int LastError() { return Marshal.GetLastWin32Error(); }
}
'@
function Emit($status, $extra) { $out = @{status=$status}; if($extra){foreach($k in $extra.Keys){$out[$k]=$extra[$k]}}; Write-Output ($out | ConvertTo-Json -Depth 4 -Compress); exit 0 }
$handle = [XacpxJobQuery]::OpenJobObject(0x0004, $false, [string]$request.jobName)
if ($handle -eq [IntPtr]::Zero) {
  $code = [XacpxJobQuery]::LastError()
  if ($code -eq 2) { Emit 'absent' $null }
  Emit 'unknown' @{reason="OpenJobObject failed with code $code"}
  exit 0
}
try {
  if ($request.action -eq 'contains') {
    $results = @()
    foreach ($targetPid in @($request.pids)) {
      $ph = [XacpxJobQuery]::OpenProcess(0x1000, $false, [uint32]$targetPid)
      if ($ph -eq [IntPtr]::Zero) { $results += @{ pid = [int]$targetPid; inJob = $false; verifiable = $false }; continue }
      try {
        $inJob = $false
        if (-not [XacpxJobQuery]::IsProcessInJob($ph, $handle, [ref]$inJob)) { $results += @{ pid = [int]$targetPid; inJob = $false; verifiable = $false }; continue }
        $results += @{ pid = [int]$targetPid; inJob = [bool]$inJob; verifiable = $true }
      } finally { [void][XacpxJobQuery]::CloseHandle($ph) }
    }
    Write-Output (@{status='contains';results=@($results)} | ConvertTo-Json -Depth 4 -Compress); exit 0
  }
  if ($request.action -eq 'attest') {
    $results = @()
    foreach ($targetPid in @($request.pids)) {
      $ph = [XacpxJobQuery]::OpenProcess(0x1000, $false, [uint32]$targetPid)
      if ($ph -eq [IntPtr]::Zero) {
        $code = [XacpxJobQuery]::LastError()
        $results += @{ pid = [int]$targetPid; inJob = $false; verifiable = $false; status = 'missing'; reason = "OpenProcess failed with code $code" }
        continue
      }
      try {
        $inJob = $false
        if (-not [XacpxJobQuery]::IsProcessInJob($ph, $handle, [ref]$inJob)) {
          $results += @{ pid = [int]$targetPid; inJob = $false; verifiable = $false; status = 'missing'; reason = "IsProcessInJob failed with code $([XacpxJobQuery]::LastError())" }
          continue
        }
        $created = New-Object XacpxJobQuery+FILETIME
        $exited = New-Object XacpxJobQuery+FILETIME
        $kernel = New-Object XacpxJobQuery+FILETIME
        $user = New-Object XacpxJobQuery+FILETIME
        if (-not [XacpxJobQuery]::GetProcessTimes($ph, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) {
          $results += @{ pid = [int]$targetPid; inJob = [bool]$inJob; verifiable = $false; status = 'missing'; reason = "GetProcessTimes failed with code $([XacpxJobQuery]::LastError())" }
          continue
        }
        $ticks = ((([uint64]$created.High -shl 32) -bor [uint64]$created.Low)).ToString()
        $results += @{ pid = [int]$targetPid; inJob = [bool]$inJob; verifiable = $true; status = 'found'; creationDate = $ticks }
      } finally { [void][XacpxJobQuery]::CloseHandle($ph) }
    }
    Write-Output (@{status='attest';results=@($results)} | ConvertTo-Json -Depth 4 -Compress); exit 0
  }
  $info = New-Object XacpxJobQuery+JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
  $returned = 0
  $infoSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [XacpxJobQuery]::QueryInformationJobObject($handle, 1, [ref]$info, $infoSize, [ref]$returned)) {
    Emit 'unknown' @{reason="QueryInformationJobObject failed with code $([XacpxJobQuery]::LastError())"}
    exit 0
  }
  if ($info.ActiveProcesses -eq 0) { Emit 'empty' $null }
  Emit 'active' @{activeProcesses=[int]$info.ActiveProcesses}
} finally { [void][XacpxJobQuery]::CloseHandle($handle) }
`;

function decodeJobQueryResult(value: unknown): WindowsJobQueryResult | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.status === "empty") return { status: "empty" };
  if (item.status === "absent") return { status: "absent" };
  if (item.status === "active") {
    if (typeof item.activeProcesses !== "number" || !Number.isSafeInteger(item.activeProcesses) || item.activeProcesses <= 0) return null;
    return { status: "active", activeProcesses: item.activeProcesses, processIds: [] };
  }
  if (item.status === "unknown" && typeof item.reason === "string") {
    return { status: "unknown", reason: item.reason };
  }
  return null;
}

async function runJobQueryWorker(request: JobQueryRequest, deadlineMs: number): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_JOB_QUERY_SCRIPT, "utf16le").toString("base64")],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, XACPX_JOB_REQUEST: Buffer.from(JSON.stringify(request), "utf8").toString("base64") } },
  );
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else {
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`invalid Windows job query response: ${stderr}`)); }
    }
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error("Windows job query timed out"));
  }, deadlineMs);
  timer.unref?.();
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", (error) => finish(error));
  child.once("close", (code) => code === 0 ? finish() : finish(new Error(`Windows job query failed (${code}): ${stderr}`)));
  return await promise;
}

export async function queryWindowsJob(
  jobName: string,
  options: WindowsJobQueryRunWorkerOptions = {},
): Promise<WindowsJobQueryResult> {
  if (typeof jobName !== "string" || jobName.length === 0) {
    return { status: "unknown", reason: "job name is empty" };
  }
  const deadline = options.workerDeadlineMs ?? DEFAULT_JOB_QUERY_DEADLINE_MS;
  const runWorker = options.runWorker ?? runJobQueryWorker;
  try {
    const result = await runWorker({ jobName }, deadline);
    const decoded = decodeJobQueryResult(result);
    return decoded ?? { status: "unknown", reason: "malformed job query response" };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
}

export type WindowsJobContainment = "empty" | "active" | "absent" | "unknown";

/** Query handles are transient so they cannot indefinitely delay kill-on-close. */
export async function queryJobContainment(
  jobName: string,
  options: WindowsJobQueryRunWorkerOptions = {},
): Promise<WindowsJobContainment> {
  if (!jobName) return "unknown";
  const result = await queryWindowsJob(jobName, options);
  switch (result.status) {
    case "empty": return "empty";
    case "active": return "active";
    case "absent": return "absent";
    default: return "unknown";
  }
}

export interface WindowsJobMembership {
  pid: number;
  inJob: boolean;
  verifiable: boolean;
}

/**
 * Host-side admission readback: are these pids members of the named Job?
 * Used once at worker bootstrap (supervisor hello → verify worker + supervisor
 * membership) before the admitted fence CAS. `verifiable: false` means the
 * process could not be opened or queried — fail closed, never assume.
 */
export async function queryJobMembership(
  jobName: string,
  pids: number[],
  options: WindowsJobQueryRunWorkerOptions = {},
): Promise<WindowsJobMembership[] | null> {
  if (!jobName || pids.length === 0 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) || new Set(pids).size !== pids.length) return null;
  const deadline = options.workerDeadlineMs ?? DEFAULT_JOB_QUERY_DEADLINE_MS;
  const runWorker = options.runWorker ?? runJobQueryWorker;
  try {
    const result = await runWorker({ jobName, action: "contains", pids }, deadline);
    if (!result || typeof result !== "object") return null;
    const status = (result as Record<string, unknown>).status;
    const results = (result as Record<string, unknown>).results;
    if (status !== "contains" || !Array.isArray(results)) return null;
    const out: WindowsJobMembership[] = [];
    for (const item of results) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.pid !== "number" || !pids.includes(entry.pid) || out.some((member) => member.pid === entry.pid)
        || typeof entry.inJob !== "boolean" || typeof entry.verifiable !== "boolean") return null;
      out.push({ pid: entry.pid, inJob: entry.inJob, verifiable: entry.verifiable });
    }
    return out.length === pids.length ? out : null;
  } catch {
    return null;
  }
}
export interface JobAttestation {
  pid: number;
  inJob: boolean;
  verifiable: boolean;
  status: "found" | "missing";
  creationDate?: string;
  /** Native failure detail when the readback could not be trusted. */
  reason?: string;
}

/**
 * One-readback admission attestation: Job membership AND process creation
 * time per pid in a single PowerShell transaction. Admission previously
 * needed three serial spawns (worker probe, membership, re-probe); the birth
 * read here lands in the same transaction as the membership read, so no
 * re-probe is required. `verifiable: false` (open or query failure) is never
 * an absence proof; the caller must fail closed.
 */
export async function queryJobAttestation(
  jobName: string,
  pids: number[],
  options: WindowsJobQueryRunWorkerOptions = {},
): Promise<JobAttestation[] | null> {
  if (!jobName || pids.length === 0 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0) || new Set(pids).size !== pids.length) return null;
  const deadline = options.workerDeadlineMs ?? DEFAULT_JOB_QUERY_DEADLINE_MS;
  const runWorker = options.runWorker ?? runJobQueryWorker;
  try {
    const result = await runWorker({ jobName, action: "attest", pids }, deadline);
    if (!result || typeof result !== "object") return null;
    const status = (result as Record<string, unknown>).status;
    const results = (result as Record<string, unknown>).results;
    if (status !== "attest" || !Array.isArray(results)) return null;
    const out: JobAttestation[] = [];
    for (const item of results) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.pid !== "number" || !pids.includes(entry.pid) || out.some((member) => member.pid === entry.pid)
        || typeof entry.inJob !== "boolean" || typeof entry.verifiable !== "boolean") return null;
      if (entry.status === "found") {
        if (parseCanonicalFileTime(entry.creationDate) === null) return null;
        out.push({
          pid: entry.pid, inJob: entry.inJob, verifiable: entry.verifiable, status: "found", creationDate: String(entry.creationDate),
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
        });
      } else if (entry.status === "missing") {
        out.push({
          pid: entry.pid, inJob: entry.inJob, verifiable: entry.verifiable, status: "missing",
          ...(typeof entry.reason === "string" ? { reason: entry.reason } : {}),
        });
      } else {
        return null;
      }
    }
    return out.length === pids.length ? out : null;
  } catch {
    return null;
  }
}
