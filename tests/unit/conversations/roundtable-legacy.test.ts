import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
test("a pre-roundtable database reads old Runs as fanout and old turns without round fields", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-roundtable-legacy-")), "conversations.sqlite");
  const sql = await createSqlDriver(path);
  sql.exec(readFileSync(join(import.meta.dir, "fixtures/pr8-explicit-queued.sql"), "utf8"));
  sql.close();
  const store = await SqliteConversationStore.open(path);
  try {
    const run = store.getRun("run_pr8_explicit")!;
    expect(run.shape).toBe("fanout");
    expect(run.rounds).toBeUndefined();
    expect(run.leadBotId).toBeUndefined();
    const turns = store.listMemberTurns(run.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ state: "queued", origin: "human-explicit" });
    expect(turns[0]!.roundIndex).toBeUndefined();
    expect(turns[0]!.speakerIndex).toBeUndefined();
    expect(turns[0]!.speechOutcome).toBeUndefined();
    // The migrated store still claims the legacy queued work in its original
    // order — no roundtable floor applies to a row without round_index.
    const claimed = store.claimNextDispatch({
      owner: "owner", now: "2026-11-06T00:00:00.000Z", leaseExpiresAt: "2026-11-06T01:00:00.000Z",
    });
    expect(claimed?.run.id).toBe(run.id);
    expect(claimed?.memberTurn.id).toBe(turns[0]!.id);
  } finally {
    store.close();
  }
});
