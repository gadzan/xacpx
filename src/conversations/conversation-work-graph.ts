import type { ConversationRun, MemberTurnRecord, MemberTurnState } from "./conversation-types";
import { TERMINAL_RUN_STATES } from "./conversation-types";
import { ConversationError } from "./conversation-error";

/**
 * Logical-work projection for V2 §4.4. A Run is a forest of work items; a work
 * item is the linear chain of physical turns one Bot owns for one assignment
 * (its entry turn, then the followup wakes the runtime creates for it). Run
 * completion is decided from this whole-Run projection, never from the batch
 * that happens to have just settled.
 *
 * Everything here is a pure reading of durable rows: no SQL, no clock, no
 * scheduler. `sqlite-conversation-store` is the only writer of these facts.
 */

const TERMINAL_TURN_STATES: readonly MemberTurnState[] = ["completed", "failed", "cancelled", "indeterminate"];

export type WorkPhase =
  /** Frontier turn queued/dispatched/running and is not a wake. */
  | "executing"
  /** Frontier turn is a wake that has not decided yet (§4.4 check 4). */
  | "deciding"
  /** Frontier delivered; an assignment it sent has not come back yet (check 2). */
  | "waiting-children"
  /** Deliveries are in; the one followup wake is owed and not materialized (check 3). */
  | "wake-pending"
  /** Frontier completed, every assignment returned, no wake owed. */
  | "returned"
  /** Frontier failed/cancelled/indeterminate, or an assignment came back unknown. */
  | "blocked"
  /** The Run is already terminal. */
  | "sealed";

/** Durable lifecycle intent that outranks work classification (§4.4 check 6). */
export interface WorkFences {
  indeterminate: boolean;
  indeterminateReason?: string;
  budgetExhausted: boolean;
  humanCancelled: boolean;
  runCancellationReason?: "human-cancelled" | "execution-cancelled";
  /** Run-level cancel intent (not a scoped member/wake stop). */
  runCancelled: boolean;
}

export interface WorkNode {
  workId: string;
  parentWorkId?: string;
  ownerBotId: string;
  depth: number;
  entryMemberTurnId: string;
  entryState: MemberTurnState;
  frontierMemberTurnId: string;
  frontierState: MemberTurnState;
  frontierFailureReason?: string;
  frontierCancellationReason?: "human-cancelled";
  frontierBatch: number;
  frontierMemberIndex: number;
  turnIds: readonly string[];
  /** Child work items dispatched by the frontier turn — the sender's wake condition. */
  frontierChildWorkIds: readonly string[];
  /** Every child work item dispatched by any turn of this node. */
  childWorkIds: readonly string[];
  phase: WorkPhase;
  /** A wake is owed but the durable work budget has no slot for it. */
  wakeSuppressedByBudget: boolean;
  /** Any turn in this node completed. */
  sawCompletion: boolean;
  /** Any turn in this node or its descendants failed. */
  subtreeSawFailure: boolean;
  /**
   * A failure in this subtree that no completed wake handed back to its
   * sender. Such a failure can never be reported as a clean completion.
   */
  unobservedFailure: boolean;
}

export interface LeadFrontierOutcome {
  workId: string;
  frontierMemberTurnId: string;
  botId: string;
  state: MemberTurnState;
  phase: WorkPhase;
  /** The primary root work item is closed. */
  decided: boolean;
  sawCompletion: boolean;
  unobservedFailure: boolean;
}

/** §4.4's `workOutcome`: the Run's waiting frontier, one field per check. */
export interface RunWorkOutcome {
  runId: string;
  /** 1. physical turns still queued/dispatched/running. */
  activeTurnIds: readonly string[];
  /** 2. senders whose dispatched assignment has not delivered. */
  waitingWorkIds: readonly string[];
  /** 3. deliveries in, followup wake owed (capacity-skipped included). */
  wakeOwedWorkIds: readonly string[];
  /** 4. wake materialized and not yet decided. */
  decidingWorkIds: readonly string[];
  /** 5. primary root's latest materialization. */
  lead?: LeadFrontierOutcome;
  /** 6. unknown/budget/cancel intent. */
  fences: WorkFences;
  /** Every work item is closed; a capacity-skipped wake counts as closed. */
  closed: boolean;
  /** Closed work item with the greatest causal order (or the settlement anchor). */
  lastDecisionWorkId?: string;
}

