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

export interface WindowsProcessIdentity {
  pid: number;
  creationDate: string;
  executablePath: string;
}

interface WorkerResponse {
  rootOutcome: unknown;
  outcomes: unknown;
}

export interface WindowsProcessWorkerOptions {
  workerDeadlineMs?: number;
  runWorker?: (request: WindowsWorkerRequest, deadlineMs: number) => Promise<unknown>;
}

type WindowsWorkerRequest = { action: "terminate-tree"; root: BatchTarget } | { action: "identity"; pid: number };

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
  if (item.commandLine !== undefined && typeof item.commandLine !== "string") return null;
  if (item.executablePath !== undefined && typeof item.executablePath !== "string") return null;
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
      options.workerDeadlineMs ?? 15_000,
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
    const item = value as Record<string, unknown>;
    if (item.pid !== pid || parseCanonicalFileTime(item.creationDate) === null || typeof item.executablePath !== "string" || !item.executablePath) {
      return null;
    }
    return { pid, creationDate: String(item.creationDate), executablePath: item.executablePath };
  } catch {
    return null;
  }
}

async function runPowerShellWorker(request: WindowsWorkerRequest, deadlineMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Windows process worker timed out"));
    }, deadlineMs);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0 ? finish() : finish(new Error(`Windows process worker failed (${code}): ${stderr}`)));
    child.stdin.end(WINDOWS_TREE_WORKER_SCRIPT);
  });
}

// One PowerShell process owns every verified handle from identity check through
// termination. No verified PID is ever handed to Stop-Process/taskkill later.
const WINDOWS_TREE_WORKER_SCRIPT = String.raw`
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
  if($watch.ElapsedMilliseconds -gt 3000){throw 'CIM enumeration exceeded 3 seconds'}
  return $items
}
function OpenVerified($node, $cim) {
  $h=[XacpxNativeProcess]::Open([uint32]$node.pid)
  if($h -eq [IntPtr]::Zero){return @{ok=$false;status=($(if([XacpxNativeProcess]::LastError() -eq 5){'access-denied'}else{'already-exited'}));handle=$h}}
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
if($request.action -eq 'identity'){
  $h=[XacpxNativeProcess]::Open([uint32]$request.pid)
  if($h -eq [IntPtr]::Zero){Write-Output 'null';exit 0}
  try {
    $creation=[XacpxNativeProcess]::Creation($h);$image=[XacpxNativeProcess]::Image($h)
    if(!$creation -or !$image){Write-Output 'null';exit 0}
    Write-Output (@{pid=[int]$request.pid;creationDate=$creation;executablePath=$image} | ConvertTo-Json -Compress)
    exit 0
  } finally {[XacpxNativeProcess]::Close($h)}
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
  # Exactly one append enumeration. Only children whose parent was already
  # verified before this pass are accepted; no post-kill enumeration exists.
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
    if(![XacpxNativeProcess]::Kill($h)){$status=if([XacpxNativeProcess]::LastError() -eq 5){'access-denied'}else{'query-failed'};[void]$outcomes.Add((Outcome $node $status));continue}
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
