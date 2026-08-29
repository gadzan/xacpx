import { spawn } from "node:child_process";

import { parseCanonicalFileTime } from "./windows-process-identity";

export interface BatchTarget {
  pid: number;
  creationDate: string | null;
  commandLine?: string;
  executablePath?: string;
}

export type KillOutcome =
  | "killed"
  | "already-exited"
  | "kill-requested-unconfirmed"
  | "access-denied"
  | "query-failed"
  | "skipped-replaced";

export interface ProcessTreeOutcome {
  target: BatchTarget;
  outcome: KillOutcome;
  commandLine?: string;
  executablePath?: string;
}

export interface TerminateProcessTreeResult {
  rootOutcome: KillOutcome;
  outcomes: ProcessTreeOutcome[];
}

/**
 * Per-descendant result of the `terminate-descendants-of` cleanup action.
 * Unlike `ProcessTreeOutcome`, the parent pid is NEVER among these — the
 * action's contract is to keep the parent alive and converge only its
 * transitive descendants.
 */
export interface WindowsDescendantOutcome {
  pid: number;
  outcome: KillOutcome;
  creationDate: string | null;
  commandLine: string | null;
  executablePath: string | null;
}

/** A process still present after convergence, parented by the worker itself or by a killed descendant. */
export interface WindowsDescendantLeftover {
  pid: number;
  parentPid: number;
  creationDate: string | null;
  commandLine: string | null;
  executablePath: string | null;
}

export interface TerminateDescendantsResult {
  /**
   * True only when every discovered descendant reached a verified safe outcome
   * (killed / already-exited) AND a fresh final CIM snapshot shows no unhandled
   * process remains under the parent or under a killed descendant. Any CIM,
   * query, or kill uncertainty fails closed to false — callers must treat an
   * unverified result as "cleanup ownership not discharged".
   */
  verified: boolean;
  outcomes: WindowsDescendantOutcome[];
  leftover: WindowsDescendantLeftover[];
}

export interface WindowsProcessIdentity {
  pid: number;
  creationDate: string;
  executablePath: string;
  commandLine?: string;
}

export interface WindowsTokenProcess {
  pid: number;
  creationDate: string;
  commandLine: string;
  executablePath: string;
}

interface WorkerResponse {
  rootOutcome: unknown;
  outcomes: unknown;
}

export interface WindowsProcessWorkerOptions {
  /** Null disables the hard-kill timer (EOF convergence relies on the in-script watchdog). */
  workerDeadlineMs?: number | null;
  runWorker?: (request: WindowsWorkerRequest, deadlineMs: number | null) => Promise<unknown>;
}

export type WindowsWorkerRequest =
  | { action: "terminate-tree"; root: BatchTarget }
  | { action: "identity"; pid: number }
  | { action: "token-snapshot"; token: string }
  | { action: "terminate-one-cim"; target: BatchTarget }
  | { action: "terminate-descendants-of"; parentPid: number; epcd?: string; orph?: boolean };
export type WindowsProbeStatus = { status: "found"; identity: WindowsProcessIdentity } | { status: "missing" | "unavailable" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OUTCOMES = new Set<KillOutcome>([
  "killed", "already-exited", "kill-requested-unconfirmed",
  "access-denied", "query-failed", "skipped-replaced",
]);

function queryFailed(root: BatchTarget): TerminateProcessTreeResult {
  return {
    rootOutcome: "query-failed",
    outcomes: [{ target: root, outcome: "query-failed" }],
  };
}

function decodeTarget(value: unknown): BatchTarget | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 0) return null;
  if (parseCanonicalFileTime(item.creationDate) === null) return null;
  // The worker emits JSON null for fingerprints the caller did not supply;
  // treat null like an absent field rather than rejecting the whole response.
  if (item.commandLine !== undefined && item.commandLine !== null && typeof item.commandLine !== "string") return null;
  if (item.executablePath !== undefined && item.executablePath !== null && typeof item.executablePath !== "string") return null;
  return {
    pid: Number(item.pid),
    creationDate: String(item.creationDate),
    ...(typeof item.commandLine === "string" ? { commandLine: item.commandLine } : {}),
    ...(typeof item.executablePath === "string" ? { executablePath: item.executablePath } : {}),
  };
}