export interface RunWaitingGraph extends RunWorkOutcome {
  nodes: readonly WorkNode[];
  byWorkId: ReadonlyMap<string, WorkNode>;
  byTurnId: ReadonlyMap<string, WorkNode>;
}

export interface RunGraphOptions {
  /** Member turns plus retired recovery attempts, as the budget counts them. */
  allocationUsed: number;
  runCancelling: boolean;
  budgetExhausted: boolean;
  runCancellationReason?: "human-cancelled" | "execution-cancelled";
}

export interface RunOpenVerdict {
  kind: "open";
  checks: readonly number[];
  reason: "active-turn" | "waiting-children" | "deciding" | "wake-pending" | "lead-undecided";
}

export interface RunTerminalVerdict {
  kind: "terminal";
  state: "completed" | "failed" | "cancelled" | "indeterminate";
  reason: string;
  checks: readonly number[];
}

export type RunCompletionVerdict = RunOpenVerdict | RunTerminalVerdict;

function isTerminalTurn(state: MemberTurnState): boolean {
  return TERMINAL_TURN_STATES.includes(state);
}

function nodeClosed(node: WorkNode): boolean {
  return node.phase === "returned" || node.phase === "blocked" || node.phase === "sealed"
    || (node.phase === "wake-pending" && node.wakeSuppressedByBudget);
}

/**
 * Runtime logical identity of a physical turn: a wake continues its sender's
 * work item, so the item is the root of the followup chain. Handoff children
 * are their own item; their parent is derived from `handoffSourceTurnId`.
 * Never model- or client-supplied.
 */
export function deriveWorkId(
  turn: MemberTurnRecord,
  byId: ReadonlyMap<string, MemberTurnRecord>,
): string {
  const seen = new Set<string>();
  let current = turn;
  while (current.followupSenderMemberTurnId !== undefined) {
    if (seen.has(current.id)) throw new ConversationError("member_turn_corrupt", `member turn "${turn.id}" has a cyclic followup chain`);
    seen.add(current.id);
    const sender = byId.get(current.followupSenderMemberTurnId);
    if (!sender) throw new ConversationError("member_turn_corrupt", `followup wake "${current.id}" lost its sender member turn`);
    if (sender.botId !== turn.botId) throw new ConversationError("member_turn_corrupt", `followup wake "${current.id}" continues another Bot's work`);
    current = sender;
  }
  return current.id;
}

