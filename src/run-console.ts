import type { AppRuntime, RuntimePaths } from "./main";
import {
  ActiveConsumerLockError,
  type ChannelStartInput,
  type ConsumerLock,
  type ConsumerLockMetadata,
} from "./channels/types.js";
import { listXacpxCommandHints } from "./commands/command-hints.js";
import { XACPX_CORE_VERSION } from "./version.js";
import { getLocale } from "./i18n/index.js";
import { asPublicControl } from "./control/public-control.js";
import { conversationKernel } from "./control/control-service.js";

interface DaemonLifecycle {
  start: (input: { configPath: string; statePath: string }) => Promise<void>;
  heartbeat: () => Promise<void>;
  stop: () => Promise<void>;
}

interface ChannelRegistry {
  startAll(input: ChannelStartInput): Promise<void>;
  stopAll?(reason?: "shutdown" | "disabled" | "removed" | "logout"): void | Promise<void>;
  /**
   * Live interaction-capability reads. Optional so existing test doubles that
   * only stub `startAll` keep working: when absent, the post-start
   * truthfulness gate is skipped rather than guessing.
   */
  failedStartupChannelIds?(): string[];
  formElicitationChannelIds?(): string[];
  elicitationFormCapable?(): boolean;
}

type ChannelStartupPolicy = "require-one" | "best-effort";

interface RunConsoleDeps {
  buildApp: (paths: RuntimePaths) => Promise<AppRuntime>;
  afterBuild?: (runtime: AppRuntime) => Promise<void>;
  /**
   * Activates durable process-owned state after the required consumer lock is
   * held, but before reconciliation or orphan cleanup can mutate shared state.
   */
  afterConsumerLockAcquired?: (runtime: AppRuntime) => Promise<void>;
  beforeReady?: (runtime: AppRuntime) => Promise<void>;
  channels: ChannelRegistry;
  channelStartupPolicy?: ChannelStartupPolicy;
  daemonRuntime?: DaemonLifecycle;
  heartbeatIntervalMs?: number;
  setInterval?: (fn: () => void | Promise<void>, delay: number) => unknown;
  clearInterval?: (timer: unknown) => void;
  addProcessListener?: (signal: NodeJS.Signals, handler: () => void) => void;
  removeProcessListener?: (signal: NodeJS.Signals, handler: () => void) => void;
  consumerLock?: ConsumerLock;
  consumerLockFactory?: (runtime: AppRuntime) => ConsumerLock;
  processPid?: number;
  now?: () => string;
  hostname?: () => string;
}

interface RunCleanupSequenceInput {
  removeProcessListener: (signal: NodeJS.Signals, handler: () => void) => void;
  signalHandler: () => void;
  clearIntervalFn: (timer: unknown) => void;
  heartbeatTimer: unknown;
  orphanTimer: unknown;
  activeOrphanSweep: Promise<void>;
  daemonRuntime?: DaemonLifecycle;
  daemonRuntimeStarted: boolean;
  runtime: AppRuntime | null;
  consumerLock?: ConsumerLock;
  consumerLockAcquired: boolean;
  processPid: number;
  channels?: ChannelRegistry;
}

