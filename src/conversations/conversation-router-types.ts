import type { WorkspaceIsolationPolicy } from "./conversation-types";

/**
 * PR8 stateless Conversation Router contract (design §12).
 *
 * A Router is NOT a persistent product participant: it owns no visible
 * assistant message, no hidden conversational session, and no Bot runtime
 * context. Each `decide` call is driven exclusively by the explicit
 * `RoutingInput` supplied for the current Run.
 *
 * Implementations MAY reuse a warm model process for performance, but the
 * SEMANTIC decision must be stateless with respect to prior Router calls:
 * nothing in `RoutingInput` may be derived from Router-side conversational
 * history. The composition builds the input from durable Conversation store
 * rows plus live Group/Bot metadata only.
 */
export interface ConversationRouter {
  /** The durable capability restriction this Router implementation can prove
   *  BEFORE execution. See `RouterCapabilityRestriction` / `isRouterCapabilityRestricted`. */
  readonly capabilityRestriction: RouterCapabilityRestriction;
  decide(input: RoutingInput): Promise<RoutingDecision>;
}

/**
 * The Router's own capability boundary (design §12.2, PR8 §11.3).
 *
 * Automatic mode is enabled for a configuration ONLY when the adapter can
 * prove, before execution starts, that the Router has:
 *
 * - no tools
 * - no filesystem / terminal capability
 * - no permission interaction
 * - no Agent Messaging / Orchestration side effects
 * - bounded structured output only
 *
 * This is a DECLARATION the adapter must justify at construction time (an
 * enforced launch configuration, not an observation). Post-hoc "no tool event
 * was observed" is never a proof: fact, this is a pre-execution capability
 * restriction, and anything that cannot be proven up front fails closed.
 */
export interface RouterCapabilityRestriction {
  toolsDisabled: boolean;
  filesystemDisabled: boolean;
  terminalDisabled: boolean;
  permissionInteractionDisabled: boolean;
  messagingDisabled: boolean;
  orchestrationDisabled: boolean;
  structuredOutputOnly: boolean;
}

export const UNRESTRICTED_ROUTER_CAPABILITY: RouterCapabilityRestriction = {
  toolsDisabled: false,
  filesystemDisabled: false,
  terminalDisabled: false,
  permissionInteractionDisabled: false,
  messagingDisabled: false,
  orchestrationDisabled: false,
  structuredOutputOnly: false,
};

/**
 * Fail-closed capability gate. Every restriction must be proven. A missing or
 * malformed declaration reads as unproven, so automatic mode is unsupported
 * for that configuration — the caller must refuse rather than run a Router
 * that could touch the world.
 */
export function isRouterCapabilityRestricted(
  restriction: RouterCapabilityRestriction | undefined,
): restriction is RouterCapabilityRestriction {
  if (!restriction || typeof restriction !== "object") {
    return false;
  }
  return restriction.toolsDisabled === true
    && restriction.filesystemDisabled === true
    && restriction.terminalDisabled === true
    && restriction.permissionInteractionDisabled === true
    && restriction.messagingDisabled === true
    && restriction.orchestrationDisabled === true
    && restriction.structuredOutputOnly === true;
}

/** One member's public metadata for the Router. Deliberately narrow: opaque
 *  product ids plus human-facing presentation and durable execution
 *  capability. Never the Bot's private instruction text (it is execution
 *  configuration, not routing evidence) and never session alias/history. */
export interface RoutingMember {
  botId: string;
  name: string;
  role?: string;
  agent: string;
  workspace: string;
  model?: string;
  effort?: string;
  /** Disabled Bots stay routable in metadata but are never executable; the
   *  Router sees the flag so it must choose somebody else rather than have
   *  the server repair a disabled selection. */
  enabled: boolean;
}

/** Public execution-target policy in force for this Run's Topic. */
export interface RoutingExecutionTarget {
  workspace: string;
  cwd?: string;
  isolation: WorkspaceIsolationPolicy;
}

export type RoutingAssignmentOutcome = "completed" | "failed" | "cancelled" | "indeterminate";

/** One finished assignment's durable evidence. This — not Router memory —
 *  is what a sequential assignment may build on. */
