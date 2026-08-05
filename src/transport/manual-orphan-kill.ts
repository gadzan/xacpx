import { spawn } from "node:child_process";

import { OrphanRegistry, type OwnerRecord, type ResidualRecord } from "./orphan-registry";

export interface ManualOrphanKillResult {
  attempted: number;
  killed: number;
  retained: number;
}

export async function killWindowsOrphansWithConfirmation(input: {
  runtimeDir: string;
  confirmed: boolean;
  platform?: NodeJS.Platform;
  registry?: OrphanRegistry;
  runTaskkill?: (pid: number) => Promise<boolean>;
}): Promise<ManualOrphanKillResult> {
  if (!input.confirmed) throw new Error("manual orphan kill requires --confirm");
  if ((input.platform ?? process.platform) !== "win32") throw new Error("manual orphan kill is Windows-only");
  const registry = input.registry ?? new OrphanRegistry(input.runtimeDir);
  await registry.initialize();
  const owners = await registry.readCategory("owners");
  const residuals = await registry.readCategory("residuals");
  if (!owners || !residuals) throw new Error("orphan registry is unreadable; refusing manual kill");
  const runTaskkill = input.runTaskkill ?? defaultTaskkill;
  let killed = 0;
  for (const { filename, record } of owners) {
    if (await runTaskkill((record as OwnerRecord).pid)) {
      await registry.deleteOwner(filename);
      killed += 1;
    }
  }
  for (const { filename, record } of residuals) {
    if (await runTaskkill((record as ResidualRecord).pid)) {
      await registry.deleteResidual(filename);
      killed += 1;
    }
  }
  const attempted = owners.length + residuals.length;
  return { attempted, killed, retained: attempted - killed };
}

async function defaultTaskkill(pid: number): Promise<boolean> {
  return await new Promise((resolve) => {
    // This is deliberately the sole unverified taskkill path in production and
    // is reachable only through the explicit `orphans kill --confirm` command.
    const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}