export async function runConsole(paths: RuntimePaths, deps: RunConsoleDeps): Promise<void> {
  const setIntervalFn = deps.setInterval ?? ((fn, delay) => setInterval(fn, delay));
  const clearIntervalFn = deps.clearInterval ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const addProcessListener = deps.addProcessListener ?? ((signal, handler) => process.on(signal, handler));
  const removeProcessListener =
    deps.removeProcessListener ?? ((signal, handler) => process.off(signal, handler));
  const processPid = deps.processPid ?? process.pid;
  const now = deps.now ?? (() => new Date().toISOString());
  const hostname = deps.hostname ?? (() => "");

  let runtime: AppRuntime | null = null;
  let consumerLock: ConsumerLock | undefined;
  let heartbeatTimer: unknown = null;
  let orphanTimer: unknown = null;
  let activeOrphanSweep = Promise.resolve();
  let orphanSweepRunning = false;
  let consumerLockAcquired = false;
  let daemonRuntimeStarted = false;
  const shutdownController = new AbortController();
  const signalHandler = () => {
    shutdownController.abort();
  };
  addProcessListener("SIGINT", signalHandler);
  addProcessListener("SIGTERM", signalHandler);

  try {
    runtime = await deps.buildApp(paths);
    if (deps.afterBuild) {
      await deps.afterBuild(runtime);
    }
    consumerLock = deps.consumerLock ?? deps.consumerLockFactory?.(runtime);

    if (consumerLock) {
      const lockMeta: ConsumerLockMetadata = {
        pid: processPid,
        mode: deps.daemonRuntime ? "daemon" : "foreground",
        startedAt: now(),
        configPath: paths.configPath,
        statePath: paths.statePath,
        hostname: hostname() || undefined,
        ...(runtime.daemonIdentity ? {
          schemaVersion: 2 as const,
          lockId: runtime.daemonIdentity.generationId,
          processCreationDate: runtime.daemonIdentity.daemonCreationDate,
        } : {}),
      };
      await runtime.logger.info("runtime.consumer_lock.acquire_attempt", "attempting to acquire runtime ownership lock", {
        pid: lockMeta.pid,
        mode: lockMeta.mode,
        configPath: lockMeta.configPath,
        statePath: lockMeta.statePath,
        hostname: lockMeta.hostname,
      });
      try {
        await consumerLock.acquire(lockMeta);
        consumerLockAcquired = true;
        await runtime.logger.info("runtime.consumer_lock.acquired", "acquired runtime ownership lock", {
          pid: lockMeta.pid,
          mode: lockMeta.mode,
          configPath: lockMeta.configPath,
          statePath: lockMeta.statePath,
        });
      } catch (error) {
        if (error instanceof ActiveConsumerLockError) {
          await runtime.logger.error("runtime.consumer_lock.acquire_failed", "runtime ownership lock is already held by another process", {
            conflictType: "active_lock_holder",
            activePid: error.existing.pid,
            activeMode: error.existing.mode,
            activeConfigPath: error.existing.configPath,
            activeStatePath: error.existing.statePath,
            requestedPid: lockMeta.pid,
            requestedMode: lockMeta.mode,
          });
        } else {
          await runtime.logger.error("runtime.consumer_lock.acquire_failed", "failed to acquire runtime ownership lock", {
            conflictType: deps.daemonRuntime ? "daemon_startup_lock_failure" : "foreground_startup_lock_failure",
            requestedPid: lockMeta.pid,
            requestedMode: lockMeta.mode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    }

    if (!consumerLock) {
      throw new Error("runtime ownership lock is required before activating shared runtime state");
    }
    if (deps.afterConsumerLockAcquired) {
      await deps.afterConsumerLockAcquired(runtime);
    }

    // Drain any tasks that were queued at shutdown and close stale ephemeral
    // worker sessions left over from a previous run. This must happen only
    // after this process owns the consumer/runtime identity; a conflicting
    // foreground process must not mutate the active daemon's state.
    try {
      await runtime.orchestration.service.reconcileParallelSlots();
    } catch (reconcileError) {
      await runtime.logger.error(
        "orchestration.parallel.reconcile_failed",
        "failed to reconcile parallel slots at startup",
        {
          message: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
        },
      );
    }

    // Sweep warm acpx queue owners orphaned by a previous daemon that exited without a
    // clean shutdown (Windows verified stop can terminate the daemon before
    // dispose() can reap; crashes and reboots skip dispose entirely). Kicked off after
    // the consumer lock is held — so no peer instance owns these — and its target set is
    // snapshotted synchronously here, before this run launches any owner, so it can never
    // target a current-run owner regardless of when the bounded (~5s) sweep finishes.
    //
    // Deliberately NOT awaited before the ready signal: the sweep is best-effort orphan
    // cleanup, and awaiting it used to push the daemonRuntime.start() status write past
    // the controller's startup timeout whenever the sweep used its full budget, making
    // `xacpx start`/`restart` falsely report "did not report ready". We join it before
    // channels begin serving so it still finishes before any current-run owner of a
    // stale session identity could be launched. Best-effort: never rejects.
    const runOrphanSweep = (operation: () => Promise<void>): Promise<void> => {
      if (orphanSweepRunning) return activeOrphanSweep;
      orphanSweepRunning = true;
      activeOrphanSweep = Promise.resolve(operation())
        .catch(() => {})
        .finally(() => { orphanSweepRunning = false; });
      return activeOrphanSweep;
    };
    const reapPromise = runOrphanSweep(runtime.reapStaleQueueOwners);

    if (deps.beforeReady) {
      // First-run onboarding creates a session and its warm owner; let the sweep finish
      // first so it can never target that owner. Gated by the generous onboarding startup
      // timeout, not the 5s default, so blocking here is safe.
      await reapPromise;
      await deps.beforeReady(runtime);
    }

    if (deps.daemonRuntime) {
      await deps.daemonRuntime.start({
        configPath: paths.configPath,
        statePath: paths.statePath,
      });
      daemonRuntimeStarted = true;
      await runtime.orchestration.server.start();
      heartbeatTimer = setIntervalFn(
        () => {
          void deps.daemonRuntime?.heartbeat().catch(() => {});
        },
        deps.heartbeatIntervalMs ?? 30_000,
      );
    }

    // Join the orphan sweep before channels begin serving so it cannot race a current-run
    // owner that reuses a stale session identity. By now the ready signal is already out.
    await reapPromise;
    // P1 G6: prime Runtime durable queues ONLY after consumer lock AND
    // stale-orphan sweep is done — and orchestration IPC when in daemon mode
    // (foreground `xacpx run` starts no orchestration server, so supplied-MCP
    // orchestration calls still need daemon IPC). An early prime in buildApp()
    // or before reap could spawn workers and drain messages before this
    // process owns the single-consumer lock or while the sweep may still
    // terminate the physical owner.
    try {
      const maybePrime = (runtime as unknown as { transport?: { primeRuntimeQueues?: (sessions: unknown[]) => Promise<void> } }).transport;
      const maybeSessions = (runtime as unknown as { sessions?: { listAllResolvedSessions?: () => { transportEngine?: string }[]; listAllResolvedLogicalSessions?: () => { transportEngine?: string }[]; listRuntimeQueueRecoverySessions?: () => { transportEngine?: string }[] } }).sessions;
      // G6: the recovery catalog is keyed by LOGICAL session id (one journal
      // per logical session AND per worker binding), so it must not use the
      // physical-deduped listAllResolvedSessions — shared-physical aliases
      // and worker journals would otherwise never auto-drain.
      const listRecovery = maybeSessions && typeof maybeSessions.listRuntimeQueueRecoverySessions === "function"
        ? () => maybeSessions.listRuntimeQueueRecoverySessions!()
        : maybeSessions && typeof maybeSessions.listAllResolvedLogicalSessions === "function"
          ? () => maybeSessions.listAllResolvedLogicalSessions!()
          : maybeSessions && typeof maybeSessions.listAllResolvedSessions === "function"
            ? () => maybeSessions.listAllResolvedSessions!()
            : null;
      if (maybePrime && typeof maybePrime.primeRuntimeQueues === "function" && listRecovery) {
        const runtimeSessions = listRecovery().filter((s) => s.transportEngine === "runtime");
        if (runtimeSessions.length > 0) {
          await maybePrime.primeRuntimeQueues(runtimeSessions);
          await runtime.logger.info("bridge.runtime_queue.primed", "primed runtime queues from catalog after lock+reap ready (IPC in daemon mode)", { count: runtimeSessions.length }).catch(() => {});
        }
      }
    } catch (err) {
      await runtime.logger.warn("bridge.runtime_queue.prime_failed", "failed to prime runtime queues after lock+reap", { error: err instanceof Error ? err.message : String(err) }).catch(() => {});
    }
    try {
      if (typeof runtime.conversations?.activateAfterConsumerLock === "function") {
        await runtime.conversations.activateAfterConsumerLock();
      }
    } catch (error) {
      // Activation fail-closes the Conversation consumer (`conversations_unavailable`)
      // rather than leaving `consumerActivated` true while channels serve. Ordinary
      // session channels may still start; new Conversation accept must not.
      await runtime.logger.error(
        "conversations.recover_failed",
        "failed to recover pending Conversation dispatch after consumer lock",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    if (runtime.reconcileOrphans && deps.daemonRuntime) {
      orphanTimer = setIntervalFn(() => runOrphanSweep(runtime!.reconcileOrphans!), 60_000);
      if (orphanTimer && typeof orphanTimer === "object" && "unref" in orphanTimer
        && typeof (orphanTimer as { unref?: unknown }).unref === "function") {
        (orphanTimer as { unref(): void }).unref();
      }
    }

    const controlService = runtime.control;
    const channelStartPromise = deps.channels.startAll({
      agent: runtime.agent,
      abortSignal: shutdownController.signal,
      quota: runtime.quota,
      sessions: runtime.sessions,
      sessionResources: runtime.sessionResources,
      activeTurns: runtime.activeTurns,
      logger: runtime.logger,
      perfTracer: runtime.perfTracer,
      commandHints: listXacpxCommandHints(),
      coreVersion: XACPX_CORE_VERSION,
      locale: getLocale(),
      control: asPublicControl(controlService),
      trustedConversationPrompt: controlService
        ? (input, ingress) =>
          conversationKernel(controlService).promptConversationFromHumanIngress(input, ingress)
        : undefined,
    });
    // Observe rejections immediately so a channel failure cannot become an
    // unhandled rejection while the scheduler startup path is still running.
    channelStartPromise.catch(() => {});

    let channelStartSettled = false;
    let channelStartError: unknown;
    channelStartPromise.then(
      () => {
        channelStartSettled = true;
      },
      (error) => {
        channelStartSettled = true;
        channelStartError = error;
      },
    );
    // Give immediately-failing channel startup a chance to report before
    // enabling scheduled dispatch. Long-running channel loops remain pending
    // here, which is the normal daemon state.
    await Promise.resolve();

    if (channelStartSettled && channelStartError) {
      if (deps.channelStartupPolicy !== "best-effort") {
        throw channelStartError;
      }
      await runtime.logger.error(
        "daemon.channels.start_failed",
        "all channels failed to start; daemon remains alive for orchestration IPC",
        { error: channelStartError instanceof Error ? channelStartError.message : String(channelStartError) },
      );
      await waitForShutdown(shutdownController.signal);
      return;
    }

    // Interaction-capability truthfulness gate.
    //
    // The daemon computed form-Elicitation capability BEFORE channels existed,
    // and `startAll` tolerates partial failure — one dead channel does not stop
    // the others. So a channel that advertised `form` and then failed to bind
    // can leave the daemon running with a capability nothing backs: the agent
    // would be told to render a form and every request would cancel. The
    // registry's probe reads live readiness, so re-evaluating here sees the
    // failure. Fatal, because the only alternative is a silent downgrade to a
    // advertised-but-dead capability for the whole run.
    if (typeof deps.channels.elicitationFormCapable === "function"
      && typeof deps.channels.failedStartupChannelIds === "function") {
      const failed = deps.channels.failedStartupChannelIds();
      const formChannels = deps.channels.formElicitationChannelIds?.() ?? [];
      const brokenFormChannels = formChannels.filter((id) => failed.includes(id));
      // Only fatal when NO form-capable channel survived: a healthy one still
      // delivers forms, so the capability is still true.
      const anyFormCapable = deps.channels.elicitationFormCapable();
      if (brokenFormChannels.length > 0) {
        await runtime.logger.error(
          anyFormCapable
            ? "daemon.channels.elicit_form_degraded"
            : "daemon.channels.elicit_form_lost",
          anyFormCapable
            ? "a form-capable channel failed to start; another still serves form elicitation"
            : "every form-capable channel failed to start; form elicitation is no longer deliverable",
          { brokenChannels: brokenFormChannels, failedChannels: failed },
        );
        if (!anyFormCapable && deps.channelStartupPolicy !== "best-effort") {
          throw new Error(
            `form elicitation is advertised but no form-capable channel started (failed: ${brokenFormChannels.join(", ")}); refusing startup`,
          );
        }
      }
    }

    try {
      await runtime.scheduled.scheduler.start();
    } catch (error) {
      shutdownController.abort();
      throw error;
    }

    try {
      await channelStartPromise;
    } catch (error) {
      runtime.scheduled.scheduler.stop();
      if (deps.channelStartupPolicy !== "best-effort") {
        throw error;
      }
      await runtime.logger.error(
        "daemon.channels.start_failed",
        "all channels failed to start; daemon remains alive for orchestration IPC",
        { error: error instanceof Error ? error.message : String(error) },
      );
      await waitForShutdown(shutdownController.signal);
      return;
    }
  } finally {
    await runCleanupSequence({
      removeProcessListener,
      signalHandler,
      clearIntervalFn,
      heartbeatTimer,
      orphanTimer,
      activeOrphanSweep,
      ...(deps.daemonRuntime ? { daemonRuntime: deps.daemonRuntime } : {}),
      runtime,
      consumerLock,
      consumerLockAcquired,
      processPid,
      channels: deps.channels,
      daemonRuntimeStarted,
    });
  }
}

async function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function runCleanupSequence(input: RunCleanupSequenceInput): Promise<void> {
  let cleanupError: unknown = null;
  input.removeProcessListener("SIGINT", input.signalHandler);
  input.removeProcessListener("SIGTERM", input.signalHandler);
  if (input.heartbeatTimer !== null) {
    input.clearIntervalFn(input.heartbeatTimer);
  }
  if (input.orphanTimer !== null) {
    input.clearIntervalFn(input.orphanTimer);
  }
  await input.activeOrphanSweep.catch(() => {});
  if (input.daemonRuntime && input.runtime) {
    try {
      await input.runtime.orchestration.server.stop();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (input.runtime) {
    try {
      await input.runtime.dispose();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (input.channels) {
    try {
      await input.channels.stopAll?.();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (input.daemonRuntime && input.daemonRuntimeStarted) {
    try {
      await input.daemonRuntime.stop();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (input.consumerLockAcquired) {
    try {
      await input.consumerLock?.release();
      if (input.runtime) {
        await input.runtime.logger.info("runtime.consumer_lock.released", "released runtime ownership lock", {
          pid: input.processPid,
        });
      }
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
}
