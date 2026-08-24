// Single-instance supervisor for the process-owned RMUX bridge child.
// Crash → fence Node requests, wait for child exit, restart once with backoff.
// Never runs two sidecars that could double-write the same RMUX names.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

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
  /** Sidecar RPC timeout (handshake included). Production keeps the driver default. */
  requestTimeoutMs?: number;
  /**
   * How long a child must stay alive after handshake before `restartCount`
   * resets. Handshake-ok followed by an immediate crash must not refill the
   * restart budget.
   */
  stableAfterMs?: number;
  /** Invoked after the live child exits unexpectedly (before restart). */
  onChildExit?: () => void;
  /** Test seam; production mints a fresh label for every native sidecar spawn. */
  endpointLabelFactory?: () => string;
}

const emptyRmuxConfigPath = (): string =>
  process.platform === "win32" ? "NUL" : "/dev/null";
const newEndpointLabel = (): string =>
  `xacpx-relay-${process.pid}-${randomUUID().replaceAll("-", "")}`;

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
  recover(paneId: string, signal?: AbortSignal): AsyncIterable<RmuxRecoveryEvent> {
    return this.require().recover(paneId, signal);
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
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResolution: ResolvedRmuxBinaries | null = null;

  constructor(opts: RmuxSidecarSupervisorOptions) {
    this.opts = opts;
  }

  /** Last resolved bridge/RMUX binaries — for bootstrap-failure diagnostics. */
  getResolution(): ResolvedRmuxBinaries | null {
    return this.lastResolution;
  }

  async start(): Promise<RmuxTerminalDriver> {
    if (this.stopped) throw new RmuxDriverCrashedError();
    if (this.driver) return this.driver;
    if (this.starting) return this.starting;
    this.starting = this.startUnlocked().finally(() => {
      this.starting = null;
    });
    try {
      return await this.starting;
    } catch (err) {
      // Only after `this.starting` is cleared — otherwise a restart would
      // join the already-rejected in-flight promise and never spawn again.
      if (!this.stopped) {
        void this.scheduleRestart();
      }
      throw err;
    }
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
    this.clearStabilityTimer();
    this.driver = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
    this.child = null;
  }

  private async startUnlocked(): Promise<RmuxTerminalDriver> {
    if (this.spawning) throw new RmuxDriverCrashedError();
    this.spawning = true;
    let spawned: ChildProcessWithoutNullStreams | null = null;
    let candidate: RmuxSidecarDriver | null = null;
    try {
      if (this.opts.createDriver) {
        // Test inject path: skip filesystem binary resolution.
        const binaries: ResolvedRmuxBinaries = {
          bridgeCommand: this.opts.config.bridgeCommand ?? "injected-bridge",
          ...(this.opts.config.rmuxCommand ? { rmuxCommand: this.opts.config.rmuxCommand } : {}),
          source: { bridge: "config" },
        };
        candidate = await this.opts.createDriver(binaries);
        candidate.onCrash(() => {
          // Injected drivers have no real child exit; fence immediately.
          this.driver = null;
        });
        await candidate.handshake();
        this.driver = candidate;
        this.armStabilityReset();
        return candidate;
      }

      const spawnFn = this.opts.spawnFn ?? spawn;
      const binaries: ResolvedRmuxBinaries = this.opts.spawnFn
        ? {
            bridgeCommand: this.opts.config.bridgeCommand ?? "test-bridge",
            ...(this.opts.config.rmuxCommand
              ? { rmuxCommand: this.opts.config.rmuxCommand }
              : {}),
            source: { bridge: "config" },
          }
        : resolveRmuxBinaries({
            bridgeCommand: this.opts.config.bridgeCommand,
            rmuxCommand: this.opts.config.rmuxCommand,
          });
      this.lastResolution = binaries;

      // Never spawn a second child while one is still attached.
      if (this.child) throw new RmuxDriverCrashedError();
      const env: NodeJS.ProcessEnv = { ...process.env };
      // Scrub obvious secrets from child env before injecting daemon path.
      for (const key of Object.keys(env)) {
        if (key.startsWith("XACPX_") || /token|secret|password|credential/i.test(key)) {
          delete env[key];
        }
      }
      delete env.RMUX_SDK_DAEMON_BINARY;
      delete env.RMUX_CONFIG_FILE;

      if (process.platform === "win32") {
        if (binaries.rmuxCommand) {
          env.RMUX_SDK_DAEMON_BINARY = binaries.rmuxCommand;
        }
        // RMUX 0.10 honors RMUX_CONFIG_FILE on Windows.
        env.RMUX_CONFIG_FILE = emptyRmuxConfigPath();
      } else if (binaries.rmuxCommand) {
        // RMUX 0.10 ignores RMUX_CONFIG_FILE on Unix. Point the SDK daemon
        // launcher at this bridge; its --__internal-daemon wrapper execs the
        // resolved daemon after replacing --config-default with an explicit
        // /dev/null config, while preserving HOME/XDG for terminal shells.
        env.RMUX_SDK_DAEMON_BINARY = binaries.bridgeCommand;
        env.XACPX_RMUX_DAEMON_BINARY = binaries.rmuxCommand;
      } else if (!this.opts.spawnFn) {
        throw new Error("process-owned RMUX requires a resolved daemon binary on Unix");
      }
      env.XACPX_RMUX_ENDPOINT_LABEL =
        (this.opts.endpointLabelFactory ?? newEndpointLabel)();

      spawned = spawnFn(binaries.bridgeCommand, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;

      this.child = spawned;
      candidate = new RmuxSidecarDriver({
        stdin: spawned.stdin,
        stdout: spawned.stdout,
        stderr: spawned.stderr,
        kill: (sig) => {
          spawned?.kill(sig);
        },
        on: (event, listener) => {
          spawned?.on(event, listener as never);
        },
      }, this.opts.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.opts.requestTimeoutMs }
        : {});

      // Protocol-fatal crash kills the child; exit handler restarts. Also
      // null the driver immediately so callers fence before exit races.
      candidate.onCrash(() => {
        this.driver = null;
      });

      spawned.on("exit", () => {
        if (this.child !== spawned) return;
        this.clearStabilityTimer();
        this.child = null;
        this.driver = null;
        if (this.stopped) return;
        this.opts.onChildExit?.();
        void this.scheduleRestart();
      });

      await candidate.handshake();
      this.driver = candidate;
      this.armStabilityReset();
      return candidate;
    } catch (err) {
      this.clearStabilityTimer();
      const ownedChild = spawned !== null && this.child === spawned;
      if (ownedChild) {
        this.child = null;
        this.driver = null;
      }
      if (candidate && this.driver !== candidate) {
        try {
          candidate.dispose();
        } catch {
          // ignore
        }
      }
      if (ownedChild && spawned && !spawned.killed) {
        try {
          spawned.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      throw err;
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

  private armStabilityReset(): void {
    this.clearStabilityTimer();
    const stableAfterMs = this.opts.stableAfterMs ?? 30_000;
    const timer = setTimeout(() => {
      this.stableTimer = null;
      if (!this.stopped && this.driver) {
        this.restartCount = 0;
      }
    }, stableAfterMs);
    timer.unref?.();
    this.stableTimer = timer;
  }

  private clearStabilityTimer(): void {
    if (this.stableTimer === null) return;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }
}

export async function createProductionTerminalDriver(
  config: RelayTerminalConfig,
  opts: Omit<RmuxSidecarSupervisorOptions, "config"> = {},
): Promise<{ driver: RmuxTerminalDriver; supervisor: RmuxSidecarSupervisor }> {
  const supervisor = new RmuxSidecarSupervisor({ ...opts, config });
  try {
    await supervisor.start();
  } catch (err) {
    try {
      await supervisor.stop();
    } catch {
      // ignore
    }
    throw err;
  }
  return { driver: new SupervisedRmuxDriver(supervisor), supervisor };
}
