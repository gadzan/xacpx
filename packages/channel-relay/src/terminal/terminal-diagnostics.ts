/**
 * Read-only RMUX terminal diagnostics for `xacpx doctor` (spec §19).
 * Never kills, adopts, or mutates registry/owner identity.
 */
import { accessSync, constants } from "node:fs";

import { homedir } from "node:os";
import { join } from "node:path";

import { coreHomeDir } from "xacpx/plugin-api";

import type { RelayTerminalConfig } from "../config.js";
import { parseRelayTerminalConfig } from "../config.js";
import { InMemoryRmuxDriver } from "./in-memory-rmux-driver.js";
import type { RmuxTerminalDriver } from "./rmux-driver.js";
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
  /** Override driver factory (tests). Default: InMemoryRmuxDriver. */
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

  // Explicit binary paths must exist when configured (Task 27 packages fill the
  // default resolver; until then missing paths fail closed).
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
      suggestion: "restart the daemon within ownerLeaseTtlSeconds so adopt/reap can finish; do not hand-delete registry files",
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

  const driver = input.createDriver?.() ?? new InMemoryRmuxDriver();
  let bridgeVersion: string | null = null;
  let rmuxWireVersion: string | null = null;
  let capabilities: string[] = [];
  try {
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
  }

  if (bridgeVersion?.includes("fake") || rmuxWireVersion?.includes("fake")) {
    findings.push({
      level: "warn",
      code: "terminal-sidecar-unpacked",
      message:
        "terminal backend is using the in-memory / unpackaged RMUX driver; real sidecar platform packages are not installed",
      suggestion:
        "install channel-relay platform optional packages (Task 27) or set absolute terminal.bridgeCommand/rmuxCommand",
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
