import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, win32 } from "node:path";

export type AcpxCommandSource = "config" | "bundled" | "PATH";

interface ResolveAcpxCommandOptions {
  configuredCommand?: string;
  platform?: NodeJS.Platform;
  resolvePackageJson?: (id: string) => string;
  readPackageJson?: (path: string) => { version?: string; bin?: string | Record<string, string> };
}

export interface AcpxCommandMetadata {
  command: string;
  source: AcpxCommandSource;
  explanation: string;
  /** Installed bundled manifest only; never inferred from a custom/PATH command. */
  packageVersion?: string;
}

const require = createRequire(import.meta.url);

export function resolveAcpxCommand(options: ResolveAcpxCommandOptions = {}): string {
  return resolveAcpxCommandMetadata(options).command;
}

export function resolveAcpxCommandMetadata(options: ResolveAcpxCommandOptions = {}): AcpxCommandMetadata {
  if (options.configuredCommand) {
    return {
      command: options.configuredCommand,
      source: "config",
      explanation: "transport.command is set, so the configured command wins.",
    };
  }

  const platform = options.platform ?? process.platform;
  const resolvePackageJson =
    options.resolvePackageJson ?? ((id: string) => require.resolve(id));
  const readPackageJson =
    options.readPackageJson ??
    ((path: string) => JSON.parse(readFileSync(path, "utf8")) as { version?: string; bin?: string | Record<string, string> });

  try {
    const packageJsonPath = resolvePackageJson("acpx/package.json");
    const pkg = readPackageJson(packageJsonPath);
    const pathApi = platform === "win32" ? win32 : posix;
    const packageDir = pathApi.dirname(packageJsonPath);
    const binPath =
      typeof pkg.bin === "string"
        ? pkg.bin
        : pkg.bin && typeof pkg.bin.acpx === "string"
          ? pkg.bin.acpx
          : null;

    if (binPath) {
      return {
        command: pathApi.resolve(packageDir, binPath),
        source: "bundled",
        explanation: "transport.command is unset, so the bundled acpx dependency is used.",
        ...(typeof pkg.version === "string" ? { packageVersion: pkg.version } : {}),
      };
    }
  } catch {
    // Fall back to PATH resolution below.
  }

  return {
    command: "acpx",
    source: "PATH",
    explanation: "transport.command is unset and no bundled acpx was found, so PATH is the fallback.",
  };
}