export function decodeWindowsTreeWorkerResponse(value: unknown, root: BatchTarget): TerminateProcessTreeResult | null {
  if (!value || typeof value !== "object") return null;
  const response = value as WorkerResponse;
  if (typeof response.rootOutcome !== "string" || !OUTCOMES.has(response.rootOutcome as KillOutcome)) return null;
  if (!Array.isArray(response.outcomes)) return null;
  const outcomes: ProcessTreeOutcome[] = [];
  const seen = new Set<number>();
  for (const raw of response.outcomes) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const target = decodeTarget(item.target);
    if (!target || seen.has(target.pid) || typeof item.outcome !== "string" || !OUTCOMES.has(item.outcome as KillOutcome)) {
      return null;
    }
    seen.add(target.pid);
    outcomes.push({
      target,
      outcome: item.outcome as KillOutcome,
      ...(typeof item.commandLine === "string" ? { commandLine: item.commandLine } : {}),
      ...(typeof item.executablePath === "string" ? { executablePath: item.executablePath } : {}),
    });
  }

  const rootEntry = outcomes.find((item) => item.target.pid === root.pid);
  if (!rootEntry || rootEntry.outcome !== response.rootOutcome) return null;
  return { rootOutcome: response.rootOutcome as KillOutcome, outcomes };
}

const DESCENDANT_SAFE_OUTCOMES: Partial<Record<KillOutcome, true>> = { killed: true, "already-exited": true };

/**
 * Dedicated decoder for the `terminate-descendants-of` protocol. This is NOT
 * `decodeWindowsTreeWorkerResponse`: the descendants action never emits the
 * parent pid (the parent must stay alive), so requiring a root entry like the
 * tree decoder does would misread every fully successful cleanup as
 * query-failed. The worker's own `verified` flag is honored only when it
 * agrees with an independent recomputation from the returned evidence; any
 * inconsistency, unsafe outcome, leftover, duplicate pid, or parent-pid entry
 * fails closed.
 */
export function decodeWindowsDescendantsResponse(value: unknown, parentPid: number): TerminateDescendantsResult | null {
  if (!value || typeof value !== "object") return null;
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.outcomes) || !Array.isArray(response.leftover)) return null;
  if (typeof response.verified !== "boolean") return null;
  const outcomes: WindowsDescendantOutcome[] = [];
  const seen = new Set<number>();
  for (const raw of response.outcomes) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 0) return null;
    const pid = Number(item.pid);
    if (pid === parentPid || seen.has(pid)) return null;
    if (typeof item.outcome !== "string" || !OUTCOMES.has(item.outcome as KillOutcome)) return null;
    seen.add(pid);
    outcomes.push({
      pid,
      outcome: item.outcome as KillOutcome,
      creationDate: item.creationDate === null || item.creationDate === undefined || item.creationDate === "" ? null : String(item.creationDate),
      commandLine: typeof item.commandLine === "string" && item.commandLine.length > 0 ? item.commandLine : null,
      executablePath: typeof item.executablePath === "string" && item.executablePath.length > 0 ? item.executablePath : null,
    });
  }
  const leftover: WindowsDescendantLeftover[] = [];
  for (const raw of response.leftover) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 0) return null;
    const pid = Number(item.pid);
    if (pid === parentPid || seen.has(pid)) return null;
    if (!Number.isSafeInteger(item.parentPid) || Number(item.parentPid) <= 0) return null;
    seen.add(pid);
    leftover.push({
      pid,
      parentPid: Number(item.parentPid),
      creationDate: item.creationDate === null || item.creationDate === undefined || item.creationDate === "" ? null : String(item.creationDate),
      commandLine: typeof item.commandLine === "string" && item.commandLine.length > 0 ? item.commandLine : null,
      executablePath: typeof item.executablePath === "string" && item.executablePath.length > 0 ? item.executablePath : null,
    });
  }
  const recomputed =
    outcomes.every((item) => DESCENDANT_SAFE_OUTCOMES[item.outcome]) && leftover.length === 0;
  if (response.verified !== recomputed) return null;
  return { verified: recomputed, outcomes, leftover };
}

export async function terminateWindowsProcessTree(
  root: BatchTarget,
  options: WindowsProcessWorkerOptions = {},
): Promise<TerminateProcessTreeResult> {
  if (!Number.isSafeInteger(root.pid) || root.pid <= 0 || parseCanonicalFileTime(root.creationDate) === null) {
    return queryFailed(root);
  }
  try {
    const raw = await (options.runWorker ?? runPowerShellWorker)(
      { action: "terminate-tree", root },
      options.workerDeadlineMs === undefined ? 15_000 : options.workerDeadlineMs,
    );
    return decodeWindowsTreeWorkerResponse(raw, root) ?? queryFailed(root);
  } catch {
    return queryFailed(root);
  }
}

export async function queryWindowsProcessIdentity(
  pid: number,
  options: WindowsProcessWorkerOptions = {},
): Promise<WindowsProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = await (options.runWorker ?? runPowerShellWorker)(
      { action: "identity", pid },
      options.workerDeadlineMs ?? 5_000,
    );
    if (!value || typeof value !== "object") return null;
    const envelope = value as Record<string, unknown>;
    const item = envelope.status === "found" && envelope.identity && typeof envelope.identity === "object"
      ? envelope.identity as Record<string, unknown>
      : envelope;
    if (item.pid !== pid || parseCanonicalFileTime(item.creationDate) === null || typeof item.executablePath !== "string" || !item.executablePath) {
      return null;
    }
    return {
      pid,
      creationDate: String(item.creationDate),
      executablePath: item.executablePath,
      ...(typeof item.commandLine === "string" && item.commandLine ? { commandLine: item.commandLine } : {}),
    };
  } catch {
    return null;
  }
}

