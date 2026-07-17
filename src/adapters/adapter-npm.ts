import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { MANAGED_ADAPTERS, type ManagedAdapterId } from "./adapter-catalog";
import {
  AdapterRegistryPackageNotFoundError,
  adapterRegistryNpmArgs,
  effectiveAdapterRegistry,
} from "./adapter-registry";

export async function getAdapterNpmVersion(
  id: ManagedAdapterId,
  version: string | undefined,
  registry: string,
): Promise<string | null> {
  const adapter = MANAGED_ADAPTERS[id];
  const packageSpec = version ? `${adapter.packageName}@${version}` : adapter.packageName;
  const normalizedRegistry = effectiveAdapterRegistry(registry);
  const npm = resolveNpmCommand();
  const result = await runCapture(npm.command, [
    ...npm.prefixArgs,
    "view",
    packageSpec,
    "version",
    "--json",
    ...adapterRegistryNpmArgs(normalizedRegistry),
  ]);
  if (result.code !== 0) {
    if (version && /no match.*\bversion\b|no matching version|notarget/i.test(result.stderr)) {
      return null;
    }
    if (/\bE404\b|\b404\s+Not\s+Found\b/i.test(result.stderr)) {
      throw new AdapterRegistryPackageNotFoundError(normalizedRegistry);
    }
    return null;
  }
  const raw = result.stdout.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return raw.replace(/^"|"$/g, "") || null;
  }
}

export function resolveNpmCommand(): { command: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { command: "npm", prefixArgs: [] };

  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCli = candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && /npm-cli\.(?:c?js)$/i.test(candidate) && existsSync(candidate));
  if (!npmCli) throw new Error("cannot locate npm-cli.js for shell-free adapter operations");
  return { command: process.execPath, prefixArgs: [npmCli] };
}

async function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