export interface RoutingAssignmentRecord {
  id: string;
  botId: string;
  task: string;
  expectedOutput?: string;
  dependsOn: string[];
  triggerMessageIds: string[];
  outcome: RoutingAssignmentOutcome;
  /** Public transcript result text (completed only). */
  result?: string;
  /** Machine-readable failure reason (failed only). */
  failureReason?: string;
  attempt: number;
  batch: number;
}

/** Current Run state projected for the Router: everything it may reason with,
 *  nothing it must not. No private/Direct/other-Topic content. */
export interface RoutingRunState {
  runId: string;
  conversationId: string;
  topicId: string;
  mode: "automatic";
  generation: number;
  activeBatch?: number;
  maxMemberTurns: number;
  consumedMemberTurns: number;
  failedBotIds: string[];
}

/**
 * Everything a Router call may consume, from one explicit snapshot.
 *
 * Bounds are the caller's responsibility: `publicTranscript` is a bounded
 * newest-first window of THIS Topic's public rows (never Direct, private, or
 * another Topic), `memberMetadata` is current live membership, and
 * `completedAssignments` is the durable evidence already produced by this Run.
 */
export interface RoutingInput {
  runId: string;
  conversationId: string;
  topicId: string;
  /** The Run's own human request message content. */
  request: string;
  requestMessageId: string;
  /** Bounded public Topic transcript (newest-first, public rows only). */
  publicTranscript: Array<{
    id: string;
    seq: number;
    role: "human" | "bot" | "system";
    senderBotId?: string;
    content: string;
    runId?: string;
  }>;
  memberMetadata: RoutingMember[];
  runState: RoutingRunState;
  /** Durable evidence from this Run's assignments so far. */
  completedAssignments: RoutingAssignmentRecord[];
  /** Turns still available to spend. `0` means the Run must be completed,
   *  failed, or declared waiting-human — never dispatched again. */
  remainingBudget: number;
  executionTarget: RoutingExecutionTarget;
}

/**
 * PR8 decision union. There is deliberately no `none`: a Router must say
 * whether it wants work dispatched, human input, or the Run finished.
 */
export type RoutingDecision =
  | {
      type: "dispatch";
      mode: "single" | "parallel" | "sequential";
      assignments: Array<{
        id: string;
        botId: string;
        task: string;
        expectedOutput?: string;
        dependsOn?: string[];
        triggerMessageIds: string[];
      }>;
    }
  | { type: "need-human"; question: string }
  | { type: "complete"; reason: string; synthesisBotId?: string };

/**
 * Hard bounds on one Router decision. A Router that asks for more work than
 * the remaining budget or more members than a Group may name is refused
 * outright, never truncated: silent truncation would run a plan the Router
 * never approved.
 */
export const MAX_ROUTER_ASSIGNMENTS_PER_DECISION = 64;
export const MAX_ROUTER_TASK_LENGTH = 8_000;
export const MAX_ROUTER_EXPECTED_OUTPUT_LENGTH = 2_000;
export const MAX_ROUTER_QUESTION_LENGTH = 2_000;
export const MAX_ROUTER_REASON_LENGTH = 2_000;

export class RoutingDecisionError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "RoutingDecisionError";
  }
}