export async function probeWindowsProcessIdentity(
  pid: number,
  options: WindowsProcessWorkerOptions = {},
): Promise<WindowsProbeStatus> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "unavailable" };
  try {
    const value = await (options.runWorker ?? runPowerShellWorker)({ action: "identity", pid }, options.workerDeadlineMs ?? 5_000);
    if (!value || typeof value !== "object") return { status: "unavailable" };
    const item = value as Record<string, unknown>;
    if (item.status === "missing") return { status: "missing" };
    const identity = await queryWindowsProcessIdentity(pid, { ...options, runWorker: async () => value });
    return identity ? { status: "found", identity } : { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
}

export async function snapshotWindowsProcessesByToken(
  token: string,
  options: WindowsProcessWorkerOptions = {},
): Promise<WindowsTokenProcess[] | null> {
  if (!UUID.test(token)) return null;
  try {
    const value = await (options.runWorker ?? runPowerShellWorker)({ action: "token-snapshot", token }, options.workerDeadlineMs ?? 5_000);
    const items = value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items)
      ? (value as Record<string, unknown>).items
      : value;
    if (!Array.isArray(items)) return null;
    const result: WindowsTokenProcess[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Record<string, unknown>;
      if (!Number.isSafeInteger(item.pid) || Number(item.pid) <= 0 || parseCanonicalFileTime(item.creationDate) === null
        || typeof item.commandLine !== "string" || !item.commandLine || typeof item.executablePath !== "string" || !item.executablePath) return null;
      result.push({ pid: Number(item.pid), creationDate: String(item.creationDate), commandLine: item.commandLine, executablePath: item.executablePath });
    }
    return result;
  } catch { return null; }
}

export interface TerminateDescendantsOptions extends WindowsProcessWorkerOptions {
  /**
   * Round 30 Blocking 3: when set, the parent's identity (exact canonical
   * creation time) is verified against a RETAINED handle INSIDE the kill
   * transaction, before any child is attributed via parentPid edges. A
   * replaced parent fails the whole action closed (unverified, nothing
   * killed) — a bare historical parent pid is never a kill authority.
   */
  expectedParentCreationDate?: string;
  /**
   * Round 32 Blocking 1: DEAD-root orphan recovery. When the parent is
   * already gone, the pid-reuse ambiguity is resolved by BIRTH ORDER: the
   * reuser's creation time is the cutoff, and only children born BEFORE it
   * are attributed to the dead worker. Children of the reuser are excluded;
   * deeper descendants of accepted nodes are ours regardless of birth order.
   */
  recoverDeadParent?: boolean;
}

export async function terminateWindowsDescendantsOf(
  parentPid: number,
  options: TerminateDescendantsOptions = {},
): Promise<TerminateDescendantsResult> {
  const unverified: TerminateDescendantsResult = { verified: false, outcomes: [], leftover: [] };
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return unverified;
  try {
    const raw = await (options.runWorker ?? runPowerShellWorker)(
      {
        action: "terminate-descendants-of",
        parentPid,
        ...(options.expectedParentCreationDate !== undefined ? { epcd: options.expectedParentCreationDate } : {}),
        ...(options.recoverDeadParent ? { orph: true } : {}),
      },
      options.workerDeadlineMs === undefined ? 15_000 : options.workerDeadlineMs,
    );
    return decodeWindowsDescendantsResponse(raw, parentPid) ?? unverified;
  } catch {
    return unverified;
  }
}

export async function terminateWindowsResidual(
  target: BatchTarget,
  options: WindowsProcessWorkerOptions = {},
): Promise<KillOutcome> {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || parseCanonicalFileTime(target.creationDate) === null) return "query-failed";
  try {
    const value = await (options.runWorker ?? runPowerShellWorker)({ action: "terminate-one-cim", target }, options.workerDeadlineMs ?? 5_000);
    const outcome = value && typeof value === "object" ? (value as Record<string, unknown>).outcome : undefined;
    return typeof outcome === "string" && OUTCOMES.has(outcome as KillOutcome) ? outcome as KillOutcome : "query-failed";
  } catch { return "query-failed"; }
}

