import type { PlanEntryDto, ToolStepDto } from "@ganglion/xacpx-relay-protocol";

export interface MemberTurnTraceIdentity {
  conversationId: string;
  topicId: string;
  runId: string;
  botId: string;
  memberTurnId: string;
  attempt: number;
  sourceTurnId: string;
}

export type MemberTurnTraceQuery = Pick<MemberTurnTraceIdentity,
  "conversationId" | "topicId" | "runId" | "memberTurnId" | "attempt"> &
  Partial<Pick<MemberTurnTraceIdentity, "botId" | "sourceTurnId">>;

export type MemberTurnTraceInputEvent =
  | { kind: "text" | "reasoning"; payload: { text: string }; createdAt: string }
  | { kind: "tool"; payload: { step: ToolStepDto }; createdAt: string }
  | { kind: "plan"; payload: { entries: PlanEntryDto[] }; createdAt: string }
  | { kind: "terminal"; payload: { ok: boolean; cancelled?: boolean; errorMessage?: string }; createdAt: string };

export type MemberTurnTraceEvent = MemberTurnTraceInputEvent & { seq: number };
export type MemberTurnTraceRecordingState = "recording" | "complete" | "interrupted" | "unavailable";

export interface MemberTurnTraceRecord {
  identity: MemberTurnTraceIdentity;
  recordingState: MemberTurnTraceRecordingState;
  completenessReason?: string;
  plan?: PlanEntryDto[];
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface MemberTurnTracePage extends MemberTurnTraceRecord {
  events: MemberTurnTraceEvent[];
  nextSeq: number;
  hasMore: boolean;
}

export interface MemberTurnTracePageOptions {
  afterSeq?: number;
  limit?: number;
  maxBytes?: number;
}

export interface MemberTurnTraceBatchResult {
  reused: boolean;
  firstSeq: number;
  lastSeq: number;
  recordingState: MemberTurnTraceRecordingState;
}
