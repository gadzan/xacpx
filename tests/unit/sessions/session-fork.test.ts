import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqlDriver } from "../../../src/conversations/sql-driver";
import { renderSessionForkHandoff } from "../../../src/sessions/session-fork-handoff";
import { resolveSessionForkStrategy, SessionForkStore } from "../../../src/sessions/session-fork-store";

test("a pre-alias database migrates its legacy pending row without wedging", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "session-forks-")), "forks.sqlite");
  const legacy = await createSqlDriver(path);
  legacy.exec(`
    CREATE TABLE session_forks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL UNIQUE,
      source_point TEXT NOT NULL,
      strategy TEXT NOT NULL,
      resolution TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    INSERT INTO session_forks
      (id, request_id, source_session_id, target_session_id, source_point, strategy, status, created_at)
    VALUES ('fork_legacy', 'req-legacy', 'src', 'target', '{"type":"latest_stable"}', 'pending', 'pending', 'x');
  `);
  legacy.close();

  const store = await SessionForkStore.open(path);
  expect(store.getByRequestId("req-legacy")).toMatchObject({
    sourceAlias: "",
    targetAlias: "",
    chatKey: "",
    status: "pending",
  });
  store.deleteForkById("fork_legacy");
  expect(store.getByRequestId("req-legacy")).toBeUndefined();
  store.close();
});
function pending(store: SessionForkStore, target: string, requestId = `req-${target}`) {
  return store.createPending({
    requestId,
    chatKey: "relay:acct",
    sourceSessionId: "src",
    targetSessionId: target,
    sourceAlias: "src-alias",
    targetAlias: `${target}-alias`,
    createdAt: "2026-11-16T00:00:00.000Z",
    targetAgent: "codex",
  });
}

