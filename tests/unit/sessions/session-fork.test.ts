import { expect, test } from "bun:test";

import { renderSessionForkHandoff } from "../../../src/sessions/session-fork-handoff";
import { resolveSessionForkStrategy, SessionForkStore } from "../../../src/sessions/session-fork-store";

function pending(store: SessionForkStore, target: string, requestId = `req-${target}`) {
  return store.createPending({
    requestId,
    sourceSessionId: "src",
    targetSessionId: target,
    sourceAlias: "src-alias",
    targetAlias: `${target}-alias`,
    createdAt: "2026-11-16T00:00:00.000Z",
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
