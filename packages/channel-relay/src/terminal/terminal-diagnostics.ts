/**
 * Read-only RMUX terminal diagnostics for `xacpx doctor` (spec §19).
 * Never kills or mutates registry/owner identity.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { homedir } from "node:os";
import { join } from "node:path";

import { coreHomeDir } from "xacpx/plugin-api";

import type { RelayTerminalConfig } from "../config.js";
import { parseRelayTerminalConfig } from "../config.js";
import type { RmuxTerminalDriver } from "./rmux-driver.js";
import {
  resolveRmuxBinaries,
  RmuxBinaryUnavailableError,
  RMUX_BUNDLED_VERSION,
} from "./resolve-rmux-binaries.js";
import { createProductionTerminalDriver } from "./rmux-sidecar-supervisor.js";
import { TerminalRegistryStore } from "./terminal-registry-store.js";

function defaultRegistryDir(): string {
  return join(coreHomeDir(process.env.HOME ?? homedir()), "relay");
}

/** Generic finding shape — core presents these without understanding RMUX. */
export type ChannelDoctorFindingLevel = "ok" | "warn" | "error" | "skip";

export interface ChannelDoctorFinding {
  level: ChannelDoctorFindingLevel;
  /** Stable machine-readable code (e.g. `terminal-disabled`). */
  code: string;
  message: string;
  suggestion?: string;
  /** Safe scalar metadata only — never terminal bytes, credentials, or full cwd. */
  details?: Record<string, string | number | boolean | null>;
}

export interface DiagnoseRelayTerminalInput {
  /** Raw `channels[].options` (or already-parsed terminal block via `terminal`). */
  options?: Record<string, unknown>;
  /** Override registry dir (tests). Default: ~/.xacpx/relay */
  registryDir?: string;
  /** Override driver factory (tests). Default: production sidecar. */
  createDriver?: () => RmuxTerminalDriver;
  now?: () => number;
}

function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the resolved RMUX binary's version via `rmux -V`. Doctor is an
 * explicitly-invoked diagnostics path (not terminal runtime startup), so a
 * short-lived fork here is acceptable. Never spawns a daemon: `-V` prints and
 * exits, and SDK daemon-start env vars are scrubbed so a misbehaving binary
 * cannot start anything under the hood.
 * Exported for unit tests; doctor treats probe failure (null actualVersion)
 * as a distinct WARN state, never as healthy.
 */
