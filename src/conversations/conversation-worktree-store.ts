import type { SqlDriver } from "./sql-driver";
import { ConversationError } from "./conversation-error";
import { parseWorktreeRun, type ConversationWorktreeBase, type ConversationWorktreeRun } from "./conversation-worktree-types";

/** Shares the Conversation transaction and database; never cascades result ownership. */
export class ConversationWorktreeStore {
  constructor(private readonly sql: SqlDriver) {
    sql.exec(`CREATE TABLE IF NOT EXISTS conversation_worktree_runs (
      run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, topic_id TEXT NOT NULL,
      revision INTEGER NOT NULL, record_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS conversation_worktree_topic ON conversation_worktree_runs(topic_id);`);
  }
  create(runId: string, conversationId: string, topicId: string, base: ConversationWorktreeBase, now: string): void {
    for (const r of this.list(conversationId, topicId)) if (r.disposition === "pending") {
      throw new ConversationError("worktree_integration_pending", "integrate or explicitly abandon the previous worktree Run first", { runId: r.runId });
    }
    const row: ConversationWorktreeRun = { ...base, version: 1, runId, conversationId, topicId, revision: 1,
      disposition: "pending", createdAt: now, updatedAt: now, resources: [] };
    parseWorktreeRun(row);
    this.sql.run("INSERT INTO conversation_worktree_runs VALUES (?, ?, ?, ?, ?)", [runId, conversationId, topicId, 1, JSON.stringify(row)]);
  }
  get(runId: string): ConversationWorktreeRun | undefined {
    const row = this.sql.get<{ record_json: string; revision: number; conversation_id: string; topic_id: string }>(
      "SELECT * FROM conversation_worktree_runs WHERE run_id = ?", [runId]);
    if (!row) return undefined;
    let value: unknown; try { value = JSON.parse(row.record_json); } catch { throw new ConversationError("worktree_registry_corrupt", "malformed worktree record"); }
    const r = parseWorktreeRun(value);
    if (r.runId !== runId || r.revision !== row.revision || r.conversationId !== row.conversation_id || r.topicId !== row.topic_id) {
      throw new ConversationError("worktree_registry_corrupt", "worktree record identity differs from its index");
    }
    return r;
  }
  list(conversationId?: string, topicId?: string): ConversationWorktreeRun[] {
    return this.sql.all<{ run_id: string }>("SELECT run_id FROM conversation_worktree_runs"
      + (conversationId ? " WHERE conversation_id = ?" + (topicId ? " AND topic_id = ?" : "") : "") + " ORDER BY rowid",
    conversationId ? topicId ? [conversationId, topicId] : [conversationId] : []).map(r => this.get(r.run_id)!);
  }
  save(row: ConversationWorktreeRun): ConversationWorktreeRun {
    const current = this.get(row.runId);
    if (current && current.revision !== row.revision) throw new ConversationError("worktree_revision_conflict", "worktree operation lost its durable revision");
    if (!current || ["conversationId", "topicId", "workspace", "sourceRoot", "commonDir", "repositoryIdentity", "baseCommitSha"].some(
      key => current[key as keyof ConversationWorktreeRun] !== row[key as keyof ConversationWorktreeRun])) {
      throw new ConversationError("worktree_identity_mismatch", "accepted repository identity is immutable");
    }
    if (current.disposition !== "pending" && current.disposition !== row.disposition) {
      throw new ConversationError("worktree_identity_mismatch", "final worktree disposition is immutable");
    }
    for (const previous of current.resources) {
      const resource = row.resources.find(r => r.id === previous.id);
      if (!resource || ["botId", "kind", "generation", "branchRef", "worktreePath", "ownerToken", "createdAt"].some(
        key => previous[key as keyof typeof previous] !== resource[key as keyof typeof resource])
        || (previous.gitDir !== undefined && previous.gitDir !== resource.gitDir)
        || ["snapshotParent", "snapshotTree", "snapshotSha", "patchSha"].some(key => previous[key as keyof typeof previous] !== undefined
          && previous[key as keyof typeof previous] !== resource[key as keyof typeof resource])) {
        throw new ConversationError("worktree_identity_mismatch", "owned worktree identity is immutable");
      }
    }
    if (current.integration && (!row.integration || ["id", "generation", "operationSource", "requestId", "previewId", "resourceId", "createdAt", "orderedBotIds"].some(
      key => JSON.stringify(current.integration![key as keyof typeof current.integration]) !== JSON.stringify(row.integration![key as keyof typeof row.integration]))
      || JSON.stringify(current.preview) !== JSON.stringify(row.preview)
      || row.integration.nextIndex < current.integration.nextIndex
      || (current.integration.patches.length > 0 && JSON.stringify(current.integration.patches) !== JSON.stringify(row.integration.patches)))) {
      throw new ConversationError("worktree_identity_mismatch", "authorized integration identity and cursor are immutable");
    }
    const next = parseWorktreeRun({ ...row, revision: row.revision + 1, updatedAt: new Date().toISOString() });
    const result = this.sql.get<{ revision: number }>(
      "UPDATE conversation_worktree_runs SET revision = ?, record_json = ? WHERE run_id = ? AND revision = ? RETURNING revision",
      [next.revision, JSON.stringify(next), row.runId, row.revision]);
    if (!result) throw new ConversationError("worktree_revision_conflict", "worktree operation lost its durable revision");
    return next;
  }
}
