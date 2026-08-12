// One-shot maintenance cleanup for disable/remove/CLI paths (spec §12.3).
// Does not connect to the hub. Loads the durable registry even when the new
// config has terminal.enabled=false, durable-marks records reaping, then kills.
import type { SessionResourceCatalog } from "xacpx/plugin-api";
import { parseRelayTerminalConfig, type RelayTerminalConfig } from "../config.js";
import type { RmuxTerminalDriver } from "./rmux-driver.js";
import { createProductionTerminalDriver } from "./rmux-sidecar-supervisor.js";
import { TerminalRegistryStore } from "./terminal-registry-store.js";
import { DefaultRelayTerminalRuntime } from "./terminal-runtime.js";

export type RetireRelayTerminalsResult =
  | { status: "idle" }
  | { status: "terminated" }
  | { status: "cleanup-pending" };

export interface RetireRelayTerminalsInput {
  /** Directory holding terminal-owner.json / terminals.json. */
  registryDir: string;
  /**
   * Terminal knobs (idle/lease/…). `enabled` is forced true for the temporary
   * runtime so terminateAll can run; callers may pass a disabled config from
   * the surviving channel options.
   */
  terminalConfig?: RelayTerminalConfig;
  createDriver?: () => RmuxTerminalDriver;
}

const emptyCatalog: SessionResourceCatalog = {
  async resolve() {
    return null;
  },
  async list() {
    return [];
  },
  subscribe() {
    return () => {};
  },
};

/**
 * Retire every durable terminal record under `registryDir`.
 * Safe to call repeatedly; no-op when the registry is empty.
 * On RMUX kill failure, leaves reaping tombstones + owner identity
 * (`cleanup-pending`) so a later reconcile can finish.
 */
export async function retireRelayTerminals(
  input: RetireRelayTerminalsInput,
): Promise<RetireRelayTerminalsResult> {
  const registry = new TerminalRegistryStore({ dir: input.registryDir });
  await registry.load();
  const before = registry.getSnapshot();
  if (Object.keys(before.terminals).length === 0) {
    return { status: "idle" };
  }

  const base = input.terminalConfig ?? parseRelayTerminalConfig(undefined);
  // Maintenance runtime must accept terminateAll regardless of the surviving
  // channel config's enabled flag.
  const config: RelayTerminalConfig = Object.freeze({ ...base, enabled: true });

  let driver: RmuxTerminalDriver;
  let dispose: (() => Promise<void>) | undefined;
  if (input.createDriver) {
    driver = input.createDriver();
  } else {
    try {
      const prod = await createProductionTerminalDriver(config);
      driver = prod.driver;
      dispose = () => prod.supervisor.stop();
    } catch {
      // Durable-mark reaping so the next healthy sidecar pass can finish kill,
      // but do not clear the registry with a fake InMemory driver.
      for (const rec of Object.values(registry.getSnapshot().terminals)) {
        if (rec.state === "reaping") continue;
        const snap = registry.getSnapshot();
        try {
          await registry.markReaping(snap.revision, rec.terminalId, "disabled");
        } catch {
          // revision race — leave for next pass
        }
      }
      return { status: "cleanup-pending" };
    }
  }

  const runtime = new DefaultRelayTerminalRuntime({
    registry,
    driver,
    catalog: emptyCatalog,
    config,
    onViewerEvent: () => {},
  });

  try {
    await runtime.start();
    await runtime.terminateAll("disabled");
    // Drain anything left in reaping (prior crash window / kill timeout).
    await runtime.reconcileOnce();
  } finally {
    // stop() also terminates in process-owned mode; already-reaped records are fine.
    await runtime.stop();
    if (dispose) {
      try {
        await dispose();
      } catch {
        // ignore
      }
    }
  }

  const after = registry.getSnapshot();
  const remaining = Object.values(after.terminals);
  if (remaining.length === 0) return { status: "terminated" };
  return { status: "cleanup-pending" };
}