export function probeRmuxVersion(rmuxCommand: string): {
  actualVersion: string | null;
  probeError: string | null;
} {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RMUX_SDK_") || key.startsWith("RMUX_")) delete env[key];
  }
  try {
    const probe = spawnSync(rmuxCommand, ["-V"], {
      encoding: "utf8",
      timeout: 8_000,
      env,
    });
    const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    // Expected output like `rmux 0.10.0`.
    const match = out.match(/^rmux\s+v?([0-9]+\.[0-9]+\.[0-9]+)/);
    if (probe.error) {
      return { actualVersion: null, probeError: `spawn failed: ${probe.error.message}` };
    }
    if (probe.status !== 0) {
      return {
        actualVersion: null,
        probeError: `rmux -V exited ${probe.status}`,
      };
    }
    if (!match) {
      return {
        actualVersion: null,
        probeError: `unexpected rmux -V output: ${JSON.stringify(out.slice(0, 60))}`,
      };
    }
    return { actualVersion: match[1]!, probeError: null };
  } catch (err) {
    return {
      actualVersion: null,
      probeError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Strip home-dir prefixes so doctor output never echoes full user paths. */
export function redactPathForDoctor(path: string): string {
  const home = process.env.HOME ?? "";
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  // Keep only the last two path segments.
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

export async function diagnoseRelayTerminal(
  input: DiagnoseRelayTerminalInput = {},
): Promise<ChannelDoctorFinding[]> {
  const findings: ChannelDoctorFinding[] = [];
  let terminal: RelayTerminalConfig;
  try {
    terminal = parseRelayTerminalConfig(input.options?.terminal);
  } catch (err) {
    return [
      {
        level: "error",
        code: "terminal-config-invalid",
        message: err instanceof Error ? err.message : "invalid terminal options",
        suggestion: "fix channels[].options.terminal against docs/config-reference.md",
      },
    ];
  }

  if (!terminal.enabled) {
    return [
      {
        level: "skip",
        code: "terminal-disabled",
        message: "relay terminal backend is disabled (default); no RMUX health check",
      },
    ];
  }

  // Explicit binary paths must exist when configured.
  for (const [key, value] of [
    ["bridgeCommand", terminal.bridgeCommand],
    ["rmuxCommand", terminal.rmuxCommand],
  ] as const) {
    if (typeof value === "string" && value.length > 0 && !pathExists(value)) {
      findings.push({
        level: "error",
        code: "terminal-artifact-missing",
        message: `configured terminal.${key} is missing`,
        suggestion: `install the matching platform binary or unset terminal.${key}`,
        details: { key, path: redactPathForDoctor(value) },
      });
    }
  }

  if (!input.createDriver) {
    try {
      const resolved = resolveRmuxBinaries({
        bridgeCommand: terminal.bridgeCommand,
        rmuxCommand: terminal.rmuxCommand,
      });
      const rmuxProbe = resolved.rmuxCommand
        ? probeRmuxVersion(resolved.rmuxCommand)
        : { actualVersion: null, probeError: null };
      // Three states: probe failed (unknown) ≠ version mismatch ≠ healthy.
      const mismatch =
        rmuxProbe.actualVersion !== null &&
        rmuxProbe.actualVersion !== RMUX_BUNDLED_VERSION;
      const probeFailed = rmuxProbe.probeError !== null;
      findings.push({
        level: probeFailed || mismatch ? "warn" : "ok",
        code: probeFailed
          ? "terminal-rmux-version-probe-failed"
          : mismatch
            ? "terminal-binaries-resolved-mismatch"
            : "terminal-binaries-resolved",
        message: probeFailed
          ? `RMUX version probe failed (${rmuxProbe.probeError}); run rmux -V manually to verify the resolved binary`
          : mismatch
            ? `RMUX version mismatch: expected ${RMUX_BUNDLED_VERSION}, resolved ${rmuxProbe.actualVersion} from ${resolved.source.rmux}`
            : "RMUX bridge + daemon binaries resolved",
        ...(probeFailed
          ? {
              suggestion:
                "run `rmux -V` on the resolved binary (`${resolved.rmuxCommand}`) or re-install the channel-relay platform optional package",
            }
          : mismatch
            ? {
                suggestion:
                  resolved.source.rmux === "platform-package"
                    ? "bundled RMUX reports the wrong version — re-install the channel-relay platform optional package"
                    : resolved.source.rmux === "config"
                      ? "terminal.rmuxCommand points at a stale RMUX; unset it (the bundled 0.10.x is preferred) or point it at RMUX 0.10.x"
                      : "machine-local RMUX (PATH or ~/.local/libexec/rmux) shadows the bundled 0.10.x; reinstall the channel-relay platform optional package",
              }
            : {}),
        details: {
          bridgeSource: resolved.source.bridge,
          bridgePath: redactPathForDoctor(resolved.bridgeCommand),
          rmuxExpectedVersion: RMUX_BUNDLED_VERSION,
          ...(resolved.source.rmux
            ? { rmuxSource: resolved.source.rmux }
            : {}),
          ...(resolved.rmuxCommand
            ? { rmuxPath: redactPathForDoctor(resolved.rmuxCommand) }
            : {}),
          ...(rmuxProbe.actualVersion !== null
            ? { rmuxActualVersion: rmuxProbe.actualVersion }
            : {}),
          ...(rmuxProbe.probeError ? { rmuxVersionProbeError: rmuxProbe.probeError } : {}),
        },
      });
      if (!resolved.rmuxCommand) {
        findings.push({
          level: "warn",
          code: "terminal-rmux-daemon-unresolved",
          message:
            "RMUX daemon binary not found beside the bridge, in ~/.local/libexec/rmux, or on PATH; the sidecar's SDK will try its own defaults and the terminal will fail closed without capabilities",
          suggestion:
            "install @ganglion/xacpx-channel-relay with its platform optional package (bundles RMUX 0.10.x) or set absolute channels[].options.terminal.rmuxCommand",
        });
      }
    } catch (err) {
      if (err instanceof RmuxBinaryUnavailableError) {
        findings.push({
          level: "error",
          code: "terminal-artifact-missing",
          message: err.message,
          suggestion:
            "install channel-relay platform optional packages or set absolute terminal.bridgeCommand/rmuxCommand",
        });
      }
    }
  }

  const registryDir = input.registryDir ?? defaultRegistryDir();
  const registry = new TerminalRegistryStore({ dir: registryDir });
  try {
    await registry.load();
  } catch (err) {
    findings.push({
      level: "error",
      code: "terminal-registry-corrupt",
      message: `terminal registry could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      suggestion:
        "do not delete owner/registry by hand; restart the daemon so reconciler/lease TTL can reclaim, or restore from backup",
      details: { registryDir: redactPathForDoctor(registryDir) },
    });
    return findings;
  }

  const snap = registry.getSnapshot();
  const terminals = Object.values(snap.terminals);
  const live = terminals.filter((t) => t.state === "live").length;
  const creating = terminals.filter((t) => t.state === "creating").length;
  const reaping = terminals.filter((t) => t.state === "reaping").length;
  const now = input.now?.() ?? Date.now();
  let oldestLastInputAgeMs: number | null = null;
  for (const t of terminals) {
    const ts = Date.parse(t.lastInputAt);
    if (!Number.isFinite(ts)) continue;
    const age = Math.max(0, now - ts);
    if (oldestLastInputAgeMs === null || age > oldestLastInputAgeMs) {
      oldestLastInputAgeMs = age;
    }
  }

  if (snap.inventoryUncertain) {
    findings.push({
      level: "warn",
      code: "terminal-inventory-uncertain",
      message:
        "terminal owner/registry evidence is inconsistent; reconciler stays fail-closed until the next healthy pass",
      suggestion: "restart xacpx so reconciler can reap leftover names; ownerLeaseTtlSeconds bounds hard-crash orphan lifetime (not a restart-adoption window)",
      details: {
        installationIdPresent: snap.installationId.length > 0,
        live,
        creating,
        reaping,
      },
    });
  }

  if (reaping > 0) {
    findings.push({
      level: "warn",
      code: "terminal-cleanup-pending",
      message: `${reaping} terminal resource(s) are in durable reaping (cleanup-pending)`,
      suggestion:
        "leave registry/owner identity intact; reconciler retries kill, and owner lease TTL bounds orphan lifetime",
      details: { live, creating, reaping, oldestLastInputAgeMs },
    });
  }

  let bridgeVersion: string | null = null;
  let rmuxWireVersion: string | null = null;
  let capabilities: string[] = [];
  let dispose: (() => Promise<void>) | undefined;
  try {
    let driver: RmuxTerminalDriver;
    if (input.createDriver) {
      driver = input.createDriver();
    } else {
      const prod = await createProductionTerminalDriver(terminal);
      driver = prod.driver;
      dispose = () => prod.supervisor.stop();
    }
    const diag = await driver.diagnostics();
    bridgeVersion = diag.bridgeVersion;
    rmuxWireVersion = diag.rmuxWireVersion;
    capabilities = [...diag.capabilities];
  } catch (err) {
    findings.push({
      level: "error",
      code: "terminal-rmux-unavailable",
      message: `RMUX driver diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: "verify bridge/RMUX binaries and platform packages, then restart the daemon",
    });
  } finally {
    if (dispose) {
      try {
        await dispose();
      } catch {
        // ignore
      }
    }
  }

  if (bridgeVersion?.includes("fake") || rmuxWireVersion?.includes("fake")) {
    findings.push({
      level: "warn",
      code: "terminal-sidecar-unpacked",
      message:
        "terminal backend is using the in-memory / unpackaged RMUX driver; real sidecar platform packages are not installed",
      suggestion:
        "install channel-relay platform optional packages or set absolute terminal.bridgeCommand/rmuxCommand",
      details: { bridgeVersion, rmuxWireVersion },
    });
  }

  if (findings.every((f) => f.level === "ok" || f.level === "skip") || findings.length === 0) {
    findings.push({
      level: "ok",
      code: "terminal-healthy",
      message: "relay RMUX terminal registry and driver diagnostics look healthy",
      details: {
        live,
        creating,
        reaping,
        oldestLastInputAgeMs,
        bridgeVersion,
        rmuxWireVersion,
        capabilityCount: capabilities.length,
        installationIdPresent: snap.installationId.length > 0,
        // Live viewer/controller counts require a running daemon; doctor is offline.
        liveViewerCounts: "unavailable-offline",
        lastReconcile: "n/a-read-only",
      },
    });
  } else {
    // Always attach a compact snapshot detail on the first non-skip finding.
    const first = findings[0]!;
    first.details = {
      ...(first.details ?? {}),
      live,
      creating,
      reaping,
      oldestLastInputAgeMs,
      bridgeVersion,
      rmuxWireVersion,
      capabilityCount: capabilities.length,
    };
  }

  return findings;
}
