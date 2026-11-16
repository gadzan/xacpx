import { expect, test } from "bun:test";

import {
  resolveSessionForkNode,
  sessionForkPrefixAnchor,
  sessionForkPromptDigest,
} from "../../../src/sessions/session-fork-node";
import type { SessionForkTurnNode } from "../../../src/sessions/session-fork-store";

const HISTORY = [
  { role: "user" as const, text: "first question" },
  { role: "agent" as const, text: "first answer" },
  { role: "user" as const, text: "second question" },
  { role: "agent" as const, text: "second answer" },
  { role: "user" as const, text: "third question" },
  { role: "agent" as const, text: "third answer" },
];

function nodesOf(history: typeof HISTORY, sessionId = "logical-src"): SessionForkTurnNode[] {
  const nodes: SessionForkTurnNode[] = [];
  for (const message of history) {
    if (message.role !== "user") continue;
    nodes.push({
      nodeId: `node-${nodes.length}`,
      sessionId,
      sequence: nodes.length,
      promptDigest: sessionForkPromptDigest(message.text),
      createdAt: "2026-11-16T00:00:00.000Z",
    });
  }
  return nodes;
}

test("a node cut includes exactly its own turn and reply", () => {
  const resolved = resolveSessionForkNode({ history: HISTORY, nodes: nodesOf(HISTORY), nodeId: "node-1" });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.userTurnIndex).toBe(1);
  expect(resolved.prefix.map((message) => message.text)).toEqual([
    "first question",
    "first answer",
    "second question",
    "second answer",
  ]);
});

test("source growth after the node leaves the prefix and anchor unchanged", () => {
  const nodes = nodesOf(HISTORY);
  const original = resolveSessionForkNode({ history: HISTORY, nodes, nodeId: "node-1" });
  if (!original.ok) throw new Error("expected a node");
  const grown = [
    ...HISTORY,
    { role: "user" as const, text: "fourth question" },
    { role: "agent" as const, text: "fourth answer" },
  ];
  const replay = resolveSessionForkNode({
    history: grown,
    nodes,
    nodeId: "node-1",
    expectedAnchor: original.anchor,
  });
  expect(replay.ok).toBe(true);
  if (!replay.ok) return;
  expect(replay.prefix).toEqual(original.prefix);
  expect(replay.anchor).toBe(original.anchor);
});

test("a rewritten node prompt fails closed, including when an anchor was stored", () => {
  const nodes = nodesOf(HISTORY);
  const original = resolveSessionForkNode({ history: HISTORY, nodes, nodeId: "node-1" });
  if (!original.ok) throw new Error("expected a node");
  const rewritten = HISTORY.map((message, index) =>
    index === 2 ? { ...message, text: "edited question" } : message);
  expect(resolveSessionForkNode({ history: rewritten, nodes, nodeId: "node-1" })).toEqual({
    ok: false,
    reason: "source-changed",
  });
  expect(resolveSessionForkNode({
    history: rewritten,
    nodes,
    nodeId: "node-1",
    expectedAnchor: original.anchor,
  })).toEqual({ ok: false, reason: "source-changed" });
});

test("a cleared record fails closed", () => {
  expect(resolveSessionForkNode({ history: [], nodes: nodesOf(HISTORY), nodeId: "node-1" })).toEqual({
    ok: false,
    reason: "source-changed",
  });
});

test("an unknown node id is reported as unavailable", () => {
  expect(resolveSessionForkNode({ history: HISTORY, nodes: nodesOf(HISTORY), nodeId: "node-missing" })).toEqual({
    ok: false,
    reason: "node-unavailable",
  });
});

test("identical prompt text is disambiguated by the recorded ordinal or fails closed", () => {
  const duplicated = [
    { role: "user" as const, text: "same" },
    { role: "agent" as const, text: "one" },
    { role: "user" as const, text: "same" },
    { role: "agent" as const, text: "two" },
  ];
  const digest = sessionForkPromptDigest("same");
  const aligned: SessionForkTurnNode[] = [
    { nodeId: "first", sessionId: "s", sequence: 0, promptDigest: digest, createdAt: "t" },
    { nodeId: "second", sessionId: "s", sequence: 1, promptDigest: digest, createdAt: "t" },
  ];
  const second = resolveSessionForkNode({ history: duplicated, nodes: aligned, nodeId: "second" });
  expect(second.ok && second.prefix.map((message) => message.text)).toEqual(["same", "one", "same", "two"]);

  const misaligned: SessionForkTurnNode[] = [
    { nodeId: "a", sessionId: "s", sequence: 0, promptDigest: "other-a", createdAt: "t" },
    { nodeId: "b", sessionId: "s", sequence: 1, promptDigest: "other-b", createdAt: "t" },
    { nodeId: "target", sessionId: "s", sequence: 2, promptDigest: digest, createdAt: "t" },
  ];
  expect(resolveSessionForkNode({ history: duplicated, nodes: misaligned, nodeId: "target" })).toEqual({
    ok: false,
    reason: "node-ambiguous",
  });
});

test("the prefix anchor ignores rows after the cut", () => {
  const prefix = HISTORY.slice(0, 4);
  expect(sessionForkPrefixAnchor(prefix)).toBe(sessionForkPrefixAnchor([...prefix]));
  expect(sessionForkPrefixAnchor(prefix)).not.toBe(sessionForkPrefixAnchor(HISTORY.slice(0, 2)));
});