test("deleting a fork removes its record and handoff text together", async () => {
  const store = await SessionForkStore.openInMemory();
  const fork = pending(store, "target", "req-delete");
  store.resolvePortable({
    forkId: fork.id,
    handoff: { text: "<<<HISTORY\nHuman: hi\n>>>END HISTORY", messageCount: 1, omittedMessages: 0 },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
  store.deleteForkById(fork.id);
  expect(store.getByRequestId("req-delete")).toBeUndefined();
  expect(store.getByTargetSessionId("target")).toBeUndefined();
  expect(store.getHandoff(fork.id)).toBeUndefined();
  store.close();
});

test("a pending fork resolves to portable and its handoff is taken exactly once", async () => {
  const store = await SessionForkStore.openInMemory();
  const fork = pending(store, "target");
  expect(fork.strategy).toBe("pending");
  expect(fork.status).toBe("pending");
  expect(resolveSessionForkStrategy({ nativeSessionFork: false })).toBe("portable");

  const resolved = store.resolvePortable({
    forkId: fork.id,
    handoff: { text: "<<<HISTORY\nHuman: hi\n>>>END HISTORY", messageCount: 1, omittedMessages: 0 },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
  expect(resolved.strategy).toBe("portable");
  expect(resolved.status).toBe("ready");
  expect(resolved.resolution).toEqual({ strategy: "portable", reason: "native-fork-unavailable" });

  expect(store.takeHandoff("target", "2026-11-16T00:00:02.000Z")?.text).toContain("<<<HISTORY");
  expect(store.takeHandoff("target", "2026-11-16T00:00:03.000Z")).toBeUndefined();
  expect(store.getByTargetSessionId("target")).toMatchObject({
    status: "consumed",
    consumedAt: "2026-11-16T00:00:02.000Z",
  });
  store.close();
});

test("the rendered handoff is bounded and a fork-of-fork carries its parent block", async () => {
  const store = await SessionForkStore.openInMemory();
  const parent = pending(store, "child", "req-parent");
  const parentText = "<<<HISTORY\nHuman: parent context\n>>>END HISTORY";
  store.resolvePortable({
    forkId: parent.id,
    handoff: { text: parentText, messageCount: 1, omittedMessages: 0 },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
  const rendered = renderSessionForkHandoff({
    sourceTitle: "child",
    agent: "codex",
    history: [
      { role: "user", text: "new question" },
      { role: "agent", text: "new answer" },
    ],
    parentFork: store.getByForkSourceSessionId("child")!,
    parentHandoff: store.getHandoff(parent.id),
    budget: 400,
  });
  expect(rendered.text.startsWith("Historical context from the session")).toBe(true);
  expect(rendered.text.length).toBeLessThanOrEqual(400);
  expect(rendered.text).toContain("Human: new question");
  expect(rendered.text).toContain("parent context");
  store.close();
});

test("a consumed parent handoff is stripped from rows and carried once as the parent block", async () => {
  const store = await SessionForkStore.openInMemory();
  const parent = pending(store, "child", "req-parent");
  const parentText = "<<<HISTORY\nHuman: inherited\n>>>END HISTORY";
  store.resolvePortable({
    forkId: parent.id,
    handoff: { text: parentText, messageCount: 1, omittedMessages: 0 },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
  store.takeHandoff("child", "2026-11-16T00:00:02.000Z");
  const rendered = renderSessionForkHandoff({
    sourceTitle: "child",
    agent: "codex",
    history: [{ role: "user", text: `${parentText}\n\nnew question` }],
    parentFork: store.getByForkSourceSessionId("child")!,
    parentHandoff: store.getHandoff(parent.id),
  });
  expect(rendered.text.match(/inherited/g)?.length).toBe(1);
  expect(rendered.text).not.toContain("Human: <<<HISTORY");
  expect(rendered.text).toContain("Human: new question");
  store.close();
});

test("a bot row quoting a handoff keeps a single fence pair", async () => {
  const store = await SessionForkStore.openInMemory();
  const parent = pending(store, "child", "req-echo");
  const parentText = "<<<HISTORY\nHuman: parent context\n>>>END HISTORY";
  store.resolvePortable({
    forkId: parent.id,
    handoff: { text: parentText, messageCount: 1, omittedMessages: 0 },
    createdAt: "2026-11-16T00:00:01.000Z",
  });
  store.takeHandoff("child", "2026-11-16T00:00:02.000Z");
  const rendered = renderSessionForkHandoff({
    sourceTitle: "child",
    agent: "codex",
    history: [
      { role: "user", text: `${parentText}\n\nchild prompt` },
      { role: "agent", text: `reply saw ${parentText} inline` },
    ],
    parentFork: store.getByForkSourceSessionId("child")!,
    parentHandoff: store.getHandoff(parent.id),
  });
  expect(rendered.text.match(/<<<HISTORY/g)?.length).toBe(1);
  expect(rendered.text.match(/>>>END HISTORY/g)?.length).toBe(1);
  expect(rendered.text).not.toContain("Human: <<<HISTORY");
  expect(rendered.text).toContain("[HISTORY");
  expect(rendered.text).toContain("child prompt");
  store.close();
});

test("a pre-node database gains source_anchor and keeps existing latest_stable records", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "session-forks-node-")), "forks.sqlite");
  const legacy = await createSqlDriver(path);
  legacy.exec(`
    CREATE TABLE session_forks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL UNIQUE,
      source_alias TEXT,
      target_alias TEXT,
      chat_key TEXT,
      source_point TEXT NOT NULL,
      strategy TEXT NOT NULL,
      resolution TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    INSERT INTO session_forks
      (id, request_id, source_session_id, target_session_id, source_point, strategy, status, created_at)
    VALUES ('fork_head', 'req-head', 'src', 'target', '{"type":"latest_stable"}', 'ready', 'ready', 'x');
  `);
  legacy.close();

  const store = await SessionForkStore.open(path);
  expect(store.getByRequestId("req-head")?.sourcePoint).toEqual({ type: "latest_stable" });
  expect(store.getByRequestId("req-head")?.sourceAnchor).toBeUndefined();

  const node = store.createPending({
    requestId: "req-node",
    chatKey: "relay:acct",
    sourceSessionId: "src",
    targetSessionId: "target-node",
    sourceAlias: "src-alias",
    targetAlias: "target-node-alias",
    createdAt: "2026-11-16T00:00:00.000Z",
    sourcePoint: { type: "node", nodeId: "node-1" },
    sourceAnchor: "anchor-digest",
    targetAgent: "codex",
  });
  expect(node.sourcePoint).toEqual({ type: "node", nodeId: "node-1" });
  expect(node.sourceAnchor).toBe("anchor-digest");
  expect(store.getByRequestId("req-node")).toMatchObject({
    sourcePoint: { type: "node", nodeId: "node-1" },
    sourceAnchor: "anchor-digest",
  });
  store.close();
});

test("turn nodes get ordered sequences per session and stay scoped to it", async () => {
  const store = await SessionForkStore.openInMemory();
  const first = store.recordTurnNode({
    nodeId: "node-a",
    sessionId: "logical-a",
    promptDigest: "digest-a",
    createdAt: "2026-11-16T00:00:00.000Z",
  });
  const second = store.recordTurnNode({
    nodeId: "node-b",
    sessionId: "logical-a",
    promptDigest: "digest-b",
    createdAt: "2026-11-16T00:00:01.000Z",
  });
  const other = store.recordTurnNode({
    nodeId: "node-other",
    sessionId: "logical-b",
    promptDigest: "digest-o",
    createdAt: "2026-11-16T00:00:02.000Z",
  });
  expect([first.sequence, second.sequence, other.sequence]).toEqual([0, 1, 0]);
  expect(store.listTurnNodes("logical-a").map((node) => node.nodeId)).toEqual(["node-a", "node-b"]);
  expect(store.getTurnNode("logical-a", "node-b")?.promptDigest).toBe("digest-b");
  expect(store.getTurnNode("logical-b", "node-b")).toBeUndefined();
  store.close();
});

test("a pre-agent database gains target_agent and keeps legacy rows agentless", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "session-forks-agent-")), "forks.sqlite");
  const legacy = await createSqlDriver(path);
  legacy.exec(`
    CREATE TABLE session_forks (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL UNIQUE,
      source_alias TEXT,
      target_alias TEXT,
      chat_key TEXT,
      source_point TEXT NOT NULL,
      source_anchor TEXT,
      strategy TEXT NOT NULL,
      resolution TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    );
    INSERT INTO session_forks
      (id, request_id, source_session_id, target_session_id, source_alias, target_alias, chat_key, source_point, strategy, status, created_at)
    VALUES ('fork_pre_agent', 'req-pre-agent', 'src', 'target', 'src-alias', 'target-alias', 'relay:acct', '{"type":"latest_stable"}', 'portable', 'ready', 'x');
  `);
  legacy.close();

  const store = await SessionForkStore.open(path);
  expect(store.getByRequestId("req-pre-agent")?.targetAgent).toBeUndefined();
  const switched = store.createPending({
    requestId: "req-switch",
    chatKey: "relay:acct",
    sourceSessionId: "src",
    targetSessionId: "target-switch",
    sourceAlias: "src-alias",
    targetAlias: "target-switch-alias",
    createdAt: "2026-11-19T00:00:00.000Z",
    targetAgent: "claude",
  });
  expect(switched.targetAgent).toBe("claude");
  expect(store.getByRequestId("req-switch")?.targetAgent).toBe("claude");
  store.close();
});
