import { spawn, type ChildProcess } from "node:child_process";

/**
 * The supervisor joins a fresh kill-on-close Job before creating the worker.
 * It holds the worker tree's persistent Job handle. A transient query handle can delay kill-on-close until it closes. Supervisor exit closes its handle, and the host waits for an empty or absent Job before releasing ownership.
 */

export interface WindowsSupervisorRequest {
  /** Named Job, `Local\Xacpx-RW-<generation>` — recovery opens it by name. */
  jobName: string;
  /** Node executable path (host's process.execPath). */
  nodePath: string;
  /** Worker entry script. */
  entryPath: string;
  /** Working directory for the worker. */
  cwd: string;
  /** Extra env over the inherited block (spawnEnv deltas). */
  extraEnv?: Record<string, string>;
}

export interface WindowsSupervisorHello {
  workerPid: number;
  supervisorPid: number;
  jobName: string;
  inJob: boolean;
}

export const WINDOWS_SUPERVISOR_HELLO_PREFIX = "XACPX_JOB_HELLO ";

export function parseSupervisorHello(line: string): WindowsSupervisorHello | null {
  if (!line.startsWith(WINDOWS_SUPERVISOR_HELLO_PREFIX)) return null;
  try {
    const parsed = JSON.parse(line.slice(WINDOWS_SUPERVISOR_HELLO_PREFIX.length)) as Partial<WindowsSupervisorHello>;
    if (
      typeof parsed.workerPid !== "number" || !Number.isSafeInteger(parsed.workerPid) || parsed.workerPid <= 0
      || typeof parsed.supervisorPid !== "number" || !Number.isSafeInteger(parsed.supervisorPid) || parsed.supervisorPid <= 0
      || typeof parsed.jobName !== "string" || parsed.jobName.length === 0
      || typeof parsed.inJob !== "boolean"
    ) {
      return null;
    }
    return { workerPid: parsed.workerPid, supervisorPid: parsed.supervisorPid, jobName: parsed.jobName, inJob: parsed.inJob };
  } catch {
    return null;
  }
}