function fail(code: string, message: string, details?: unknown): never {
  throw new RoutingDecisionError(code, message, details);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict decision decoding. Every field is checked for shape and type; nothing
 * is defaulted, coerced, repaired, or guessed. Structural validity only:
 * membership, duplicate ids, dependency graph, and budget are Domain rules
 * checked against the live Run state by `validateRoutingDecision`.
 */
export function parseRoutingDecision(value: unknown): RoutingDecision {
  if (!isObject(value)) {
    fail("router_decision_malformed", "Router decision must be an object");
  }
  if (!isNonEmptyString(value.type)) {
    fail("router_decision_malformed", "Router decision must declare a type");
  }
  switch (value.type) {
    case "dispatch":
      return parseDispatch(value);
    case "need-human":
      return parseNeedHuman(value);
    case "complete":
      return parseComplete(value);
    default:
      fail(
        "router_decision_malformed",
        `Router decision type "${String(value.type)}" is not one of dispatch | need-human | complete`,
        { type: value.type },
      );
  }
}

function parseDispatch(value: Record<string, unknown>): Extract<RoutingDecision, { type: "dispatch" }> {
  if (value.mode !== "single" && value.mode !== "parallel" && value.mode !== "sequential") {
    fail("router_decision_malformed", "Router dispatch mode must be single | parallel | sequential", {
      mode: value.mode,
    });
  }
  if (!Array.isArray(value.assignments) || value.assignments.length === 0) {
    fail("router_decision_malformed", "Router dispatch requires at least one assignment");
  }
  if (value.assignments.length > MAX_ROUTER_ASSIGNMENTS_PER_DECISION) {
    fail(
      "router_decision_malformed",
      `Router dispatch carries too many assignments (max ${MAX_ROUTER_ASSIGNMENTS_PER_DECISION})`,
    );
  }
  const assignments = value.assignments.map((entry) => parseAssignment(entry));
  return { type: "dispatch", mode: value.mode, assignments };
}

function parseAssignment(value: unknown): Extract<RoutingDecision, { type: "dispatch" }>["assignments"][number] {
  if (!isObject(value)) {
    fail("router_decision_malformed", "Router assignment must be an object");
  }
  if (!isNonEmptyString(value.id)) {
    fail("router_assignment_malformed", "Router assignment requires a non-empty id");
  }
  if (!isNonEmptyString(value.botId)) {
    fail("router_assignment_malformed", `Router assignment "${value.id}" requires a non-empty botId`);
  }
  if (!isNonEmptyString(value.task)) {
    fail("router_assignment_malformed", `Router assignment "${value.id}" requires a non-empty task`);
  }
  if (value.task.length > MAX_ROUTER_TASK_LENGTH) {
    fail(
      "router_assignment_malformed",
      `Router assignment "${value.id}" task exceeds ${MAX_ROUTER_TASK_LENGTH} characters`,
    );
  }
  if (value.expectedOutput !== undefined) {
    if (!isNonEmptyString(value.expectedOutput)) {
      fail("router_assignment_malformed", `Router assignment "${value.id}" expectedOutput must be a non-empty string`);
    }
    if (value.expectedOutput.length > MAX_ROUTER_EXPECTED_OUTPUT_LENGTH) {
      fail(
        "router_assignment_malformed",
        `Router assignment "${value.id}" expectedOutput exceeds ${MAX_ROUTER_EXPECTED_OUTPUT_LENGTH} characters`,
      );
    }
  }
  const dependsOn = parseBotIdArray(value.dependsOn, "dependsOn");
  const triggerMessageIds = parseBotIdArray(value.triggerMessageIds, "triggerMessageIds");
  return {
    id: value.id,
    botId: value.botId,
    task: value.task,
    ...(value.expectedOutput !== undefined ? { expectedOutput: value.expectedOutput } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    triggerMessageIds,
  };
}

function parseNeedHuman(value: Record<string, unknown>): Extract<RoutingDecision, { type: "need-human" }> {
  if (!isNonEmptyString(value.question)) {
    fail("router_decision_malformed", "Router need-human decision requires a non-empty question");
  }
  if (value.question.length > MAX_ROUTER_QUESTION_LENGTH) {
    fail("router_decision_malformed", `Router question exceeds ${MAX_ROUTER_QUESTION_LENGTH} characters`);
  }
  return { type: "need-human", question: value.question };
}

function parseComplete(value: Record<string, unknown>): Extract<RoutingDecision, { type: "complete" }> {
  if (!isNonEmptyString(value.reason)) {
    fail("router_decision_malformed", "Router complete decision requires a non-empty reason");
  }
  if (value.reason.length > MAX_ROUTER_REASON_LENGTH) {
    fail("router_decision_malformed", `Router complete reason exceeds ${MAX_ROUTER_REASON_LENGTH} characters`);
  }
  if (value.synthesisBotId !== undefined) {
    if (!isNonEmptyString(value.synthesisBotId)) {
      fail("router_decision_malformed", "Router complete synthesisBotId must be a non-empty string");
    }
    return { type: "complete", reason: value.reason, synthesisBotId: value.synthesisBotId };
  }
  return { type: "complete", reason: value.reason };
}

function parseBotIdArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("router_assignment_malformed", `Router assignment ${field} must be an array of ids`);
  }
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      fail("router_assignment_malformed", `Router assignment ${field} must contain non-empty ids`);
    }
  }
  return [...(value as string[])];
}