async function runPowerShellWorker(request: WindowsWorkerRequest, deadlineMs: number | null): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    // Windows PowerShell 5.1 processes `-Command -` stdin line by line and
    // silently discards any line that opens a multi-line construct (blocks,
    // here-strings), so piping the script leaves the worker producing no
    // output at all. `-EncodedCommand` (base64 UTF-16LE) delivers the script
    // intact — the same transport buildWindowsLauncherScript already uses.
    // Round 30 Blocking 3: the descendants action runs its own script — the
    // parent identity gate needs encoded-command budget, and each script
    // must independently fit the CreateProcess command-line ceiling.
    const script = request.action === "terminate-descendants-of"
      ? WINDOWS_DESCENDANTS_WORKER_SCRIPT
      : WINDOWS_TREE_WORKER_SCRIPT;
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        XACPX_PROCESS_REQUEST: Buffer.from(JSON.stringify(request), "utf8").toString("base64"),
      },
    });
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
        catch { reject(new Error(`invalid Windows worker response: ${stderr}`)); }
      }
    };
    const timer = deadlineMs === null ? undefined : setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Windows process worker timed out"));
    }, deadlineMs);
    void timer;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0 ? finish() : finish(new Error(`Windows process worker failed (${code}): ${stderr}`)));
  });
}

// Dedicated script for terminate-descendants-of (round 30 Blocking 3): the
// parent identity gate needs room inside the encoded command budget. Each
// script owns one PowerShell process end-to-end (handle capture → kill).
export const WINDOWS_DESCENDANTS_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:XACPX_PROCESS_REQUEST)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class XacpxNativeProcess {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out FILETIME c, out FILETIME e, out FILETIME k, out FILETIME u);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder value, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  public static IntPtr Open(uint pid) { return OpenProcess(0x00101001u, false, pid); }
  public static int LastError() { return Marshal.GetLastWin32Error(); }
  public static string Creation(IntPtr h) { FILETIME c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u)) return null; return (((ulong)c.High << 32) | c.Low).ToString(); }
  public static string Image(IntPtr h) { uint n=32768; var b=new StringBuilder((int)n); return QueryFullProcessImageName(h,0,b,ref n) ? b.ToString() : null; }
  public static bool Alive(IntPtr h) { return WaitForSingleObject(h,0)==0x102u; }
  public static bool Kill(IntPtr h) { return TerminateProcess(h,1); }
  public static bool WaitDead(IntPtr h) { return WaitForSingleObject(h,2000)==0u; }
  public static void Close(IntPtr h) { if(h!=IntPtr.Zero) CloseHandle(h); }
}
'@
function Result($rootOutcome, $outcomes) { @{rootOutcome=$rootOutcome;outcomes=@($outcomes)} | ConvertTo-Json -Depth 8 -Compress }
function Outcome($node, $status) {
  @{ target=@{pid=[int]$node.pid;creationDate=[string]$node.creationDate;commandLine=$node.commandLine;executablePath=$node.executablePath}; outcome=$status; commandLine=$node.commandLine; executablePath=$node.executablePath }
}
function Snapshot {
  $watch=[Diagnostics.Stopwatch]::StartNew()
  $items=@(Get-CimInstance Win32_Process | ForEach-Object {
    $ticks=$null
    if($_.CreationDate){$ticks=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}
    [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creationDate=$ticks;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath}
  })
  # GH runners measure ~3s per CIM enumeration; 8s bounds while absorbing
  # bursty snapshots.
  if($watch.ElapsedMilliseconds -gt 8000){throw 'CIM enumeration exceeded 8 seconds'}
  return $items
}
function OpenVerified($node, $cim) {
  $h=[XacpxNativeProcess]::Open([uint32]$node.pid)
  if($h -eq [IntPtr]::Zero){
    $code=[XacpxNativeProcess]::LastError()
    $status=if($code -eq 5){'access-denied'}elseif($code -eq 87 -or $code -eq 1168){'already-exited'}else{'query-failed'}
    return @{ok=$false;status=$status;handle=$h}
  }
  $actual=[XacpxNativeProcess]::Creation($h)
  if(!$actual){[XacpxNativeProcess]::Close($h);return @{ok=$false;status='query-failed';handle=[IntPtr]::Zero}}
  $delta=[Numerics.BigInteger]::Abs([Numerics.BigInteger]::Parse($actual)-[Numerics.BigInteger]::Parse([string]$node.creationDate))
  $same=if($cim){$delta -le 9}else{$delta -eq 0}
  if(!$same){[XacpxNativeProcess]::Close($h);return @{ok=$false;status='skipped-replaced';handle=[IntPtr]::Zero}}
  $image=[XacpxNativeProcess]::Image($h)
  if(!$image){[XacpxNativeProcess]::Close($h);return @{ok=$false;status='query-failed';handle=[IntPtr]::Zero}}
  if($node.executablePath -and ![string]::Equals([string]$node.executablePath,$image,[StringComparison]::OrdinalIgnoreCase)){
    [XacpxNativeProcess]::Close($h);return @{ok=$false;status='skipped-replaced';handle=[IntPtr]::Zero}
  }
  return @{ok=$true;status=$null;handle=$h;image=$image}
}

