import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PosixProcessIdentity {
  pid: number;
  startedAtMs: number;
}

export type PosixProcessIdentityProbe =
  | { status: "found"; identity: PosixProcessIdentity }
  | { status: "missing" | "unavailable" };

interface ProbePosixProcessIdentityOptions {
  runPs?: (pid: number) => Promise<string | null>;
}

export async function probePosixProcessIdentity(
  pid: number,
  options: ProbePosixProcessIdentityOptions = {},
): Promise<PosixProcessIdentityProbe> {
  try {
    const output = await (options.runPs ?? defaultRunPs)(pid);
    if (output === null) return { status: "missing" };
    const startedAtMs = Date.parse(output.trim());
    if (!Number.isFinite(startedAtMs)) return { status: "unavailable" };
    return { status: "found", identity: { pid, startedAtMs } };
  } catch {
    return { status: "unavailable" };
  }
}

async function defaultRunPs(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        env: { ...process.env, LC_ALL: "C" },
        timeout: 5_000,
        maxBuffer: 4_096,
      },
    );
    return stdout;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") return null;
    throw error;
  }
}
