import { access } from "node:fs/promises";

import { OrphanRegistry, type LaunchIntentRecord, type OwnerRecord } from "../../transport/orphan-registry";
import type { DoctorCheckResult } from "../doctor-types";

export interface OrphanCheckOptions {
  runtimeDir: string;
  platform?: NodeJS.Platform;
  now?: () => number;
  registry?: OrphanRegistry;
  pathExists?: (path: string) => Promise<boolean>;
}

export async function checkOrphans(options: OrphanCheckOptions): Promise<DoctorCheckResult> {
  if ((options.platform ?? process.platform) !== "win32") {
    return { id: "orphans", label: "Windows orphans", severity: "skip", summary: "Windows orphan registry is not used on this platform" };
  }
  const registry = options.registry ?? new OrphanRegistry(options.runtimeDir);
  const exists = options.pathExists ?? defaultPathExists;
  if (!await exists(registry.root)) {
    return { id: "orphans", label: "Windows orphans", severity: "pass", summary: "no durable orphan evidence" };
  }
  const intents = await registry.readCategory("intents");
  const owners = await registry.readCategory("owners");
  const residuals = await registry.readCategory("residuals");
  if (!intents || !owners || !residuals) {
    return {
      id: "orphans",
      label: "Windows orphans",
      severity: "warn",
      summary: "orphan registry is unreadable; automatic cleanup is degraded",
      suggestions: ["inspect runtime/orphans and retry xacpx doctor; do not delete records while the daemon is active"],
    };
  }
  const now = options.now?.() ?? Date.now();
  const staleIntents = intents.filter(({ record }) => now - Date.parse((record as LaunchIntentRecord).createdAt) > 60_000).length;
  const unverifiableOwners = owners.filter(({ record }) => (record as OwnerRecord).fingerprint === null).length;
  const total = intents.length + owners.length + residuals.length;
  if (total === 0) {
    return { id: "orphans", label: "Windows orphans", severity: "pass", summary: "no durable orphan evidence" };
  }
  return {
    id: "orphans",
    label: "Windows orphans",
    severity: "warn",
    summary: `${total} durable orphan record(s) remain`,
    details: [
      `intents: ${intents.length} (${staleIntents} older than 60s)`,
      `owners: ${owners.length} (${unverifiableOwners} without a killable fingerprint)`,
      `residuals: ${residuals.length}`,
    ],
    suggestions: ["let the daemon reconciliation sweep retry; use a confirmed manual orphan kill only after reviewing process identity"],
  };
}

async function defaultPathExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}