function CL($h){try{[XacpxNativeProcess]::Close($h)}catch{}}
function VF($p){$c=OpenVerified $p $true;if($c.ok){$open[$p.pid]=$c.handle}else{$ov[$p.pid]=$c.status;CL $c.handle}}
if($request.action -eq 'identity'){
  $h=[XacpxNativeProcess]::Open([uint32]$request.pid)
  if($h -eq [IntPtr]::Zero){
    $code=[XacpxNativeProcess]::LastError()
    $status=if($code -eq 87 -or $code -eq 1168){'missing'}else{'unavailable'}
    Write-Output (@{status=$status} | ConvertTo-Json -Compress);exit 0
  }
  try {
    $creation=[XacpxNativeProcess]::Creation($h);$image=[XacpxNativeProcess]::Image($h)
    if(!$creation -or !$image){Write-Output (@{status='unavailable'} | ConvertTo-Json -Compress);exit 0}
    $commandLine=$null
    try {
      $cim=Get-CimInstance Win32_Process -Filter ("ProcessId = "+[int]$request.pid)
      if($cim -and $cim.CreationDate){
        $cimCreation=$cim.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
        $delta=[Numerics.BigInteger]::Abs([Numerics.BigInteger]::Parse($creation)-[Numerics.BigInteger]::Parse($cimCreation))
        if($delta -le 9 -and [string]::Equals([string]$image,[string]$cim.ExecutablePath,[StringComparison]::OrdinalIgnoreCase)){
          $commandLine=$cim.CommandLine
        }
      }
    } catch {}
    Write-Output (@{status='found';identity=@{pid=[int]$request.pid;creationDate=$creation;executablePath=$image;commandLine=$commandLine}} | ConvertTo-Json -Depth 4 -Compress)
    exit 0
  } finally {[XacpxNativeProcess]::Close($h)}
}
if($request.action -eq 'token-snapshot'){
  $needle='--xacpx-owner-token '+[string]$request.token
  $matches=@(Snapshot | Where-Object {$_.commandLine -and $_.commandLine.Contains($needle)})
  Write-Output (@{items=$matches} | ConvertTo-Json -Depth 5 -Compress);exit 0
}


