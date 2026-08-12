// Single-instance supervisor for the process-owned RMUX bridge child.
// Crash → fence Node requests, wait for child exit, restart once with backoff.
// Never runs two sidecars that could double-write the same RMUX names.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RelayTerminalConfig } from "../config.js";
import {
  resolveRmuxBinaries,
  type ResolvedRmuxBinaries,
} from "./resolve-rmux-binaries.js";
import { RmuxSidecarDriver } from "./rmux-sidecar-driver.js";
import type {
  RmuxCreateSessionInput,
  RmuxDiagnostics,
  RmuxInventoryEntry,
  RmuxRecoveryEvent,
  RmuxSessionHandle,
  RmuxTerminalDriver,
} from "./rmux-driver.js";
import { RmuxDriverCrashedError } from "./rmux-driver.js";

export interface RmuxSidecarSupervisorOptions {
  config: RelayTerminalConfig;
  /** Test seam — inject an already-constructed driver instead of spawning. */
  createDriver?: (binaries: ResolvedRmuxBinaries) => Promise<RmuxSidecarDriver>;
  spawnFn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  maxRestarts?: number;
  /** Invoked after the live child exits unexpectedly (before restart). */
  onChildExit?: () => void;
}

/**
 * Stable driver handle for the lifetime of a supervisor. Forwards to the
 * current live sidecar so runtime does not need to swap references on restart.
 */
export class SupervisedRmuxDriver implements RmuxTerminalDriver {
  constructor(private readonly supervisor: RmuxSidecarSupervisor) {}

  private require(): RmuxTerminalDriver {
    const driver = this.supervisor.getDriver();
    if (!driver) throw new RmuxDriverCrashedError();
    return driver;
  }

  create(input: RmuxCreateSessionInput): Promise<RmuxSessionHandle> {
    return Promise.resolve().then(() => this.require().create(input));
  }
  list(): Promise<RmuxInventoryEntry[]> {
    return Promise.resolve().then(() => this.require().list());
  }
  kill(sessionId: string): Promise<void> {
    return Promise.resolve().then(() => this.require().kill(sessionId));
  }
  input(paneId: string, bytes: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => this.require().input(paneId, bytes));
  }
  resize(paneId: string, cols: number, rows: number): Promise<void> {
    return Promise.resolve().then(() => this.require().resize(paneId, cols, rows));
  }
  recover(paneId: string): AsyncIterable<RmuxRecoveryEvent> {
    return this.require().recover(paneId);
  }
  diagnostics(): Promise<RmuxDiagnostics> {
    return Promise.resolve().then(() => this.require().diagnostics());
  }
}

export class RmuxSidecarSupervisor {
  private readonly opts: RmuxSidecarSupervisorOptions;
  private driver: RmuxSidecarDriver | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restartCount = 0;
  private starting: Promise<RmuxTerminalDriver> | null = null;
  private spawning = false;

  constructor(opts: RmuxSidecarSupervisorOptions) {
    this.opts = opts;
  }

  async start(): Promise<RmuxTerminalDriver> {
    if (this.stopped) throw new RmuxDriverCrashedError();
    if (this.driver) return this.driver;
    if (this.starting) return this.starting;
    this.starting = this.startUnlocked().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  getDriver(): RmuxTerminalDriver | null {
    return this.driver;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.driver) {
      try {
        await this.driver.shutdown();
      } catch {
        // ignore
      }
    }
    this.driver = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = null;
  }

  private async startUnlocked(): Promise<RmuxTerminalDriver> {
    if (this.spawning) throw new RmuxDriverCrashedError();
    this.spawning = true;
    try {
      if (this.opts.createDriver) {
        // Test inject path: skip filesystem binary resolution.
        const binaries: ResolvedRmuxBinaries = {
          bridgeCommand: this.opts.config.bridgeCommand ?? "injected-bridge",
          ...(this.opts.config.rmuxCommand ? { rmuxCommand: this.opts.config.rmuxCommand } : {}),
          source: { bridge: "config" },
        };
        const driver = await this.opts.createDriver(binaries);
        driver.onCrash(() => {
          // Injected drivers have no real child exit; fence immediately.
          this.driver = null;
        });
        await driver.handshake();
        this.driver = driver;
        return driver;
      }

      const binaries = resolveRmuxBinaries({
        bridgeCommand: this.opts.config.bridgeCommand,
        rmuxCommand: this.opts.config.rmuxCommand,
      });

      // Never spawn a second child while one is still attached.
      if (this.child) throw new RmuxDriverCrashedError();

      const spawnFn = this.opts.spawnFn ?? spawn;
      const env: NodeJS.ProcessEnv = { ...process.env };
      // Scrub obvious secrets from child env before injecting daemon path.
      for (const key of Object.keys(env)) {
        if (key.startsWith("XACPX_") || /token|secret|password|credential/i.test(key)) {
          delete env[key];
        }
      }
      if (binaries.rmuxCommand) {
        env.RMUX_SDK_DAEMON_BINARY = binaries.rmuxCommand;
      }

      const child = spawnFn(binaries.bridgeCommand, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      this.child = child;
      const driver = new RmuxSidecarDriver({
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: (sig) => {
          child.kill(sig);
        },
        on: (event, listener) => {
          child.on(event, listener as never);
        },
      });

      // Protocol-fatal crash kills the child; exit handler restarts. Also
      // null the driver immediately so callers fence before exit races.
      driver.onCrash(() => {
        this.driver = null;
      });

      child.on("exit", () => {
        this.child = null;
        this.driver = null;
        if (this.stopped) return;
        this.opts.onChildExit?.();
        void this.scheduleRestart();
      });

      await driver.handshake();
      this.driver = driver;
      this.restartCount = 0;
      return driver;
    } finally {
      this.spawning = false;
    }
  }

  private async scheduleRestart(): Promise<void> {
    if (this.stopped) return;
    const max = this.opts.maxRestarts ?? 5;
    if (this.restartCount >= max) return;
    this.restartCount += 1;
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const delay = Math.min(30_000, 500 * 2 ** (this.restartCount - 1));
    await sleep(delay);
    if (this.stopped || this.child || this.driver) return;
    try {
      await this.start();
    } catch {
      // leave unavailable; channel bootstrap already fail-closed without caps
    }
  }
}

export async function createProductionTerminalDriver(
  config: RelayTerminalConfig,
  opts: Omit<RmuxSidecarSupervisorOptions, "config"> = {},
): Promise<{ driver: RmuxTerminalDriver; supervisor: RmuxSidecarSupervisor }> {
  const supervisor = new RmuxSidecarSupervisor({ ...opts, config });
  await supervisor.start();
  return { driver: new SupervisedRmuxDriver(supervisor), supervisor };
}
