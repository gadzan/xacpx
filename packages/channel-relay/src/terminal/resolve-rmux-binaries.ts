// Resolve RMUX bridge + daemon binaries for process-owned terminal mode.
//
// Bridge order: explicit config absolute path → platform package optional dep → PATH.
// RMUX order:   explicit config absolute path → beside selected bridge (bundled
//               platform-package RMUX when the bridge came from a platform
//               package) → legacy managed helper ~/.local/libexec/rmux → PATH.
//
// The platform packages bundle a pinned RMUX whose version matches the native
// bridge's rmux-sdk pin (`RMUX_BUNDLED_VERSION` below), so a machine-local
// stale RMUX on PATH or in ~/.local/libexec/rmux must never shadow the bundled
// binary — that was the Windows field bug (PATH WinGet rmux 0.9.0 vs bridge
// rmux-sdk 0.10.0). Explicit terminal.rmuxCommand always wins.
//
// Never downloads latest; never path-depends on a workspace `../rmux`.

import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * Pinned RMUX release bundled into the platform packages and the rmux-sdk pin
 * of the native bridge. Must stay in lock-step with:
 *   - scripts/rmux-release.mjs (pack-time artifact download + SHA checks)
 *   - packages/channel-relay/native/rmux-bridge/Cargo.toml (rmux-sdk = "=0.10.0")
 * verify-publish.mjs cross-checks all three.
 */
export const RMUX_BUNDLED_VERSION = "0.10.0";

export interface ResolvedRmuxBinaries {
  bridgeCommand: string;
  rmuxCommand?: string;
  source: {
    bridge: "config" | "platform-package" | "path";
    /** Where the RMUX daemon binary came from. */
    rmux?:
      | "config"
      | "platform-package"
      | "beside-bridge"
      | "managed-helper"
      | "path";
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

/** Release-layout + PATH names the RMUX SDK looks for as the daemon helper. */
const DAEMON_NAMES = ["rmux-daemon.exe", "rmux.exe", "rmux-daemon", "rmux"] as const;

function firstExecutable(paths: readonly string[]): string | undefined {
  for (const candidate of paths) {
    if (existsExecutable(candidate)) return candidate;
  }
  return undefined;
}

function resolveDaemonHelper(homeDir: string): string | undefined {
  const dir = join(homeDir, ".local", "libexec", "rmux");
  return firstExecutable(DAEMON_NAMES.map((name) => join(dir, name)));
}

function resolveDaemonBesideBridge(bridgeCommand: string): string | undefined {
  return firstExecutable(DAEMON_NAMES.map((name) => join(dirname(bridgeCommand), name)));
}

function resolveDaemonOnPath(pathEnv: string): string | undefined {
  return which("rmux-daemon", pathEnv) ?? which("rmux", pathEnv);
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
  /** Override `os.homedir()` (tests). */
  homeDir?: string;
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
    // Bundled RMUX beside the selected bridge is the production default: the
    // platform package ships `bin/rmux[.exe]` pinned to RMUX_BUNDLED_VERSION.
    // Only fall back to the legacy managed helper, then PATH, when no bundled
    // RMUX exists — so a stale ~/.local/libexec/rmux or PATH RMUX never
    // shadows an up-to-date platform package.
    const beside = resolveDaemonBesideBridge(bridgeCommand);
    const helper = resolveDaemonHelper(input.homeDir ?? homedir());
    const onPath = resolveDaemonOnPath(input.pathEnv ?? process.env.PATH ?? "");
    rmuxCommand = beside ?? helper ?? onPath;
    if (rmuxCommand) {
      rmuxSource = beside
        ? bridgeSource === "platform-package"
          ? "platform-package"
          : "beside-bridge"
        : helper
          ? "managed-helper"
          : "path";
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