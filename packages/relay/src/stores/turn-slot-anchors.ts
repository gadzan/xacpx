import type { SqlDriver } from "../db.js";

export interface TurnSlotAnchor {
  instanceId: string;
  sessionAlias: string;
  recoveryId: string;
  slotAfterId: number;
  startedAt?: number;
  startedAfterSeq?: number;
}

/**
 * Dedicated PK value for connectors that omit `recoveryId` on `turn-started`.
 * The NUL prefix cannot collide with connector `randomUUID()` recovery ids.
 * Legacy fallback is instance + session scoped: two sessions on one instance
 * must not share `(instanceId, "")`.
 */
export const LEGACY_RECOVERY_ID_PREFIX = "\0legacy:";

export function canonicalRecoveryId(sessionAlias: string, recoveryId?: string): string {
  return typeof recoveryId === "string" && recoveryId.length > 0
    ? recoveryId
    : `${LEGACY_RECOVERY_ID_PREFIX}${sessionAlias}`;
}

/**
 * Durable live-slot identity for an in-flight turn. Written at Hub `turn-started`
 * (last persisted `messages.id` for the session) so a Hub restart can flush the
 * `out` row into the same slot without guessing from peer/hub/browser clocks.
 *
 * Keyed by `(instance_id, recovery_id)`:
 * - Non-empty `recoveryId` is the real recovery identity (exact match only).
 * - Empty/omitted `recoveryId` uses {@link canonicalRecoveryId} (per-session
 *   dedicated key). A miss must never fall back to another session's leftover.
 */
export class TurnSlotAnchorStore {
  constructor(private readonly db: SqlDriver) {}

  put(row: TurnSlotAnchor): void {
    this.db.run(
      `INSERT INTO turn_slot_anchors (
         instance_id, session_alias, recovery_id, slot_after_id, started_at, started_after_seq
       ) VALUES (?,?,?,?,?,?)
       ON CONFLICT(instance_id, recovery_id) DO UPDATE SET
         session_alias = excluded.session_alias,
         slot_after_id = excluded.slot_after_id,
         started_at = excluded.started_at,
         started_after_seq = excluded.started_after_seq`,
      [
        row.instanceId,
        row.sessionAlias,
        row.recoveryId,
        row.slotAfterId,
        row.startedAt ?? null,
        row.startedAfterSeq ?? null,
      ],
    );
  }

  get(instanceId: string, recoveryId: string): TurnSlotAnchor | undefined {
    return this.toAnchor(this.db.get<{
      instance_id: string;
      session_alias: string;
      recovery_id: string;
      slot_after_id: number;
      started_at: number | null;
      started_after_seq: number | null;
    }>(
      `SELECT instance_id, session_alias, recovery_id, slot_after_id, started_at, started_after_seq
       FROM turn_slot_anchors WHERE instance_id = ? AND recovery_id = ?`,
      [instanceId, recoveryId],
    ));
  }

  /**
   * Lookup then delete. Non-empty `recoveryId` is exact-match only: a miss
   * means Hub never saw this start (do not bind a leftover session anchor).
   * Empty/omitted `recoveryId` uses the dedicated per-session legacy key.
   */
  take(instanceId: string, sessionAlias: string, recoveryId?: string): TurnSlotAnchor | undefined {
    const id = canonicalRecoveryId(sessionAlias, recoveryId);
    const row = this.get(instanceId, id);
    if (!row) return undefined;
    this.db.run(
      "DELETE FROM turn_slot_anchors WHERE instance_id = ? AND recovery_id = ?",
      [row.instanceId, row.recoveryId],
    );
    return row;
  }

  /**
   * After an authoritative `instance.state.sync`, drop leftover anchors that
   * are not in the connector's `turns ∪ finishedOffline` set.
   */
  retain(instanceId: string, keepRecoveryIds: ReadonlySet<string>): void {
    if (keepRecoveryIds.size === 0) {
      this.db.run("DELETE FROM turn_slot_anchors WHERE instance_id = ?", [instanceId]);
      return;
    }
    const ids = [...keepRecoveryIds];
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `DELETE FROM turn_slot_anchors WHERE instance_id = ? AND recovery_id NOT IN (${placeholders})`,
      [instanceId, ...ids],
    );
  }

  deleteBySession(instanceId: string, sessionAlias: string): void {
    this.db.run(
      "DELETE FROM turn_slot_anchors WHERE instance_id = ? AND session_alias = ?",
      [instanceId, sessionAlias],
    );
  }

  deleteByInstance(instanceId: string): void {
    this.db.run("DELETE FROM turn_slot_anchors WHERE instance_id = ?", [instanceId]);
  }

  private toAnchor(row: {
    instance_id: string;
    session_alias: string;
    recovery_id: string;
    slot_after_id: number;
    started_at: number | null;
    started_after_seq: number | null;
  } | undefined): TurnSlotAnchor | undefined {
    if (!row) return undefined;
    return {
      instanceId: row.instance_id,
      sessionAlias: row.session_alias,
      recoveryId: row.recovery_id,
      slotAfterId: row.slot_after_id,
      ...(typeof row.started_at === "number" ? { startedAt: row.started_at } : {}),
      ...(typeof row.started_after_seq === "number" ? { startedAfterSeq: row.started_after_seq } : {}),
    };
  }
}