export function buildWaitingGraph(
  run: ConversationRun,
  turns: readonly MemberTurnRecord[],
  options: RunGraphOptions,
): RunWaitingGraph {
  const byId = new Map(turns.map((turn) => [turn.id, turn]));
  const bySourceTurnId = new Map<string, MemberTurnRecord>();
  for (const turn of turns) {
    if (turn.sourceTurnId !== undefined && !bySourceTurnId.has(turn.sourceTurnId)) {
      bySourceTurnId.set(turn.sourceTurnId, turn);
    }
  }

  // Turns arrive in durable causal order (batch, memberIndex, id), so a work
  // item's first turn is its entry and its last is its frontier.
  const groups = new Map<string, MemberTurnRecord[]>();
  for (const turn of turns) {
    const workId = deriveWorkId(turn, byId);
    const group = groups.get(workId);
    if (group) group.push(turn);
    else groups.set(workId, [turn]);
  }

  const drafts = [...groups.entries()].map(([workId, group]) => {
    const entry = group[0]!;
    const frontier = group[group.length - 1]!;
    return { workId, group, entry, frontier };
  });

  const byWorkId = new Map<string, WorkNode>();
  for (const draft of drafts) {
    const { workId, group, entry, frontier } = draft;
    const node: WorkNode = {
      workId,
      ownerBotId: entry.botId,
      depth: 0,
      entryMemberTurnId: entry.id,
      entryState: entry.state,
      frontierMemberTurnId: frontier.id,
      frontierState: frontier.state,
      frontierBatch: frontier.batch,
      frontierMemberIndex: frontier.memberIndex,
      turnIds: group.map((turn) => turn.id),
      frontierChildWorkIds: [],
      childWorkIds: [],
      phase: "executing",
      wakeSuppressedByBudget: false,
      sawCompletion: group.some((turn) => turn.state === "completed"),
      subtreeSawFailure: false,
      unobservedFailure: false,
      ...(frontier.failureReason !== undefined ? { frontierFailureReason: frontier.failureReason } : {}),
      ...(frontier.cancellationReason !== undefined ? { frontierCancellationReason: frontier.cancellationReason } : {}),
    };
    byWorkId.set(workId, node);
  }

  // Parent edges are derived from the sender's physical execution identity;
  // they are never stored as a second work tree.
  for (const draft of drafts) {
    if (draft.entry.handoffSourceTurnId === undefined) continue;
    const sender = bySourceTurnId.get(draft.entry.handoffSourceTurnId);
    if (!sender) {
      throw new ConversationError("member_turn_corrupt", `handoff child "${draft.entry.id}" lost its sender turn`);
    }
    const parentWorkId = deriveWorkId(sender, byId);
    const node = byWorkId.get(draft.workId)!;
    if (parentWorkId === draft.workId) {
      throw new ConversationError("member_turn_corrupt", `handoff child "${draft.entry.id}" is its own work ancestor`);
    }
    node.parentWorkId = parentWorkId;
  }

  const children = new Map<string, string[]>();
  const frontierChildren = new Map<string, string[]>();
  for (const draft of drafts) {
    const node = byWorkId.get(draft.workId)!;
    if (node.parentWorkId === undefined) continue;
    const siblings = children.get(node.parentWorkId);
    if (siblings) siblings.push(node.workId);
    else children.set(node.parentWorkId, [node.workId]);
    const parent = byWorkId.get(node.parentWorkId)!;
    if (draft.entry.handoffSourceTurnId !== byId.get(parent.frontierMemberTurnId)?.sourceTurnId) continue;
    const dispatched = frontierChildren.get(parent.workId);
    if (dispatched) dispatched.push(node.workId);
    else frontierChildren.set(parent.workId, [node.workId]);
  }

  const activeTurnIds: string[] = [];
  for (const turn of turns) {
    if (!isTerminalTurn(turn.state)) activeTurnIds.push(turn.id);
  }

  const runTerminal = TERMINAL_RUN_STATES.includes(run.state);
  for (const node of byWorkId.values()) {
    node.childWorkIds = children.get(node.workId) ?? [];
    node.frontierChildWorkIds = frontierChildren.get(node.workId) ?? [];
    const parent = node.parentWorkId !== undefined ? byWorkId.get(node.parentWorkId) : undefined;
    node.depth = parent ? parent.depth + 1 : 0;
    const phase = classifyPhase(runTerminal, node, byWorkId, run, options);
    node.phase = phase.phase;
    node.wakeSuppressedByBudget = phase.wakeSuppressedByBudget;
  }

  // Depth is assigned parent-first only because parents are inserted first in
  // causal order; sort defensively before the bottom-up failure pass.
  const depthOrdered = [...byWorkId.values()].sort((left, right) => right.depth - left.depth);
  for (const node of depthOrdered) {
    node.subtreeSawFailure = node.turnIds.some((id) => byId.get(id)!.state === "failed")
      || node.childWorkIds.some((id) => byWorkId.get(id)!.subtreeSawFailure);
    node.unobservedFailure = node.childWorkIds.some((id) => byWorkId.get(id)!.unobservedFailure)
      || ownFailureUnobserved(node, byWorkId);
  }

  const nodes = drafts.map((draft) => byWorkId.get(draft.workId)!);
  const closed = nodes.every(nodeClosed);
  const lastDecision = nodes
    .filter(nodeClosed)
    .sort(compareFrontier)
    .at(-1);
  const roots = nodes.filter((node) => node.parentWorkId === undefined).sort(compareEntry);
  const primary = roots[0];

  const fences = readFences(turns, options);
  const graph: RunWaitingGraph = {
    runId: run.id,
    activeTurnIds,
    waitingWorkIds: nodes.filter((node) => node.phase === "waiting-children").map((node) => node.workId),
    wakeOwedWorkIds: nodes.filter((node) => node.phase === "wake-pending").map((node) => node.workId),
    decidingWorkIds: nodes.filter((node) => node.phase === "deciding").map((node) => node.workId),
    ...(primary
      ? {
        lead: {
          workId: primary.workId,
          frontierMemberTurnId: primary.frontierMemberTurnId,
          botId: primary.ownerBotId,
          state: primary.frontierState,
          phase: primary.phase,
          decided: nodeClosed(primary),
          sawCompletion: primary.sawCompletion,
          unobservedFailure: primary.unobservedFailure,
        },
      }
      : {}),
    fences,
    closed,
    ...(lastDecision ? { lastDecisionWorkId: lastDecision.workId } : {}),
    nodes,
    byWorkId,
    byTurnId: new Map(nodes.flatMap((node) => node.turnIds.map((id) => [id, node] as const))),
  };
  return graph;
}