# G10: discovery precedes kill; S2 seeds from verified handles only.
if($request.action -eq 'terminate-descendants-of'){
$pp=[int]$request.parentPid
$out=@();$sn=@{};$fr=@($pp);$open=@{};$ov=@{};$cl=@();$pok=$true
# G10 round 30 Blocking 3: the parent identity gate runs INSIDE this kill
# transaction. An expected creation date is verified against a RETAINED
# handle before any child attribution; a dead, replaced, or unprobeable
# parent fails closed (no bare historical-pid kill).
$ps='alive'
$e=$request.epcd
if($e){
$h=[XacpxNativeProcess]::Open([uint32]$pp)
if($h -eq [IntPtr]::Zero){
$c=[XacpxNativeProcess]::LastError()
if($request.orph -and ($c -eq 87 -or $c -eq 1168)){
# Round 32 Blocking 1: root DEAD + orphan recovery. The parentPid edge is
# only ambiguous when the pid was REUSED — the reuser's birth is the cutoff:
# children born BEFORE it were parented by our dead worker, children born
# after it belong to the unrelated reuser. Recover the subtree by cutoff.
$ps='orphan-recovery'
}else{
$ps=if($c -eq 5){'access-denied'}elseif($c -eq 87 -or $c -eq 1168){'already-exited'}else{'query-failed'}
}
}else{
$a=[XacpxNativeProcess]::Creation($h)
if(!$a -or $a -ne [string]$e){[XacpxNativeProcess]::Close($h);$ps='skipped-replaced'}
else{$sn[$pp]=$true;$open[$pp]=$h}
}
}
if($ps -ne 'alive' -and $ps -ne 'orphan-recovery'){Write-Output (@{verified=$false;parentStatus=$ps;outcomes=@();leftover=@()}|ConvertTo-Json -Depth 5 -Compress);exit 0}
$cutoff=$null
if($ps -eq 'orphan-recovery'){
$now=@(Snapshot)
$reused=$now|?{$_.pid -eq $pp}|Select-Object -First 1
if($reused){$cutoff=$reused.creationDate}
$sn[$pp]=$true
}
$s1=@(Snapshot)
$seeds=@($s1|?{$_.parentPid -eq $pp -and $_.pid -ne $pp -and -not $sn.ContainsKey($_.pid)})
if($cutoff){$seeds=@($seeds|?{$_.creationDate -and [Numerics.BigInteger]::Parse($_.creationDate) -lt [Numerics.BigInteger]::Parse($cutoff)})}
foreach($p in $seeds){$sn[$p.pid]=$true;$cl+=@($p)}
$fr=@($seeds|%{$_.pid})
while($fr.Count){
$nx=@()
foreach($p in $s1|?{$_.parentPid -in $fr -and $_.pid -ne $pp -and -not $sn.ContainsKey($_.pid)}){$sn[$p.pid]=$true;$cl+=@($p);$nx+=$p.pid}
$fr=$nx
}
try {
foreach($p in $cl){VF $p}
$lf=@()
$s2=@(Snapshot)
$fr=@($pp)+@($open.Keys)
while($fr.Count){
$nx=@()
foreach($p in $s2|?{$_.parentPid -in $fr -and $_.pid -ne $pp -and -not $sn.ContainsKey($_.pid)}){
$sn[$p.pid]=$true
VF $p
$lf+=@($p)
$nx+=$p.pid
}
$fr=$nx
}
foreach($p in $cl){
if($open.ContainsKey($p.pid)){$h=$open[$p.pid];$s=if(-not [XacpxNativeProcess]::Alive($h)){'already-exited'}elseif([XacpxNativeProcess]::Kill($h)){if([XacpxNativeProcess]::WaitDead($h)){'killed'}else{'kill-requested-unconfirmed'}}else{if([XacpxNativeProcess]::LastError()-eq 5){'access-denied'}else{'query-failed'}}}else{$s=$ov[$p.pid]}
$out+=@{pid=$p.pid;outcome=$s;creationDate=$p.creationDate;commandLine=$p.commandLine;executablePath=$p.executablePath}
}
if($e){if($open.ContainsKey($pp)){$h=$open[$pp];if([XacpxNativeProcess]::Alive($h)){if([XacpxNativeProcess]::Kill($h)){if(-not [XacpxNativeProcess]::WaitDead($h)){$pok=$false}}else{$pok=$false}}}}
} finally {$open.Values|%{CL $_}}
$vf=!@($out|?{$_.outcome -notin 'killed','already-exited'}).Count -and !$lf.Count -and $pok
Write-Output (@{verified=$vf;outcomes=$out;leftover=$lf}|ConvertTo-Json -Depth 8 -Compress);exit 0
}
`;

// One PowerShell process owns every verified handle from identity check through
// termination. No verified PID is ever handed to Stop-Process/taskkill later.
// Exported so the test suite can statically guard against the encoded payload
// exceeding Windows' CreateProcess command-line ceiling.
export const WINDOWS_TREE_WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:XACPX_PROCESS_REQUEST)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class XacpxNativeProcess {
  [StructLayout(LayoutKind.Sequential)] public struct FILETIME { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out FILETIME c, out FILETIME e, out FILETIME k, out FILETIME u);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder value, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  public static IntPtr Open(uint pid) { return OpenProcess(0x00101001u, false, pid); }
  public static int LastError() { return Marshal.GetLastWin32Error(); }
  public static string Creation(IntPtr h) { FILETIME c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u)) return null; return (((ulong)c.High << 32) | c.Low).ToString(); }
  public static string Image(IntPtr h) { uint n=32768; var b=new StringBuilder((int)n); return QueryFullProcessImageName(h,0,b,ref n) ? b.ToString() : null; }
  public static bool Alive(IntPtr h) { return WaitForSingleObject(h,0)==0x102u; }
  public static bool Kill(IntPtr h) { return TerminateProcess(h,1); }
  public static bool WaitDead(IntPtr h) { return WaitForSingleObject(h,2000)==0u; }
  public static void Close(IntPtr h) { if(h!=IntPtr.Zero) CloseHandle(h); }
}
'@
function Result($rootOutcome, $outcomes) { @{rootOutcome=$rootOutcome;outcomes=@($outcomes)} | ConvertTo-Json -Depth 8 -Compress }
function Outcome($node, $status) {
  @{ target=@{pid=[int]$node.pid;creationDate=[string]$node.creationDate;commandLine=$node.commandLine;executablePath=$node.executablePath}; outcome=$status; commandLine=$node.commandLine; executablePath=$node.executablePath }
}
function Snapshot {
  $watch=[Diagnostics.Stopwatch]::StartNew()
  $items=@(Get-CimInstance Win32_Process | ForEach-Object {
    $ticks=$null
    if($_.CreationDate){$ticks=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}
    [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creationDate=$ticks;commandLine=$_.CommandLine;executablePath=$_.ExecutablePath}
  })
  # GH runners measure ~3s per CIM enumeration; 8s bounds while absorbing
  # bursty snapshots.
  if($watch.ElapsedMilliseconds -gt 8000){throw 'CIM enumeration exceeded 8 seconds'}
  return $items
}
function OpenVerified($node, $cim) {
  $h=[XacpxNativeProcess]::Open([uint32]$node.pid)
  if($h -eq [IntPtr]::Zero){
    $code=[XacpxNativeProcess]::LastError()
    $status=if($code -eq 5){'access-denied'}elseif($code -eq 87 -or $code -eq 1168){'already-exited'}else{'query-failed'}
    return @{ok=$false;status=$status;handle=$h}
  }
  $actual=[XacpxNativeProcess]::Creation($h)
  if(!$actual){[XacpxNativeProcess]::Close($h);return @{ok=$false;status='query-failed';handle=[IntPtr]::Zero}}
  $delta=[Numerics.BigInteger]::Abs([Numerics.BigInteger]::Parse($actual)-[Numerics.BigInteger]::Parse([string]$node.creationDate))
  $same=if($cim){$delta -le 9}else{$delta -eq 0}
  if(!$same){[XacpxNativeProcess]::Close($h);return @{ok=$false;status='skipped-replaced';handle=[IntPtr]::Zero}}
  $image=[XacpxNativeProcess]::Image($h)
  if(!$image){[XacpxNativeProcess]::Close($h);return @{ok=$false;status='query-failed';handle=[IntPtr]::Zero}}
  if($node.executablePath -and ![string]::Equals([string]$node.executablePath,$image,[StringComparison]::OrdinalIgnoreCase)){
    [XacpxNativeProcess]::Close($h);return @{ok=$false;status='skipped-replaced';handle=[IntPtr]::Zero}
  }
  return @{ok=$true;status=$null;handle=$h;image=$image}
}

function CL($h){try{[XacpxNativeProcess]::Close($h)}catch{}}
function VF($p){$c=OpenVerified $p $true;if($c.ok){$open[$p.pid]=$c.handle}else{$ov[$p.pid]=$c.status;CL $c.handle}}
if($request.action -eq 'identity'){
  $h=[XacpxNativeProcess]::Open([uint32]$request.pid)
  if($h -eq [IntPtr]::Zero){
    $code=[XacpxNativeProcess]::LastError()
    $status=if($code -eq 87 -or $code -eq 1168){'missing'}else{'unavailable'}
    Write-Output (@{status=$status} | ConvertTo-Json -Compress);exit 0
  }
  try {
    $creation=[XacpxNativeProcess]::Creation($h);$image=[XacpxNativeProcess]::Image($h)
    if(!$creation -or !$image){Write-Output (@{status='unavailable'} | ConvertTo-Json -Compress);exit 0}
    $commandLine=$null
    try {
      $cim=Get-CimInstance Win32_Process -Filter ("ProcessId = "+[int]$request.pid)
      if($cim -and $cim.CreationDate){
        $cimCreation=$cim.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()
        $delta=[Numerics.BigInteger]::Abs([Numerics.BigInteger]::Parse($creation)-[Numerics.BigInteger]::Parse($cimCreation))
        if($delta -le 9 -and [string]::Equals([string]$image,[string]$cim.ExecutablePath,[StringComparison]::OrdinalIgnoreCase)){
          $commandLine=$cim.CommandLine
        }
      }
    } catch {}
    Write-Output (@{status='found';identity=@{pid=[int]$request.pid;creationDate=$creation;executablePath=$image;commandLine=$commandLine}} | ConvertTo-Json -Depth 4 -Compress)
    exit 0
  } finally {[XacpxNativeProcess]::Close($h)}
}
if($request.action -eq 'token-snapshot'){
  $needle='--xacpx-owner-token '+[string]$request.token
  $matches=@(Snapshot | Where-Object {$_.commandLine -and $_.commandLine.Contains($needle)})
  Write-Output (@{items=$matches} | ConvertTo-Json -Depth 5 -Compress);exit 0
}
if($request.action -eq 'terminate-one-cim'){
  $target=[pscustomobject]@{pid=[int]$request.target.pid;creationDate=[string]$request.target.creationDate;commandLine=$request.target.commandLine;executablePath=$request.target.executablePath}
  $check=OpenVerified $target $true
  if(!$check.ok){Write-Output (@{outcome=$check.status} | ConvertTo-Json -Compress);exit 0}
  try {
    if(![XacpxNativeProcess]::Alive($check.handle)){$status='already-exited'}
    elseif(![XacpxNativeProcess]::Kill($check.handle)){
      # Job-object cascade: dying child kill = confirmed exit.
      if([XacpxNativeProcess]::WaitDead($check.handle)){$status='already-exited'}
      else{$status=if($code -eq 5){'access-denied'}else{'query-failed'}}
    }
    else{$status=if([XacpxNativeProcess]::WaitDead($check.handle)){'killed'}else{'kill-requested-unconfirmed'}}
    Write-Output (@{outcome=$status} | ConvertTo-Json -Compress);exit 0
  } finally {[XacpxNativeProcess]::Close($check.handle)}
}
$root=[pscustomobject]@{pid=[int]$request.root.pid;creationDate=[string]$request.root.creationDate;commandLine=$request.root.commandLine;executablePath=$request.root.executablePath}
$handles=@{}
$nodes=New-Object Collections.ArrayList
$rootCheck=OpenVerified $root $false
if(!$rootCheck.ok){Write-Output (Result $rootCheck.status @((Outcome $root $rootCheck.status)));exit 0}
$handles[$root.pid]=$rootCheck.handle
[void]$nodes.Add($root)
try {
  $snapshot=@(Snapshot)
  $byPid=@{}
  foreach($p in $snapshot){if($byPid.ContainsKey($p.pid)){throw 'duplicate pid in CIM snapshot'};$byPid[$p.pid]=$p}
  if(!$byPid.ContainsKey($root.pid)){throw 'verified root absent from snapshot'}
  $rootDelta=[Numerics.BigInteger]::Abs([Numerics.BigInteger]::Parse($byPid[$root.pid].creationDate)-[Numerics.BigInteger]::Parse($root.creationDate))
  if($rootDelta -gt 9){throw 'root snapshot identity mismatch'}
  $verified=New-Object 'Collections.Generic.HashSet[int]'
  [void]$verified.Add($root.pid)
  $remaining=@($snapshot | Where-Object {$_.pid -ne $root.pid})
  do {
    $added=0
    foreach($p in @($remaining)){
      if($verified.Contains($p.parentPid)){
        $parent=$nodes | Where-Object {$_.pid -eq $p.parentPid} | Select-Object -First 1
        if(!$p.creationDate -or !$p.commandLine -or !$p.executablePath){throw 'incomplete descendant fingerprint'}
        if([Numerics.BigInteger]::Parse($p.creationDate) -lt [Numerics.BigInteger]::Parse($parent.creationDate)){throw 'child predates parent'}
        $check=OpenVerified $p $true
        if(!$check.ok){throw ('descendant verification failed: '+$check.status)}
        $p.executablePath=$check.image
        $handles[$p.pid]=$check.handle
        [void]$nodes.Add($p);[void]$verified.Add($p.pid)
        $remaining=@($remaining | Where-Object {$_.pid -ne $p.pid});$added++
      }
    }
  } while($added -gt 0)
  # One append enumeration only.
  $append=@(Snapshot)
  $new=@($append | Where-Object {!$verified.Contains($_.pid) -and $verified.Contains($_.parentPid)})
  foreach($p in $new){if(![XacpxNativeProcess]::Alive($handles[$p.parentPid])){throw 'append parent exited or liveness unknown'}}
  foreach($p in $new){
    $parent=$nodes | Where-Object {$_.pid -eq $p.parentPid} | Select-Object -First 1
    if(!$p.creationDate -or !$p.commandLine -or !$p.executablePath){throw 'incomplete appended fingerprint'}
    if([Numerics.BigInteger]::Parse($p.creationDate) -lt [Numerics.BigInteger]::Parse($parent.creationDate)){throw 'appended child predates parent'}
    $check=OpenVerified $p $true
    if(!$check.ok){throw ('appended verification failed: '+$check.status)}
    $p.executablePath=$check.image;$handles[$p.pid]=$check.handle;[void]$nodes.Add($p);[void]$verified.Add($p.pid)
  }
  $outcomes=New-Object Collections.ArrayList
  foreach($node in $nodes){
    $h=$handles[$node.pid]
    if(![XacpxNativeProcess]::Alive($h)){[void]$outcomes.Add((Outcome $node 'already-exited'));continue}
    if(![XacpxNativeProcess]::Kill($h)){
      $code=[XacpxNativeProcess]::LastError()
      # Job-object cascade: dying child kill = confirmed exit.
      if([XacpxNativeProcess]::WaitDead($h)){$status='already-exited'}
      else{$status=if($code -eq 5){'access-denied'}else{'query-failed'}}
      [void]$outcomes.Add((Outcome $node $status));continue
    }
    $status=if([XacpxNativeProcess]::WaitDead($h)){'killed'}else{'kill-requested-unconfirmed'}
    [void]$outcomes.Add((Outcome $node $status))
  }
  $rootOutcome=($outcomes | Where-Object {$_.target.pid -eq $root.pid} | Select-Object -First 1).outcome
  Write-Output (Result $rootOutcome $outcomes)
} catch {
  $outcomes=@($nodes | ForEach-Object {Outcome $_ 'query-failed'})
  Write-Output (Result 'query-failed' $outcomes)
} finally {
  foreach($h in $handles.Values){[XacpxNativeProcess]::Close($h)}
}
`;
