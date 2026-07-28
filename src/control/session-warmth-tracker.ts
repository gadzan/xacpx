import type { AppLogger } from "../logging/app-logger";
import type { ResolvedSession } from "../transport/types";
import type { ControlEventBus } from "./control-event-bus";

export interface SessionWarmthTrackerDeps {
  listSessions: () => ResolvedSession[];
  isWarm: (session: ResolvedSession) => Promise<boolean>;
  events: ControlEventBus;
  logger?: AppLogger;
  intervalMs?: number;
  setIntervalFn?: (fn: () => void | Promise<void>, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
}

/**
 * Polls queue-owner process liveness for every logical session and emits a
 * payload-free `sessions-changed` control event whenever any session's warmth
 * flips (e.g. a silent TTL expiry), so connected dashboards re-fetch the list
 * and refresh their cold indicators. `isWarm` gives the last observed value
 * synchronously for `control.sessions.list`.
 */
export class SessionWarmthTracker {
  private readonly listSessions: () => ResolvedSession[];
  private readonly checkWarm: (session: ResolvedSession) => Promise<boolean>;
  private readonly events: ControlEventBus;
  private readonly logger?: AppLogger;
  private readonly intervalMs: number;
  private readonly setIntervalFn: (fn: () => void | Promise<void>, delay: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;
  private readonly warmth = new Map<string, boolean>();
  private intervalHandle: unknown = null;
  private ticking = false;

  constructor(deps: SessionWarmthTrackerDeps) {
    this.listSessions = deps.listSessions;
    this.checkWarm = deps.isWarm;
    this.events = deps.events;
    this.logger = deps.logger;
    this.intervalMs = deps.intervalMs ?? 60_000;
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, delay) => setInterval(fn, delay));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  }

  start(): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = this.setIntervalFn(() => {
      void this.tick();
    }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Last observed warmth for this session's transport; undefined until first checked. */
  isWarm(session: ResolvedSession): boolean | undefined {
    return this.warmth.get(warmthKey(session));
  }

  /** Immediate corrections from call sites that just changed warmth themselves
   *  (archive kills the owner; a starting turn warms it). No event — the caller's
   *  own flow already emits one. */
  markWarm(session: ResolvedSession): void {
    this.warmth.set(warmthKey(session), true);
  }

  markCold(session: ResolvedSession): void {
    this.warmth.set(warmthKey(session), false);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const sessions = this.listSessions();
      const seen = new Set<string>();
      let flipped = false;
      for (const session of sessions) {
        const key = warmthKey(session);
        if (seen.has(key)) continue; // aliases sharing a transport share warmth
        seen.add(key);
        let warm: boolean;
        try {
          warm = await this.checkWarm(session);
        } catch (error) {
          // Keep the previous observation — a transient check failure must not
          // flap the indicator or kill the poller.
          await this.logger?.error("warmth.check_failed", "session warmth check threw; keeping previous value", {
            transportSession: session.transportSession,
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (this.warmth.get(key) !== warm) {
          this.warmth.set(key, warm);
          flipped = true;
        }
      }
      for (const key of [...this.warmth.keys()]) {
        if (!seen.has(key)) this.warmth.delete(key);
      }
      if (flipped) {
        this.events.emit({ type: "sessions-changed" });
      }
    } catch (error) {
      // tick() is fired-and-forgotten from start(); a rejection here would be an
      // unhandled promise rejection that can kill the daemon on every interval.
      await this.logger?.error("warmth.tick_failed", "session warmth tick threw", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ticking = false;
    }
  }
}

// Same composite key as reapQueueOwners/defaultResolveRecordId — warmth is a
// property of the transport session, not the logical alias.
function warmthKey(session: ResolvedSession): string {
  return JSON.stringify([session.agent, session.agentCommand ?? null, session.cwd, session.transportSession]);
}
