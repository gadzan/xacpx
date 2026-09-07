import { describe, expect, test } from "bun:test";
import {
  createTranscriptTextBoundaryState,
  markTranscriptActivity,
  normalizeTranscriptTextChunk,
  endsWithSentenceTerminal,
  hasParagraphBoundaryAtJoin,
} from "../../../src/transport/transcript-text-boundary";

describe("Transcript Text Boundary State Machine (spec §26-§27)", () => {
  test("initial state has hasAgentMessage=false and activitySinceLastText=false", () => {
    const state = createTranscriptTextBoundaryState();
    expect(state.hasAgentMessage).toBe(false);
    expect(state.activitySinceLastText).toBe(false);
    expect(state.lastMessageId).toBeUndefined();
    expect(state.lastTextTail).toBe("");
  });

  test("activity before any agent message does not set activitySinceLastText", () => {
    const state = createTranscriptTextBoundaryState();
    markTranscriptActivity(state);
    expect(state.activitySinceLastText).toBe(false);

    // First text chunk has no leading \n\n even after early activity
    const chunk = normalizeTranscriptTextChunk(state, { text: "Hello" });
    expect(chunk).toBe("Hello");
    expect(state.hasAgentMessage).toBe(true);
  });

  test("activity after agent message sets activitySinceLastText", () => {
    const state = createTranscriptTextBoundaryState();
    normalizeTranscriptTextChunk(state, { text: "Initial text." });
    expect(state.hasAgentMessage).toBe(true);
    expect(state.activitySinceLastText).toBe(false);

    markTranscriptActivity(state);
    expect(state.activitySinceLastText).toBe(true);
  });

  test("endsWithSentenceTerminal correctly identifies sentence terminals and punctuation", () => {
    expect(endsWithSentenceTerminal("Hello.")).toBe(true);
    expect(endsWithSentenceTerminal("Hello!")).toBe(true);
    expect(endsWithSentenceTerminal("Hello?")).toBe(true);
    expect(endsWithSentenceTerminal("Hello。")).toBe(true);
    expect(endsWithSentenceTerminal("Hello！")).toBe(true);
    expect(endsWithSentenceTerminal("Hello…")).toBe(true);
    expect(endsWithSentenceTerminal('Hello."')).toBe(true);
    expect(endsWithSentenceTerminal("Hello.” ")).toBe(true);
    expect(endsWithSentenceTerminal("Hello.*")).toBe(true);

    expect(endsWithSentenceTerminal("Hello")).toBe(false);
    expect(endsWithSentenceTerminal("Result:")).toBe(false);
    expect(endsWithSentenceTerminal("comma,")).toBe(false);
    expect(endsWithSentenceTerminal("")).toBe(false);
  });

  test("hasParagraphBoundaryAtJoin detects various paragraph boundary formats", () => {
    // Boundary at end of left
    expect(hasParagraphBoundaryAtJoin("first\n\n", "second")).toBe(true);
    expect(hasParagraphBoundaryAtJoin("first\r\n\r\n", "second")).toBe(true);

    // Boundary at start of right
    expect(hasParagraphBoundaryAtJoin("first", "\n\nsecond")).toBe(true);
    expect(hasParagraphBoundaryAtJoin("first", "\r\n\r\nsecond")).toBe(true);

    // Boundary spanning join (\n + \n)
    expect(hasParagraphBoundaryAtJoin("first\n", "\nsecond")).toBe(true);
    expect(hasParagraphBoundaryAtJoin("first\r\n", "\r\nsecond")).toBe(true);

    // CRLF split inside line break (\r\n\r + \n)
    expect(hasParagraphBoundaryAtJoin("first\r\n\r", "\nsecond")).toBe(true);

    // Single line break is NOT a paragraph boundary
    expect(hasParagraphBoundaryAtJoin("first\n", "second")).toBe(false);
    expect(hasParagraphBoundaryAtJoin("first", "\nsecond")).toBe(false);
    expect(hasParagraphBoundaryAtJoin("first", "second")).toBe(false);
  });

  test("empty text chunk returns empty string and does not alter state", () => {
    const state = createTranscriptTextBoundaryState();
    const result = normalizeTranscriptTextChunk(state, { text: "", messageId: "m1" });
    expect(result).toBe("");
    expect(state.lastMessageId).toBeUndefined();
  });
});
