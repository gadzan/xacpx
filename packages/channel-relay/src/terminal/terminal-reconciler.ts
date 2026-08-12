// Startup / periodic terminal reconciliation — process-owned mode.
//
// Mark-and-sweep over (registry × catalog × RMUX inventory). Never adopts
// across process boundaries: leftover creating/live records are reaped/killed;
// inventory-only orphans are quarantined then killed after grace.
// Fail-closed when catalog/inventory/registry is incomplete.
import type {
  SessionResourceCatalog,
  SessionResourceDescriptor,
} from "xacpx/plugin-api";

import type { RelayTerminalConfig } from "../config.js";
import type { RmuxInventoryEntry, RmuxTerminalDriver } from "./rmux-driver.js";
import type { TerminalRegistryStore } from "./terminal-registry-store.js";
import type { TerminalRecordV1, TerminalReapReason } from "./terminal-types.js";
import type { TerminalRuntimeClock } from "./terminal-runtime.js";

export type ReconcileDiagnostic =
  | { type: "inventory-uncertain" }
  | { type: "catalog-unavailable"; message: string }
  | { type: "inventory-unavailable"; message: string }
  | { type: "malformed-tags"; sessionId: string; reason: string }
  | { type: "ambiguous-tags"; sessionId: string; reason: string }
  | { type: "name-prefix-mismatch"; sessionId: string; name: string }
  | { type: "stable-id-mismatch"; terminalId: string; expected?: string; actual: string }
  | { type: "orphan-quarantined"; terminalId: string; sessionId: string }
  | { type: "orphan-killed"; sessionId: string }
  | { type: "stale-reaped"; terminalId: string; sessionId?: string }
  | { type: "removed-absent"; terminalId: string }
  | { type: "reaping"; terminalId: string; reason: TerminalReapReason };

export interface ParsedRelayTags {
  ownerId: string;
  logicalSessionId: string;
  terminalId: string;
  generation: string;
  schema: string;
}

export interface TerminalReconcileHost {
  registry: TerminalRegistryStore;
  driver: RmuxTerminalDriver;
  catalog: SessionResourceCatalog;
  config: RelayTerminalConfig;
  clock: TerminalRuntimeClock;
  withTerminalLock<T>(terminalId: string, fn: () => Promise<T>): Promise<T>;
  /** True when this process already owns a live in-memory handle for the terminal. */
  hasLiveHandle(terminalId: string): boolean;
  /** Drop in-memory handle and fan out exit to current attachments. */
  onResourceAbsent(terminalId: string, generation: string, reason: string): void;
  /** Fence mutations after observing the resource should no longer be live. */
  onFence(terminalId: string): void;
  killWithTimeout(sessionId: string): Promise<boolean>;
}

export interface TerminalReconcilerOptions {
  host: TerminalReconcileHost;
  onDiagnostic?: (d: ReconcileDiagnostic) => void;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

const NAME_PREFIX = "xacpx-relay-";

/** Parse RMUX tags written at create time. Incomplete tags → do not forge or kill. */
export function parseRelayTerminalTags(
  tags: readonly string[],
): ParsedRelayTags | null {
  let ownerId: string | undefined;
  let logicalSessionId: string | undefined;
  let terminalId: string | undefined;
  let generation: string | undefined;
  let schema: string | undefined;
  let relayMarker = false;

  for (const tag of tags) {
    if (tag === "xacpx:relay") {
      relayMarker = true;
      continue;
    }
    if (tag.startsWith("owner:")) ownerId = tag.slice("owner:".length);
    else if (tag.startsWith("logical:")) logicalSessionId = tag.slice("logical:".length);
    else if (tag.startsWith("terminal:")) terminalId = tag.slice("terminal:".length);
    else if (tag.startsWith("generation:")) generation = tag.slice("generation:".length);
    else if (tag.startsWith("schema:")) schema = tag.slice("schema:".length);
  }

  if (!relayMarker || !ownerId || !logicalSessionId || !terminalId || !generation || schema !== "1") {
    return null;
  }
  return { ownerId, logicalSessionId, terminalId, generation, schema };
}

export class TerminalReconciler {
  private readonly host: TerminalReconcileHost;
  private readonly onDiagnostic: (d: ReconcileDiagnostic) => void;
  private readonly setIntervalFn: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;