function classifyPhase(
  runTerminal: boolean,
  node: WorkNode,
  byWorkId: ReadonlyMap<string, WorkNode>,
  run: ConversationRun,
  options: RunGraphOptions,
): { phase: WorkPhase; wakeSuppressedByBudget: boolean } {
  if (runTerminal) return { phase: "sealed", wakeSuppressedByBudget: false };
  const frontier = byWorkId.get(node.workId)!;
  if (!isTerminalTurn(frontier.frontierState)) {
    return {
      phase: isWakeTurn(frontier) ? "deciding" : "executing",
      wakeSuppressedByBudget: false,
    };
  }
  if (frontier.frontierState === "indeterminate") return { phase: "blocked", wakeSuppressedByBudget: false };
  const entries = frontier.frontierChildWorkIds.map((id) => byWorkId.get(id)!);
  if (entries.some((child) => child.entryState === "indeterminate")) {
    return { phase: "blocked", wakeSuppressedByBudget: false };
  }
  if (entries.some((child) => !isTerminalTurn(child.entryState))) {
    return { phase: "waiting-children", wakeSuppressedByBudget: false };
  }
  if (frontier.frontierState === "completed") {
    // A cancelling Run owes no new wake; a scoped-stop sender never earned one.
    if (entries.length > 0 && frontier.frontierCancellationReason === undefined && !options.runCancelling) {
      return options.allocationUsed < run.maxMemberTurns
        ? { phase: "wake-pending", wakeSuppressedByBudget: false }
        : { phase: "wake-pending", wakeSuppressedByBudget: true };
    }
    return { phase: "returned", wakeSuppressedByBudget: false };
  }
  return { phase: "blocked", wakeSuppressedByBudget: false };
}

function isWakeTurn(node: WorkNode): boolean {
  // A node's frontier is a wake exactly when its entry is not its frontier.
  return node.entryMemberTurnId !== node.frontierMemberTurnId;
}

