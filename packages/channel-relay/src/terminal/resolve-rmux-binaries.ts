// Resolve RMUX bridge + daemon binaries for process-owned terminal mode.
// Order: explicit config absolute path → platform package optional dep → PATH.
// Never downloads latest; never path-depends on a workspace `../rmux`.

import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export interface ResolvedRmuxBinaries {
  bridgeCommand: string;
  rmuxCommand?: string;
  source: {
    bridge: "config" | "platform-package" | "path";
    rmux?: "config" | "path";
  };
}

export class RmuxBinaryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RmuxBinaryUnavailableError";
  }
}

function existsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(command: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  if (isAbsolute(command) && existsExecutable(command)) return command;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsExecutable(candidate)) return candidate;
  }
  // Windows may need .exe; keep simple for now.
  if (process.platform === "win32" && !command.endsWith(".exe")) {
    return which(`${command}.exe`, pathEnv);
  }
  return undefined;
}

function platformPackageName(): string {
  const plat = process.platform;
  const arch = process.arch;
  // Optional deps land as @ganglion/xacpx-rmux-bridge-<os>-<arch>
  const os =
    plat === "darwin" ? "darwin" : plat === "linux" ? "linux" : plat === "win32" ? "win32" : plat;
  return `@ganglion/xacpx-rmux-bridge-${os}-${arch}`;
}

function resolveFromPlatformPackage(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgName = platformPackageName();
    const pkgJson = require.resolve(`${pkgName}/package.json`);
    const pkgDir = join(pkgJson, "..");
    const binName = process.platform === "win32" ? "xacpx-rmux-bridge.exe" : "xacpx-rmux-bridge";
    const candidate = join(pkgDir, "bin", binName);
    if (existsExecutable(candidate)) return candidate;
  } catch {
    // optional dep missing
  }
  return undefined;
}

export function resolveRmuxBinaries(input: {
  bridgeCommand?: string;
  rmuxCommand?: string;
  pathEnv?: string;
  /**
   * Test seam: override the platform-package lookup. Defaults to the
   * require-based detection (`resolveFromPlatformPackage`). Tests pass
   * `() => undefined` to force the PATH fallback — the production path
   * leaves this unset.
   */
  platformPackageResolver?: () => string | undefined;
}): ResolvedRmuxBinaries {
  let bridgeCommand: string | undefined;
  let bridgeSource: ResolvedRmuxBinaries["source"]["bridge"];

  if (input.bridgeCommand) {
    if (!isAbsolute(input.bridgeCommand) || !existsExecutable(input.bridgeCommand)) {
      throw new RmuxBinaryUnavailableError(
        `terminal.bridgeCommand is missing or not executable: ${input.bridgeCommand}`,
      );
    }
    bridgeCommand = input.bridgeCommand;
    bridgeSource = "config";
  } else {
    bridgeCommand = (input.platformPackageResolver ?? resolveFromPlatformPackage)();
    if (bridgeCommand) {
      bridgeSource = "platform-package";
    } else {
      bridgeCommand = which("xacpx-rmux-bridge", input.pathEnv);
      if (!bridgeCommand) {
        throw new RmuxBinaryUnavailableError(
          "xacpx-rmux-bridge not found (set terminal.bridgeCommand or install the platform optional package)",
        );
      }
      bridgeSource = "path";
    }
  }

  let rmuxCommand: string | undefined;
  let rmuxSource: ResolvedRmuxBinaries["source"]["rmux"];
  if (input.rmuxCommand) {
    if (!isAbsolute(input.rmuxCommand) || !existsExecutable(input.rmuxCommand)) {
      throw new RmuxBinaryUnavailableError(
        `terminal.rmuxCommand is missing or not executable: ${input.rmuxCommand}`,
      );
    }
    rmuxCommand = input.rmuxCommand;
    rmuxSource = "config";
  } else {
    // Prefer full daemon helper when present next to a release install.
    const helper = join(homedir(), ".local", "libexec", "rmux", "rmux");
    if (existsExecutable(helper)) {
      rmuxCommand = helper;
      rmuxSource = "path";
    } else {
      rmuxCommand = which("rmux", input.pathEnv);
      if (rmuxCommand) rmuxSource = "path";
    }
  }

  return {
    bridgeCommand,
    ...(rmuxCommand ? { rmuxCommand } : {}),
    source: {
      bridge: bridgeSource,
      ...(rmuxSource ? { rmux: rmuxSource } : {}),
    },
  };
}