  private pass = 0;
  private readonly orphanPasses = new Map<string, { first: number; last: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(options: TerminalReconcilerOptions) {
    this.host = options.host;
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((id) => clearInterval(id));
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      await this.running;
      return;
    }
    this.running = this.runPass().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  startPeriodic(): void {
    if (this.timer || this.stopped) return;
    const ms = this.host.config.reconcileIntervalSeconds * 1000;
    const timer = this.setIntervalFn(() => {
      void this.runOnce();
    }, ms);
    if (typeof timer === "object" && timer && "unref" in timer) {
      (timer as NodeJS.Timeout).unref?.();
    }
    this.timer = timer;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
  }

  private async runPass(): Promise<void> {
    this.pass += 1;
    const snap = this.host.registry.getSnapshot();
    if (snap.inventoryUncertain) {
      this.onDiagnostic({ type: "inventory-uncertain" });
      return;
    }

    let catalogByLogical: Map<string, SessionResourceDescriptor>;
    try {
      const list = await this.host.catalog.list("relay");
      catalogByLogical = new Map(list.map((d) => [d.logicalSessionId, d]));
    } catch (err) {
      this.onDiagnostic({
        type: "catalog-unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let inventory: RmuxInventoryEntry[];
    try {
      inventory = await this.host.driver.list();
    } catch (err) {
      this.onDiagnostic({
        type: "inventory-unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const inventoryBySessionId = new Map(inventory.map((e) => [e.sessionId, e]));
    const inventoryByName = new Map(inventory.map((e) => [e.name, e]));
    const matchedSessionIds = new Set<string>();

    for (const rec of Object.values(snap.terminals)) {
      await this.host.withTerminalLock(rec.terminalId, async () => {
        const currentSnap = this.host.registry.getSnapshot();
        const current = currentSnap.terminals[rec.terminalId];
        if (!current) return;
        if (
          current.generation !== rec.generation ||
          current.state !== rec.state ||
          (rec.rmuxSessionId && current.rmuxSessionId && current.rmuxSessionId !== rec.rmuxSessionId)
        ) {
          this.onDiagnostic({
            type: "stable-id-mismatch",
            terminalId: rec.terminalId,
            expected: rec.rmuxSessionId,
            actual: current.rmuxSessionId ?? "",
          });
          return;
        }

        const inv =
          (current.rmuxSessionId ? inventoryBySessionId.get(current.rmuxSessionId) : undefined) ??
          inventoryByName.get(current.rmuxSessionName);

        if (inv) matchedSessionIds.add(inv.sessionId);

        const logical = catalogByLogical.get(current.logicalSessionId);
        const idleMs = this.host.config.idleTimeoutSeconds * 1000;
        const lastInput = Date.parse(current.lastInputAt);
        const idleExpired =
          Number.isFinite(lastInput) && this.host.clock.now() - lastInput >= idleMs;

        if (current.state === "creating") {
          await this.handleCreating(current, inv);
          return;
        }

        if (current.state === "live") {
          await this.handleLive(current, inv, logical, idleExpired);
          return;
        }

        if (current.state === "reaping") {
          await this.handleReaping(current, inv);
        }
      });
    }

    for (const entry of inventory) {
      if (matchedSessionIds.has(entry.sessionId)) continue;
      await this.handleInventoryOnly(entry, snap.installationId, catalogByLogical);
    }
  }

  private async handleCreating(
    rec: TerminalRecordV1,
    inv: RmuxInventoryEntry | undefined,
  ): Promise<void> {
    // Process-owned: never promote creating→live. Crash-window / previous-process
    // creating records and inventory quarantine share this state — age then kill.
    if (!inv) {
      const snap = this.host.registry.getSnapshot();
      if (snap.terminals[rec.terminalId]?.state === "creating") {
        await this.host.registry.remove(rec.terminalId);
        this.onDiagnostic({ type: "removed-absent", terminalId: rec.terminalId });
      }
      return;
    }
    this.touchOrphan(inv.sessionId);
    await this.maybeKillQuarantine(rec, inv);
  }

  private async handleLive(
    rec: TerminalRecordV1,
    inv: RmuxInventoryEntry | undefined,
    logical: SessionResourceDescriptor | undefined,
    idleExpired: boolean,
  ): Promise<void> {
    if (!inv) {
      // Process-local sidecar inventory can miss sessions owned by another
      // process (CLI maintenance sidecar vs daemon). Never clear the registry
      // without attempting a durable kill by stored session id/name.
      if (rec.rmuxSessionId || rec.rmuxSessionName) {
        await this.beginReap(rec, undefined, "orphan");
        return;
      }
      this.host.onResourceAbsent(rec.terminalId, rec.generation, "absent");
      const snap = this.host.registry.getSnapshot();
      if (snap.terminals[rec.terminalId]) {
        await this.host.registry.remove(rec.terminalId);
      }
      this.onDiagnostic({ type: "removed-absent", terminalId: rec.terminalId });
      return;
    }

    if (rec.rmuxSessionId && inv.sessionId !== rec.rmuxSessionId) {
      this.onDiagnostic({
        type: "stable-id-mismatch",
        terminalId: rec.terminalId,
        expected: rec.rmuxSessionId,
        actual: inv.sessionId,
      });
      return;
    }

    if (!expectedName(rec, this.host.registry.getSnapshot().installationId)) {
      this.onDiagnostic({
        type: "name-prefix-mismatch",
        sessionId: inv.sessionId,
        name: inv.name,
      });
    }

    // No in-process handle ⇒ leftover from a previous process / sidecar crash.
    // Process-owned policy: kill, never adopt.
    if (!this.host.hasLiveHandle(rec.terminalId)) {
      await this.beginReap(rec, inv, "orphan");
      this.onDiagnostic({
        type: "stale-reaped",
        terminalId: rec.terminalId,
        sessionId: inv.sessionId,
      });
      return;
    }

    if (!logical || logical.archived || idleExpired) {
      const reason: TerminalReapReason = idleExpired
        ? "idle"
        : logical?.archived
          ? "archive"
          : "orphan";
      await this.beginReap(rec, inv, reason);
    }
  }

  private async beginReap(
    rec: TerminalRecordV1,
    inv: RmuxInventoryEntry | undefined,
    reason: TerminalReapReason,
  ): Promise<void> {
    const snap = this.host.registry.getSnapshot();
    const current = snap.terminals[rec.terminalId];
    if (!current) return;
    if (current.state !== "reaping") {
      await this.host.registry.markReaping(rec.terminalId, reason);
    }
    this.host.onFence(rec.terminalId);
    this.onDiagnostic({ type: "reaping", terminalId: rec.terminalId, reason });
    await this.handleReaping(
      { ...current, state: "reaping", reapReason: reason },
      inv,
    );
  }

  private async handleReaping(
    rec: TerminalRecordV1,
    inv: RmuxInventoryEntry | undefined,
  ): Promise<void> {
    const snap = this.host.registry.getSnapshot();
    const current = snap.terminals[rec.terminalId];
    if (!current || current.state !== "reaping") return;
    if (current.generation !== rec.generation) return;
    if (
      rec.rmuxSessionId &&
      current.rmuxSessionId &&
      current.rmuxSessionId !== rec.rmuxSessionId
    ) {
      return;
    }

    if (!inv) {
      // Prefer durable session id; fall back to the unique RMUX name we store
      // as the process-owned session_id on the wire.
      const sessionId = current.rmuxSessionId ?? current.rmuxSessionName;
      if (sessionId) {
        const killed = await this.host.killWithTimeout(sessionId);
        if (!killed) return;
      }
      await this.host.registry.remove(rec.terminalId);
      this.host.onResourceAbsent(rec.terminalId, rec.generation, current.reapReason ?? "reaping");
      this.onDiagnostic({ type: "removed-absent", terminalId: rec.terminalId });
      return;
    }

    if (current.rmuxSessionId && inv.sessionId !== current.rmuxSessionId) {
      this.onDiagnostic({
        type: "stable-id-mismatch",
        terminalId: rec.terminalId,
        expected: current.rmuxSessionId,
        actual: inv.sessionId,
      });
      return;
    }

    const sessionId = current.rmuxSessionId ?? inv.sessionId;
    const killed = await this.host.killWithTimeout(sessionId);
    if (!killed) return;

    const after = this.host.registry.getSnapshot();
    if (after.terminals[rec.terminalId]?.state === "reaping") {
      await this.host.registry.remove(rec.terminalId);
      this.host.onResourceAbsent(rec.terminalId, rec.generation, current.reapReason ?? "reaping");
      this.onDiagnostic({ type: "removed-absent", terminalId: rec.terminalId });
    }
  }

  private async handleInventoryOnly(
    entry: RmuxInventoryEntry,
    installationId: string,
    catalogByLogical: Map<string, SessionResourceDescriptor>,
  ): Promise<void> {
    if (!entry.name.startsWith(NAME_PREFIX)) {
      this.onDiagnostic({
        type: "name-prefix-mismatch",
        sessionId: entry.sessionId,
        name: entry.name,
      });
      return;
    }

    const parsed = parseRelayTerminalTags(entry.tags);
    // Without complete tags we still may kill by name prefix + owner short id
    // embedded in the name when aged — but only when name matches our install.
    const expectedPrefix = `${NAME_PREFIX}${installationId.slice(0, 8)}-`;
    if (!entry.name.startsWith(expectedPrefix)) {
      return;
    }

    this.touchOrphan(entry.sessionId);

    if (parsed) {
      if (parsed.ownerId !== installationId) return;
      const existing = this.host.registry.getSnapshot().terminals[parsed.terminalId];
      if (existing) return;

      const snap = this.host.registry.getSnapshot();
      const conflict = Object.values(snap.terminals).find(
        (t) =>
          t.logicalSessionId === parsed.logicalSessionId &&
          t.terminalId !== parsed.terminalId,
      );
      if (conflict) {
        this.onDiagnostic({
          type: "ambiguous-tags",
          sessionId: entry.sessionId,
          reason: `logical ${parsed.logicalSessionId} already bound to ${conflict.terminalId}`,
        });
        return;
      }

      const logical = catalogByLogical.get(parsed.logicalSessionId);
      const firstSeenIso = new Date(this.host.clock.now()).toISOString();
      await this.host.registry.upsertCreating({
        terminalId: parsed.terminalId,
        logicalSessionId: parsed.logicalSessionId,
        internalAliasSnapshot: logical?.internalAlias ?? parsed.logicalSessionId,
        rmuxSessionName: entry.name,
        generation: parsed.generation,
        createdAt: firstSeenIso,
        lastInputAt: firstSeenIso,
      });
      this.onDiagnostic({
        type: "orphan-quarantined",
        terminalId: parsed.terminalId,
        sessionId: entry.sessionId,
      });

      const quarantined = this.host.registry.getSnapshot().terminals[parsed.terminalId];
      if (!quarantined) return;
      await this.host.withTerminalLock(parsed.terminalId, async () => {
        await this.maybeKillQuarantine(quarantined, entry);
      });
      return;
    }

    // Name matches our install but tags incomplete — age then kill by sessionId.
    await this.maybeKillNamelessOrphan(entry);
  }

  private touchOrphan(sessionId: string): void {
    const seen = this.orphanPasses.get(sessionId);
    if (seen) seen.last = this.pass;
    else this.orphanPasses.set(sessionId, { first: this.pass, last: this.pass });
  }

  private async maybeKillQuarantine(
    rec: TerminalRecordV1,
    inv: RmuxInventoryEntry,
  ): Promise<void> {
    const seen = this.orphanPasses.get(inv.sessionId);
    const rounds = seen ? seen.last - seen.first + 1 : 1;
    const firstSeen = Date.parse(rec.createdAt);
    const graceMs = this.host.config.orphanGraceSeconds * 1000;
    const aged =
      Number.isFinite(firstSeen) && this.host.clock.now() - firstSeen >= graceMs;

    if (rounds < 2 || !aged) return;

    const snap = this.host.registry.getSnapshot();
    const current = snap.terminals[rec.terminalId];
    if (!current) return;
    if (current.state === "live" && this.host.hasLiveHandle(rec.terminalId)) return;
    if (current.state !== "reaping") {
      await this.host.registry.markReaping(rec.terminalId, "orphan");
    }

    const after = this.host.registry.getSnapshot();
    const still = after.terminals[rec.terminalId];
    if (!still || still.state !== "reaping" || still.generation !== rec.generation) return;

    const killed = await this.host.killWithTimeout(inv.sessionId);
    if (!killed) return;
    const finalSnap = this.host.registry.getSnapshot();
    if (finalSnap.terminals[rec.terminalId]) {
      await this.host.registry.remove(rec.terminalId);
    }
    this.orphanPasses.delete(inv.sessionId);
    this.onDiagnostic({ type: "orphan-killed", sessionId: inv.sessionId });
  }

  private async maybeKillNamelessOrphan(entry: RmuxInventoryEntry): Promise<void> {
    const seen = this.orphanPasses.get(entry.sessionId);
    const rounds = seen ? seen.last - seen.first + 1 : 1;
    const graceMs = this.host.config.orphanGraceSeconds * 1000;
    // Without a registry first-seen timestamp, require ≥2 passes and use
    // reconcile interval * rounds as a coarse age proxy.
    const aged =
      rounds >= 2 &&
      rounds * this.host.config.reconcileIntervalSeconds * 1000 >= graceMs;
    if (!aged) {
      this.onDiagnostic({
        type: "malformed-tags",
        sessionId: entry.sessionId,
        reason: "incomplete relay tags; waiting orphan grace before kill",
      });
      return;
    }
    const killed = await this.host.killWithTimeout(entry.sessionId);
    if (killed) {
      this.orphanPasses.delete(entry.sessionId);
      this.onDiagnostic({ type: "orphan-killed", sessionId: entry.sessionId });
    }
  }
}

function expectedName(rec: TerminalRecordV1, installationId: string): boolean {
  const expected = `${NAME_PREFIX}${installationId.slice(0, 8)}-${rec.terminalId.replaceAll("-", "")}`;
  return rec.rmuxSessionName === expected;
}
