import type { SqlDriver } from "../db.js";

/** One durable Hub-side completion ROUTE grant (v0.3). Authorization metadata
 *  only — never result bodies. Rows survive Hub restarts so an already-accepted
 *  completion contract cannot be revoked by an infrastructure restart.
 *
 *  Lifecycle: state = "pending" while the completion has not been accepted by
 *  the source; state = "delivered" once the source acknowledged ({ok:true}).
 *  A delivered row is a TERMINAL TOMBSTONE: an at-least-once replay of the
 *  same completion (Hub success ACK lost to the target) is answered
 *  { ok: true, deduplicated: true } instead of DELIVERY_DENIED.
 *
 *  Mutations are ROW-LEVEL atomic single-statement upserts/deletes/updates: a
 *  crash between operations can never leave a half-replaced grant table
 *  behind. The store NEVER overwrites an existing requestMessageId with a
 *  different fingerprint — use find() + compare and INSERT-only upsert. */
export interface PendingCompletionRouteRow {
  requestMessageId: string;
  accountId: string;
  sourceInstanceId: string;
  source: { nodeId: string; endpointId: string };
  targetInstanceId: string;
  target: { nodeId: string; endpointId: string };
  mode: "notify" | "result";
  expiresAt: number;
  state: "pending" | "delivered";
}

export class PendingCompletionRouteStore {
  constructor(private readonly db: SqlDriver) {}

  load(): PendingCompletionRouteRow[] {
    const rows = this.db.all<{
      request_message_id: string;
      account_id: string;
      source_instance_id: string;
      source_node_id: string;
      source_endpoint_id: string;
      target_instance_id: string;
      target_node_id: string;
      target_endpoint_id: string;
      mode: string;
      expires_at: number;
      state: string;
    }>("SELECT * FROM pending_completion_routes");
    return rows.map((row) => ({
      requestMessageId: row.request_message_id,
      accountId: row.account_id,
      sourceInstanceId: row.source_instance_id,
      source: { nodeId: row.source_node_id, endpointId: row.source_endpoint_id },
      targetInstanceId: row.target_instance_id,
      target: { nodeId: row.target_node_id, endpointId: row.target_endpoint_id },
      mode: row.mode === "notify" ? "notify" : "result",
      expiresAt: row.expires_at,
      state: row.state === "delivered" ? "delivered" : "pending",
    }));
  }

  find(requestMessageId: string): PendingCompletionRouteRow | undefined {
    return this.load().find((row) => row.requestMessageId === requestMessageId);
  }

  /** INSERT-only: an existing requestMessageId is NEVER overwritten (fingerprint
   *  conflicts are detected by the caller via find()). Throws on storage failure. */
  insert(grant: PendingCompletionRouteRow): void {
    this.db.run(
      `INSERT INTO pending_completion_routes (
         request_message_id, account_id, source_instance_id,
         source_node_id, source_endpoint_id,
         target_instance_id, target_node_id, target_endpoint_id,
         mode, expires_at, state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grant.requestMessageId,
        grant.accountId,
        grant.sourceInstanceId,
        grant.source.nodeId,
        grant.source.endpointId,
        grant.targetInstanceId,
        grant.target.nodeId,
        grant.target.endpointId,
        grant.mode,
        grant.expiresAt,
        grant.state,
      ],
    );
  }

  markDelivered(requestMessageId: string): void {
    this.db.run(
      "UPDATE pending_completion_routes SET state = 'delivered' WHERE request_message_id = ?",
      [requestMessageId],
    );
  }

  delete(requestMessageId: string): void {
    this.db.run(
      "DELETE FROM pending_completion_routes WHERE request_message_id = ?",
      [requestMessageId],
    );
  }
}
