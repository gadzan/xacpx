import type { SqlDriver } from "../db.js";

/** One durable Hub-side completion ROUTE grant (v0.3). Authorization metadata
 *  only — never result bodies. Rows survive Hub restarts so an already-accepted
 *  completion contract cannot be revoked by an infrastructure restart. */
export interface PendingCompletionRouteRow {
  requestMessageId: string;
  accountId: string;
  sourceInstanceId: string;
  source: { nodeId: string; endpointId: string };
  targetInstanceId: string;
  target: { nodeId: string; endpointId: string };
  mode: "notify" | "result";
  expiresAt: number;
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
    }));
  }

  /** Full replace — the in-memory map is authoritative; the table mirrors it. */
  save(grants: PendingCompletionRouteRow[]): void {
    this.db.run("DELETE FROM pending_completion_routes");
    for (const g of grants) {
      this.db.run(
        `INSERT INTO pending_completion_routes (
           request_message_id, account_id, source_instance_id,
           source_node_id, source_endpoint_id,
           target_instance_id, target_node_id, target_endpoint_id,
           mode, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          g.requestMessageId,
          g.accountId,
          g.sourceInstanceId,
          g.source.nodeId,
          g.source.endpointId,
          g.targetInstanceId,
          g.target.nodeId,
          g.target.endpointId,
          g.mode,
          g.expiresAt,
        ],
      );
    }
  }
}