function ownFailureUnobserved(node: WorkNode, byWorkId: ReadonlyMap<string, WorkNode>): boolean {
  const parent = node.parentWorkId !== undefined ? byWorkId.get(node.parentWorkId) : undefined;
  if (node.phase === "wake-pending" && node.wakeSuppressedByBudget) {
    return node.subtreeSawFailure;
  }
  if (node.phase === "blocked" && node.frontierState === "cancelled") {
    // A stopped/cancelled frontier handed nothing back to its own parent.
    return node.subtreeSawFailure;
  }
  if (node.phase !== "blocked" || node.frontierState !== "failed") return false;
  if (isWakeTurn(node)) return true;
  // A failed entry turn is handed back when the parent's frontier is a
  // completed wake that named it. A failed root has no observer at all.
  return !parent
    || parent.frontierState !== "completed"
    || parent.frontierMemberTurnId === parent.entryMemberTurnId;
}

function readFences(turns: readonly MemberTurnRecord[], options: RunGraphOptions): WorkFences {
  const indeterminate = turns.filter((turn) => turn.state === "indeterminate");
  return {
    indeterminate: indeterminate.length > 0,
    ...(indeterminate.length > 0
      ? {
        indeterminateReason: turns.length === 1
          ? (indeterminate[0]!.failureReason ?? "started_result_unknown")
          : "started_result_unknown",
      }
      : {}),
    budgetExhausted: options.budgetExhausted,
    humanCancelled: options.runCancellationReason === "human-cancelled",
    ...(options.runCancellationReason !== undefined ? { runCancellationReason: options.runCancellationReason } : {}),
    runCancelled: options.runCancelling
      || options.runCancellationReason === "human-cancelled"
      || turns.some((turn) => turn.state === "cancelled" && turn.cancellationReason === undefined),
  };
}

function compareEntry(left: WorkNode, right: WorkNode): number {
  return left.frontierBatch - right.frontierBatch
    || left.frontierMemberIndex - right.frontierMemberIndex
    || left.workId.localeCompare(right.workId);
}

function compareFrontier(left: WorkNode, right: WorkNode): number {
  return left.frontierBatch - right.frontierBatch
    || left.frontierMemberIndex - right.frontierMemberIndex
    || left.frontierMemberTurnId.localeCompare(right.frontierMemberTurnId);
}

/** Strip the internal node/map detail: the durable read model for one Run. */
export function projectWorkOutcome(graph: RunWaitingGraph): RunWorkOutcome {
  const { nodes: _nodes, byWorkId: _byWorkId, byTurnId: _byTurnId, ...outcome } = graph;
  return outcome;
}

/**
 * §4.4 checks 1–6 over the whole Run. Openness is evaluated before lifecycle
 * fences so started work always drains; only then does an unknown result seal,
 * a durable budget rejection fail, or a Run-level cancel terminate the Run.
 *
 * `anchorMemberTurnId` is the member whose settlement triggered this decision;
 * its work item wins the "last decision" tie when several close together.
 * `anchorReason` keeps the single-member diagnostic reason (e.g.
 * `runtime_revision_mismatch`) that the batch classifier used to preserve.
 */
