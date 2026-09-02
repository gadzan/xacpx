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
 * Durable live-slot identity for an in-flight turn. Written at Hub `turn-started`
 * (last persisted `messages.id` for the session) so a Hub restart can flush the
 * `out` row into the same slot without guessing from peer/hub/browser clocks.
 *
 * Keyed by `(instance_id, recovery_id)` so a finished-offline entry and a later
 * running turn on the same alias cannot steal each other's anchor. Empty
 * `recovery_id` is the legacy/session fallback when the connector omitted it.
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

  getBySession(instanceId: string, sessionAlias: string): TurnSlotAnchor | undefined {
    return this.toAnchor(this.db.get<{
      instance_id: string;
      session_alias: string;
      recovery_id: string;
      slot_after_id: number;
      started_at: number | null;
      started_after_seq: number | null;
    }>(
      `SELECT instance_id, session_alias, recovery_id, slot_after_id, started_at, started_after_seq
       FROM turn_slot_anchors WHERE instance_id = ? AND session_alias = ?
       ORDER BY rowid DESC LIMIT 1`,
      [instanceId, sessionAlias],
    ));
  }

  /** Lookup then delete. Prefer `recoveryId`; fall back to the session's latest row. */
  take(instanceId: string, sessionAlias: string, recoveryId?: string): TurnSlotAnchor | undefined {
    const row = recoveryId
      ? (this.get(instanceId, recoveryId) ?? this.getBySession(instanceId, sessionAlias))
      : this.getBySession(instanceId, sessionAlias);
    if (!row) return undefined;
    this.db.run(
      "DELETE FROM turn_slot_anchors WHERE instance_id = ? AND recovery_id = ?",
      [row.instanceId, row.recoveryId],
    );
    return row;
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
