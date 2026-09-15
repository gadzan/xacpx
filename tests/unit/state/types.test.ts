import { expect, test } from "bun:test";
import { createEmptyState } from "../../../src/state/types";

test("createEmptyState starts with empty chat_contexts", () => {
  const state = createEmptyState();
  expect(state.chat_contexts).toEqual({});
});

test("createEmptyState starts with empty Bot and Conversation collections", () => {
  const state = createEmptyState();
  expect(state.bots).toEqual({});
  expect(state.conversations).toEqual({});
  expect(state.conversation_topics).toEqual({});
  expect(state.bot_runtime_bindings).toEqual({});
});

test("ChatContextState accepts a background_results map", () => {
  const state = createEmptyState();
  state.chat_contexts["weixin:a:u"] = {
    current_session: "s1",
    background_results: {
      s2: { text: "done", status: "done", finished_at: "2026-05-30T00:00:00.000Z" },
    },
  };
  expect(state.chat_contexts["weixin:a:u"]!.background_results!.s2!.status).toBe("done");
});