export function decideRunCompletion(
  graph: RunWaitingGraph,
  anchorMemberTurnId: string,
  anchorReason?: string,
): RunCompletionVerdict {
  const single = graph.nodes.length === 1;
  if (graph.fences.indeterminate) {
    return {
      kind: "terminal",
      state: "indeterminate",
      reason: single
        ? (anchorReason ?? graph.fences.indeterminateReason ?? "started_result_unknown")
        : "started_result_unknown",
      checks: [6],
    };
  }
  if (graph.activeTurnIds.length > 0) {
    return {
      kind: "open",
      checks: graph.decidingWorkIds.length > 0 ? [1, 4] : [1],
      reason: "active-turn",
    };
  }
  if (graph.waitingWorkIds.length > 0) return { kind: "open", checks: [2], reason: "waiting-children" };
  if (graph.decidingWorkIds.length > 0) return { kind: "open", checks: [4], reason: "deciding" };
  if (graph.wakeOwedWorkIds.some((id) => !graph.byWorkId.get(id)!.wakeSuppressedByBudget)) {
    return { kind: "open", checks: [3], reason: "wake-pending" };
  }
  if (graph.fences.budgetExhausted && !graph.fences.humanCancelled) {
    return { kind: "terminal", state: "failed", reason: "budget-exhausted", checks: [6] };
  }
  if (graph.nodes.length === 0) {
    return { kind: "terminal", state: "completed", reason: "members-completed", checks: [5] };
  }
  if (!graph.lead?.decided || !graph.closed) return { kind: "open", checks: [5], reason: "lead-undecided" };

  const anchor = graph.byTurnId.get(anchorMemberTurnId);
  const last = (anchor && nodeClosed(anchor) ? anchor : undefined)
    ?? (graph.lastDecisionWorkId !== undefined ? graph.byWorkId.get(graph.lastDecisionWorkId) : undefined);
  if (!last) return { kind: "terminal", state: "completed", reason: "members-completed", checks: [5] };

  // A failure nobody handed back is never a clean completion (and outranks a
  // cancellation, preserving failed > cancelled).
  if (graph.nodes.some((node) => node.unobservedFailure)) {
    return {
      kind: "terminal",
      state: "failed",
      reason: single
        ? (anchorReason ?? last.frontierFailureReason ?? "execution-failed")
        : "execution-failed",
      checks: [5, 6],
    };
  }
  if (graph.fences.runCancelled) {
    return {
      kind: "terminal",
      state: "cancelled",
      reason: graph.fences.runCancellationReason ?? "human-cancelled",
      checks: [6],
    };
  }
  switch (last.frontierState) {
    case "completed":
      return { kind: "terminal", state: "completed", reason: "members-completed", checks: [5] };
    case "failed":
      return {
        kind: "terminal",
        state: "failed",
        reason: single ? (anchorReason ?? last.frontierFailureReason ?? "execution-failed") : "execution-failed",
        checks: [5],
      };
    case "cancelled":
      return last.frontierCancellationReason === "human-cancelled" && last.sawCompletion
        ? { kind: "terminal", state: "completed", reason: "members-completed", checks: [5] }
        : {
          kind: "terminal",
          state: "cancelled",
          reason: graph.fences.runCancellationReason ?? "human-cancelled",
          checks: [5, 6],
        };
    default:
      return { kind: "terminal", state: "indeterminate", reason: "started_result_unknown", checks: [6] };
  }
}

/**
 * The provable cycle a dispatch would close: an open ancestor work item owned
 * by `targetBotId` that is **still waiting on this sender's own line**. Merely
 * owning open work elsewhere in the Run is not a cycle — that leaf would queue
 * and drain. The refusal is the design's literal "target would depend on its
 * own unfinished result": the ancestor's undelivered frontier child is the
 * branch the sender sits on, so its closure depends on the sender finishing.
 */
export function waitingCyclePath(
  graph: RunWaitingGraph,
  senderMemberTurnId: string,
  targetBotId: string,
): readonly string[] | undefined {
  const sender = graph.byTurnId.get(senderMemberTurnId);
  if (!sender) return undefined;
  const chain: WorkNode[] = [];
  const seen = new Set<string>([sender.workId]);
  let parent = sender.parentWorkId !== undefined ? graph.byWorkId.get(sender.parentWorkId) : undefined;
  while (parent) {
    if (seen.has(parent.workId)) return undefined;
    seen.add(parent.workId);
    chain.unshift(parent);
    parent = parent.parentWorkId !== undefined ? graph.byWorkId.get(parent.parentWorkId) : undefined;
  }
  for (const [index, ancestor] of chain.entries()) {
    if (ancestor.ownerBotId !== targetBotId || nodeClosed(ancestor)) continue;
    const next = chain[index + 1] ?? sender;
    if (ancestor.phase !== "waiting-children"
      || !ancestor.frontierChildWorkIds.includes(next.workId)
      || TERMINAL_TURN_STATES.includes(next.entryState)) continue;
    return [...chain.slice(index).map((node) => node.workId), sender.workId];
  }
  return undefined;
}