export const WINDOWS_SUPERVISOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:XACPX_SUPERVISOR_REQUEST)) | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class XacpxJobSupervisor {
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long JobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetInformationJobObject(IntPtr h, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr h, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool IsProcessInJob(IntPtr proc, IntPtr h, out bool result);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  public static int LastError() { return Marshal.GetLastWin32Error(); }
  public static IntPtr CreateFreshJob(string name) {
    IntPtr handle = CreateJobObject(IntPtr.Zero, name);
    int error = Marshal.GetLastWin32Error();
    if (handle == IntPtr.Zero) throw new Win32Exception(error);
    if (error == 183) {
      CloseHandle(handle);
      throw new InvalidOperationException("Job name already exists");
    }
    return handle;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
    public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags;
    public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr original, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  static IntPtr InheritedStdio(int kind) {
    IntPtr copy;
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(kind), GetCurrentProcess(), out copy, 0, true, 2)) throw new Win32Exception();
    return copy;
  }
  public static int Run(ProcessStartInfo info, IntPtr job, string jobName, int supervisorPid) {
    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.dwFlags = 0x100;
    PROCESS_INFORMATION worker = new PROCESS_INFORMATION();
    IntPtr environment = IntPtr.Zero;
    try {
      startup.hStdInput = InheritedStdio(-10);
      startup.hStdOutput = InheritedStdio(-11);
      startup.hStdError = InheritedStdio(-12);
      ArrayList names = new ArrayList(info.EnvironmentVariables.Keys);
      names.Sort(StringComparer.OrdinalIgnoreCase);
      StringBuilder block = new StringBuilder();
      foreach (string name in names) block.Append(name).Append('=').Append(info.EnvironmentVariables[name]).Append('\0');
      block.Append('\0');
      environment = Marshal.StringToHGlobalUni(block.ToString());
      StringBuilder command = new StringBuilder("\"" + info.FileName + "\" " + info.Arguments);
      if (!CreateProcess(info.FileName, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000400, environment, info.WorkingDirectory, ref startup, out worker)) throw new Win32Exception();
    } finally {
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      if (startup.hStdInput != IntPtr.Zero) CloseHandle(startup.hStdInput);
      if (startup.hStdOutput != IntPtr.Zero) CloseHandle(startup.hStdOutput);
      if (startup.hStdError != IntPtr.Zero) CloseHandle(startup.hStdError);
    }
    try {
      bool inJob;
      if (!IsProcessInJob(worker.hProcess, job, out inJob) || !inJob) throw new InvalidOperationException("worker escaped Job containment");
      Console.Error.WriteLine("XACPX_JOB_HELLO {\"workerPid\":" + worker.dwProcessId +
        ",\"supervisorPid\":" + supervisorPid + ",\"jobName\":\"" +
        jobName.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\",\"inJob\":true}");
      Console.Error.Flush();
      if (WaitForSingleObject(worker.hProcess, 0xFFFFFFFF) != 0) throw new Win32Exception();
      uint code;
      if (!GetExitCodeProcess(worker.hProcess, out code)) throw new Win32Exception();
      return unchecked((int)code);
    } finally {
      CloseHandle(worker.hThread);
      CloseHandle(worker.hProcess);
    }
  }
}
'@
function Fail($msg) { throw [InvalidOperationException]::new($msg) }
$job = [XacpxJobSupervisor]::CreateFreshJob([string]$req.jobName)
$self = [XacpxJobSupervisor]::GetCurrentProcess()
try {
  if (-not [XacpxJobSupervisor]::SetHandleInformation($job, 1, 0)) { Fail "SetHandleInformation failed ($([XacpxJobSupervisor]::LastError()))" }
  $limits = New-Object XacpxJobSupervisor+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  # Assign the whole nested value type because PowerShell otherwise mutates a copy.
  $basicLimits = $limits.BasicLimitInformation
  $basicLimits.LimitFlags = 0x2000
  $limits.BasicLimitInformation = $basicLimits
  $size = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  if (-not [XacpxJobSupervisor]::SetInformationJobObject($job, 9, [ref]$limits, $size)) { Fail "SetInformationJobObject failed ($([XacpxJobSupervisor]::LastError()))" }
  if (-not [XacpxJobSupervisor]::AssignProcessToJobObject($job, $self)) { Fail "AssignProcessToJobObject failed ($([XacpxJobSupervisor]::LastError()))" }
  $inJob = $false
  if (-not [XacpxJobSupervisor]::IsProcessInJob($self, $job, [ref]$inJob)) { Fail "IsProcessInJob failed ($([XacpxJobSupervisor]::LastError()))" }
  if (-not $inJob) { Fail "supervisor not in job after self-assign" }
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = [string]$req.nodePath
  $psi.Arguments = '"{0}"' -f [string]$req.entryPath
  $psi.WorkingDirectory = [string]$req.cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($req.extraEnv) { foreach ($p in $req.extraEnv.PSObject.Properties) { $psi.EnvironmentVariables[$p.Name] = [string]$p.Value } }
  $code = [XacpxJobSupervisor]::Run($psi, $job, [string]$req.jobName, $PID)
  exit $code
} catch {
  [Console]::Error.WriteLine("XACPX_JOB_FATAL $($_.Exception.Message)")
  exit 1
} finally { [void][XacpxJobSupervisor]::CloseHandle($job) }
} catch {
  [Console]::Error.WriteLine("XACPX_JOB_FATAL $($_.Exception.Message)")
  exit 1
}
`;

export interface SupervisorSpawnOptions {
  spawnFn?: (command: string, args: string[], options: object) => ChildProcess;
  requestEnvName?: string;
}

/** Spawn the supervisor via -EncodedCommand (same transport as other workers). */
export function spawnWindowsSupervisor(
  request: WindowsSupervisorRequest,
  env: Record<string, string | undefined>,
  options: SupervisorSpawnOptions = {},
): ChildProcess {
  const encodedScript = Buffer.from(WINDOWS_SUPERVISOR_SCRIPT, "utf16le").toString("base64");
  const spawnFn = options.spawnFn ?? spawn;
  return spawnFn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...env,
      [options.requestEnvName ?? "XACPX_SUPERVISOR_REQUEST"]: Buffer.from(JSON.stringify(request), "utf8").toString("base64"),
    },
  }) as ChildProcess;
}
