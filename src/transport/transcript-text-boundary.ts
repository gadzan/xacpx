/**
 * Shared state machine for transcript text boundary normalization (spec §26-§27).
 * Reconstructs logical agent message paragraph boundaries across raw streaming
 * chunks, messageId transitions, and activity (tool/thought) interruptions.
 */

export interface TranscriptTextBoundaryState {
  hasAgentMessage: boolean;
  lastMessageId?: string;
  lastTextTail: string;
  activitySinceLastText: boolean;
}

export function createTranscriptTextBoundaryState(): TranscriptTextBoundaryState {
  return {
    hasAgentMessage: false,
    lastMessageId: undefined,
    lastTextTail: "",
    activitySinceLastText: false,
  };
}

export function markTranscriptActivity(state: TranscriptTextBoundaryState): void {
  state.activitySinceLastText = state.hasAgentMessage;
}

const SENTENCE_TERMINAL_AT_END =
  /(?:\p{Sentence_Terminal}|…|⋯)[\p{Close_Punctuation}\p{Final_Punctuation}"“”‘’*_~`]*$/u;
const PARAGRAPH_BOUNDARY_AT_END = /\r?\n[\t ]*\r?\n[\t ]*$/;
const PARAGRAPH_BOUNDARY_AT_START = /^[\t ]*\r?\n[\t ]*\r?\n/;
const LINE_BREAK_AT_END = /\r?\n[\t ]*$/;
const LINE_BREAK_AT_START = /^[\t ]*\r?\n/;
const PARTIAL_CRLF_PARAGRAPH_BOUNDARY_AT_END = /\r?\n[\t ]*\r$/;

export function endsWithSentenceTerminal(text: string): boolean {
  return SENTENCE_TERMINAL_AT_END.test(text.trimEnd());
}

export function hasParagraphBoundaryAtJoin(left: string, right: string): boolean {
  const leftHasBoundary = PARAGRAPH_BOUNDARY_AT_END.test(left);
  const rightHasBoundary = PARAGRAPH_BOUNDARY_AT_START.test(right);
  const boundarySpansJoin =
    LINE_BREAK_AT_END.test(left) &&
    LINE_BREAK_AT_START.test(right);
  const crlfBoundarySpansJoin =
    PARTIAL_CRLF_PARAGRAPH_BOUNDARY_AT_END.test(left) &&
    right.startsWith("\n");
  return leftHasBoundary || rightHasBoundary || boundarySpansJoin || crlfBoundarySpansJoin;
}

export function normalizeTranscriptTextChunk(
  state: TranscriptTextBoundaryState,
  input: {
    text: string;
    messageId?: string;
  },
): string {
  let chunk = input.text;
  if (chunk.length === 0) return chunk;
  state.hasAgentMessage = true;

  const messageId =
    typeof input.messageId === "string" && input.messageId.length > 0
      ? input.messageId
      : undefined;
  const messageIdChanged =
    state.lastMessageId !== undefined &&
    messageId !== undefined &&
    state.lastMessageId !== messageId;
  const fallbackBoundary =
    state.activitySinceLastText &&
    (state.lastMessageId === undefined || messageId === undefined) &&
    endsWithSentenceTerminal(state.lastTextTail);
  if ((messageIdChanged || fallbackBoundary) && !hasParagraphBoundaryAtJoin(state.lastTextTail, chunk)) {
    chunk = `\n\n${chunk}`;
    state.lastTextTail = "";
  }

  state.lastMessageId = messageId;
  state.activitySinceLastText = false;
  state.lastTextTail = `${state.lastTextTail}${chunk}`.slice(-256);

  return chunk;
}
