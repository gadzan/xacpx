import { test, expect } from "bun:test";
import {
  MSG,
  parseControlPayload,
  validAgentMentions,
} from "../../../../packages/relay-protocol/src";
test("Direct references validate UTF-16 half-open non-overlapping ranges", () => {
  expect(
    validAgentMentions("😀 @B", [{ range: [3, 5], handle: "agent:n:b" }]),
  ).toBe(true);
  for (const value of [
    null,
    {},
    [{ range: [3, 18], handle: "h" }],
    [{ range: [1.5, 3], handle: "h" }],
    [
      { range: [0, 2], handle: "h" },
      { range: [1, 3], handle: "h" },
    ],
    Array.from({ length: 17 }, (_, i) => ({ range: [i, i + 1], handle: "h" })),
    [{ range: [0, 1], handle: "h", authority: true }],
  ])
    expect(validAgentMentions("x".repeat(17), value)).toBe(false);
});
test("completion scope parses a bounded query/page and rejects confused payloads", () => {
  expect(
    parseControlPayload(MSG.conversationCompletionsGet, {
      conversationId: "c",
      topicId: "t",
      query: "bot",
      cursor: 64,
    }),
  ).toEqual({ conversationId: "c", topicId: "t", query: "bot", cursor: 64 });
  for (const value of [
    { conversationId: "c" },
    { conversationId: "c", topicId: "t", cursor: -1 },
    { conversationId: "c", topicId: "t", query: "x".repeat(129) },
    { conversationId: "c", topicId: "t", sessionAlias: "hidden" },
  ])
    expect(
      parseControlPayload(MSG.conversationCompletionsGet, value),
    ).toBeNull();
});
