import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";

export interface ResolveNodeExecutableOptions {
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function isNodeName(path: string): boolean {
  return /^(?:node|node\.exe)$/i.test(basename(path));
}

function isBunName(path: string): boolean {
  return /^(?:bun|bun\.exe)$/i.test(basename(path));
}

async function validateNodeCandidate(candidate: string, platform: NodeJS.Platform): Promise<string | null> {
  if (!isAbsolute(candidate) || !isNodeName(candidate) || isBunName(candidate)) return null;
  try {
    const canonical = await realpath(candidate);
    if (!isNodeName(canonical) || isBunName(canonical) || !(await stat(canonical)).isFile()) return null;
    if (platform !== "win32") await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

export async function resolveStableNodeExecutable(options: ResolveNodeExecutableOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const runningUnderBun = isBunName(execPath);
  const direct = runningUnderBun ? null : await validateNodeCandidate(execPath, platform);
  if (direct) return direct;
  const env = options.env ?? process.env;
  const executable = platform === "win32" ? "node.exe" : "node";
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const resolved = await validateNodeCandidate(join(directory, executable), platform);
    if (resolved) return resolved;
  }
  throw new Error(runningUnderBun
    ? "Bun cannot be used as the managed adapter Node executable and no Node executable was found"
    : "Unable to resolve a stable absolute Node executable");
}
