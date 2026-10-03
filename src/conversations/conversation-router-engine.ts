import { ConversationError } from "./conversation-error";
import { gateRoutingDecision } from "./conversation-router-gate";
import type { ApplyRoutingDecisionInput } from "./conversation-store";
import {
  isRouterCapabilityRestricted,
  type ConversationRouter,
  type RoutingAssignmentRecord,
  type RoutingDecision,
  type RoutingExecutionTarget,
  type RoutingInput,
  type RoutingMember,
} from "./conversation-router-types";
import { snapshotGroupMemberProfile } from "../bots/bot-types";
import type {
  ConversationRecord,
  ConversationRun,
  ConversationTopic,
  MemberTurnRecord,
} from "./conversation-types";
import { PUBLIC_TRANSCRIPT_MESSAGES } from "./conversation-dispatcher";
import type { ConversationStore, ListMessagesQuery } from "./conversation-store";
import type { BotProfile } from "../bots/bot-types";

/** Bounded public transcript context handed to the Router (design §12). The
 *  window is newest-first below the Run's own request boundary, so a Topic
 *  longer than the bound still gives the Router the closest prior context —
 *  the same rule the dispatcher's frozen transcript uses. */
export const ROUTER_PUBLIC_TRANSCRIPT_MESSAGES = 200;

/** Bound for resolving a completed assignment to its public result row when
 *  fixing a sequential successor's trigger boundary. Bounded like every other
 *  durable read; an out-of-window result simply contributes no trigger, which
 *  is the same answer as "no public result to build on". */
const PUBLIC_RESULT_LOOKBACK = 400;

/** Store-level decision shape (assignments carry their accepted snapshot). */
type RoutingDecisionStoreInput = ApplyRoutingDecisionInput["decision"];

export interface ConversationRouterEngineOptions {
  store: ConversationStore;
  /** Live Group membership + Bot metadata (AppState reads). */
  readGroup: (conversationId: string) => ConversationRecord | undefined;
  readTopic: (conversationId: string, topicId: string) => ConversationTopic | undefined;
  readBot: (botId: string) => BotProfile | undefined;
  now: () => Date;
}

export interface RoutingAttemptOutcome {
  run: ConversationRun;
  outcome: "dispatched" | "need-human" | "complete" | "rejected" | "failed" | "skipped";
  /** Machine-readable reason: Router rejection code, store error code, or the
   *  durable completion reason. Surfaced through the Run + product events. */
  reason?: string;
  memberTurns?: MemberTurnRecord[];
}

/** Durable MemberTurn state → Router-visible assignment outcome. Non-terminal
 *  states (queued/dispatched/running) are NOT outcomes; the Router is only
 *  asked while the previous batch is terminal, so any such state here is a
 *  stale input and reports the closest terminal outcome the Run would
 *  commit. `indeterminate` is preserved exactly: unknown side effects are
 *  never laundered into success or failure. */
function routingOutcomeOf(turn: MemberTurnRecord): RoutingAssignmentRecord["outcome"] {
  switch (turn.state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "indeterminate":
      return "indeterminate";
    default:
      return "cancelled";
  }
}

/**
 * PR8 automatic-Run router engine (design §12–§14, plan §11).
 *
 * Responsibilities, in order:
 * 1. Build the stateless `RoutingInput` from durable store rows + live
 *    membership metadata. NO Direct history, NO private content, NO other
 *    Topic, and NO Router-side conversational history.
 * 2. Mark the Run `routing` durably before the call, so a crash during the
 *    call re-routes deterministically (a decision has no side effects).
 * 3. Gate every decision: strict schema, then domain validation against the
 *    live input. Nothing malformed reaches the durable write.
 * 4. Commit through the store: dispatch inserts `router`-origin MemberTurns,
 *    need-human parks as `waiting-human`, complete terminalizes. Rejection
 *    fails the Run (`failed`), never a silent partial dispatch.
 */
export class ConversationRouterEngine {
  constructor(
    /** The configured Router. Must be `undefined` when automatic mode must
     *  be unsupported; a present RESTRICTED router is the only automatic
     *  configuration. */
    private readonly router: ConversationRouter | undefined,
    private readonly options: ConversationRouterEngineOptions,
  ) {}

  /** True when this engine may route at all. An absent Router leaves
   *  automatic mode unsupported (callers must refuse the accept). */
  get available(): boolean {
    return this.router !== undefined;
  }

  /** True when `router` may be wired into automatic mode at all. Fail closed:
   *  an implementation that cannot PROVE its capability restriction is not a
   *  Router (post-hoc "no tool events seen" is never a proof). */
  static isUsable(router: ConversationRouter | undefined): router is ConversationRouter {
    return router !== undefined && isRouterCapabilityRestricted(router.capabilityRestriction);
  }

  /**
   * Route one automatic Run. Returns the durable outcome. The caller (Run
   * service accept path and the batch-settle hook in the dispatcher) is
   * responsible for kicking the dispatcher afterwards.
   */
  async route(runId: string): Promise<RoutingAttemptOutcome> {
    const router = this.router;
    if (!ConversationRouterEngine.isUsable(router)) {
      throw new ConversationError(
        "router_capability_unrestricted",
        "Router implementation cannot prove its capability restriction; automatic mode is unsupported",
      );
    }
    const store = this.options.store;
    const run = store.getRun(runId);
    if (!run) {
      throw new ConversationError("run_not_found", `run "${runId}" does not exist`);
    }
    if (run.mode !== "automatic") {
      // Defensive: explicit Runs never route (§14.1).
      return { run, outcome: "skipped", reason: "explicit_run" };
    }
    if (run.state === "cancelled" || run.state === "failed"
      || run.state === "completed" || run.state === "indeterminate") {
      // Sealed Runs (cancel/indeterminate/complete) never re-enter routing:
      // late Router output must not resurrect scheduling.
      return { run, outcome: "skipped", reason: `run_${run.state}` };
    }
    const input = this.buildRoutingInput(run);
    // A Run with zero remaining budget is terminated by budget, not routed:
    // `maxMemberTurns` is a loop guard, not a completion definition, so this
    // must be an EXPLICIT terminal reason (failed + budget-exhausted), never
    // a "completed" Run and never a silent truncation of a Router batch.
    if (input.remainingBudget <= 0) {
      const settled = store.failRun(runId, "budget-exhausted", "failed", this.options.now().toISOString());
      return { run: settled, outcome: "failed", reason: "budget-exhausted" };
    }
    try {
      store.markRoutingState(runId, "routing", this.options.now().toISOString());
    } catch (error) {
      // A concurrent terminal/cancel transition between the read above and
      // here means this routing attempt is stale: skip rather than fight it.
      if (error instanceof ConversationError) {
        const current = store.getRun(runId);
        return {
          run: current ?? run,
          outcome: "skipped",
          reason: error.code === "run_terminal" || error.code === "routing_not_automatic" ? error.code : "routing_unavailable",
        };
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = await router.decide(input);
    } catch {
      // A Router failure (model error, transport error, timeout) is an
      // unrecoverable failure of THIS Run, not a reason to spin.
      const failed = this.failRouting(runId, "router-execution-failed");
      return { run: failed, outcome: "failed", reason: "router-execution-failed" };
    }
    const gate = gateRoutingDecision(raw, input);
    if (gate.kind === "rejected") {
      // Malformed/unsafe decisions fail closed BEFORE any durable MemberTurn
      // is created: the Run fails with the machine-readable gate code.
      const failed = this.failRouting(runId, gate.code);
      return { run: failed, outcome: "rejected", reason: gate.code };
    }
    const decision = this.attachMemberSnapshots(run, gate.decision, input);
    try {
      const applied = store.applyRoutingDecision({
        runId,
        now: this.options.now().toISOString(),
        decision,
        requestMessageId: run.requestMessageId,
      });
      if (applied.terminal) {
        return {
          run: applied.run,
          outcome: applied.terminal === "waiting-human" ? "need-human" : "complete",
          ...(applied.terminal === "waiting-human"
            ? { reason: "needs-input" }
            : { reason: applied.run.completionReason }),
          memberTurns: applied.memberTurns,
        };
      }
      return { run: applied.run, outcome: "dispatched", memberTurns: applied.memberTurns };
    } catch (error) {
      if (error instanceof ConversationError) {
        const current = store.getRun(runId);
        if (current && (current.state === "completed" || current.state === "failed"
          || current.state === "cancelled" || current.state === "indeterminate")) {
          return { run: current, outcome: "skipped", reason: current.state };
        }
        if (error.code === "routing_batch_active") {
          // Another drain already committed a batch for this Run; nothing to do.
          return { run: current ?? run, outcome: "skipped", reason: error.code };
        }
        // Every other durable rejection (assignment ids outside this Topic's
        // public transcript, duplicate ids, budget overrun, ...) is a routing
        // decision that cannot be applied. Fail the Run with the store's own
        // machine-readable code so the reason survives as durable evidence.
        const failed = this.failRouting(runId, error.code);
        return { run: failed, outcome: "rejected", reason: error.code };
      }
      throw error;
    }
  }

  private failRouting(runId: string, reason: string): ConversationRun {
    return this.options.store.failRun(runId, reason, "failed", this.options.now().toISOString());
  }

  /**
   * Build the stateless RoutingInput. Every field is derived from durable
   * rows or live product metadata:
   *
   * - `request`: the Run's own human message (referentially fenced by
   *   conversation+topic+run+role=human by `getMessage`)
   * - `publicTranscript`: bounded public rows of THIS Topic only
   * - `memberMetadata`: live Group membership with live Bot profiles
   * - `runState`: the durable Run row
   * - `completedAssignments`: durable MemberTurns of this Run and their
   *   public results — this is what sequential work may build on
   * - `remainingBudget`: `maxMemberTurns - consumedMemberTurns`
   * - `executionTarget`: the Topic's durable target (fail closed: no target
   *   means admission already refused the Run)
   */
  buildRoutingInput(run: ConversationRun): RoutingInput {
    const store = this.options.store;
    const request = store.getMessage(run.requestMessageId);
    if (!request
      || request.conversationId !== run.conversationId
      || request.topicId !== run.topicId
      || request.role !== "human") {
      throw new ConversationError(
        "request_snapshot_mismatch",
        `run "${run.id}" lost its request snapshot; not routable`,
      );
    }
    // Public transcript: strictly BEFORE the request boundary, newest-first,
    // bounded. Public rows of this Topic carry no Direct/private/other-Topic
    // content by construction — the store is scoped by conversation+topic.
    const transcriptQuery: ListMessagesQuery = {
      conversationId: run.conversationId,
      topicId: run.topicId,
      beforeSeq: request.seq,
      limit: ROUTER_PUBLIC_TRANSCRIPT_MESSAGES,
      direction: "newest-first",
    };
    const transcript = store.listMessages(transcriptQuery).map((message) => ({
      id: message.id,
      seq: message.seq,
      role: message.role,
      ...(message.senderBotId ? { senderBotId: message.senderBotId } : {}),
      content: message.content,
      ...(message.runId ? { runId: message.runId } : {}),
    }));
    const conversation = this.options.readGroup(run.conversationId);
    if (!conversation || conversation.kind !== "group") {
      throw new ConversationError("conversation_not_group", `run "${run.id}" is not a Group conversation`);
    }
    const topic = this.options.readTopic(run.conversationId, run.topicId);
    if (!topic?.executionTarget) {
      throw new ConversationError("execution_target_missing", `topic "${run.topicId}" has no execution target`);
    }
    const memberMetadata: RoutingMember[] = conversation.botIds.map((botId) => {
      const bot = this.options.readBot(botId);
      // A member whose Bot row vanished mid-Run is not routable: report it
      // disabled rather than fabricating metadata.
      if (!bot) {
        return { botId, name: botId, agent: "", workspace: topic.executionTarget!.workspace, enabled: false };
      }
      return {
        botId: bot.id,
        name: bot.name,
        ...(bot.role ? { role: bot.role } : {}),
        agent: bot.agent,
        workspace: bot.workspace,
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.effort ? { effort: bot.effort } : {}),
        enabled: bot.enabled === true,
      };
    });
    const memberTurns = store.listMemberTurns(run.id);
    const completedAssignments: RoutingAssignmentRecord[] = memberTurns.map((turn) => {
      const assignment: RoutingAssignmentRecord = {
        id: turn.assignmentId ?? turn.id,
        botId: turn.botId,
        task: turn.task ?? "",
        dependsOn: turn.dependsOn ?? [],
        triggerMessageIds: turn.triggerMessageIds,
        outcome: routingOutcomeOf(turn),
        attempt: turn.attempt,
        batch: turn.batch,
      };
      if (turn.expectedOutput !== undefined) {
        assignment.expectedOutput = turn.expectedOutput;
      }
      if (turn.state === "completed") {
        // Sequential work may build on the public result; read it from the
        // Topic, never from hidden session history.
        assignment.result = this.latestMemberResult(store, run, turn) ?? "";
      }
      if (turn.state === "failed" && turn.failureReason) {
        assignment.failureReason = turn.failureReason;
      }
      return assignment;
    });
    const executionTarget: RoutingExecutionTarget = {
      workspace: topic.executionTarget.workspace,
      ...(topic.executionTarget.cwd !== undefined ? { cwd: topic.executionTarget.cwd } : {}),
      isolation: topic.executionTarget.isolation,
    };
    return {
      runId: run.id,
      conversationId: run.conversationId,
      topicId: run.topicId,
      request: request.content,
      requestMessageId: request.id,
      publicTranscript: transcript,
      memberMetadata,
      runState: {
        runId: run.id,
        conversationId: run.conversationId,
        topicId: run.topicId,
        mode: "automatic",
        generation: run.generation,
        ...(run.activeBatch !== undefined ? { activeBatch: run.activeBatch } : {}),
        maxMemberTurns: run.maxMemberTurns,
        consumedMemberTurns: run.consumedMemberTurns,
        failedBotIds: [...run.failedBotIds],
      },
      completedAssignments,
      remainingBudget: run.maxMemberTurns - run.consumedMemberTurns,
      executionTarget,
    };
  }

  /**
   * Attach the accepted execution snapshot for each assignment's member,
   * derived from the LIVE Bot profile and THIS Topic's ExecutionTarget — the
   * same `snapshotGroupMemberProfile` seam explicit accepts use. Also fixes
   * each assignment's durable trigger boundary:
   *
   * - the Run's own request message is always a trigger (every assignment
   *   reacts to the human request that created the Run); and
   * - for a `dependsOn` edge that names a COMPLETED assignment of this Run,
   *   that assignment's public result message enters the boundary, so a
   *   sequential successor sees the earlier public result (§13.1).
   *
   * This is what keeps a Router-selected member executing under the Bot the
   * Router named: the gate already proved the Bot is a live enabled member,
   * so a miss here is a state change mid-routing and fails the Run rather
   * than executing the wrong Bot.
   */
  private attachMemberSnapshots(
    run: ConversationRun,
    decision: RoutingDecision,
    input: RoutingInput,
  ): RoutingDecisionStoreInput {
    if (decision.type !== "dispatch") {
      return decision;
    }
    const topic = this.options.readTopic(run.conversationId, run.topicId);
    const target = topic?.executionTarget;
    if (!target) {
      throw new ConversationError("execution_target_missing", `topic "${run.topicId}" has no execution target`);
    }
    const now = this.options.now().toISOString();
    // Public assistant messages this Run produced (newest-first), used to
    // resolve each durable completed assignment to its canonical public row.
    const publicMessages = this.options.store.listMessages({
      conversationId: run.conversationId,
      topicId: run.topicId,
      limit: PUBLIC_RESULT_LOOKBACK,
      direction: "newest-first",
    });
    // Public assistant message produced by each durable completed assignment
    // (join by sender Bot + Run + content), which a sequential dependency may
    // build on. Content-matched on purpose: the assignment id is not stamped
    // on the transcript row, and the run+bot+content triple identifies the
    // exact public result the Router was shown as `assignment.result`.
    const publicResultOf = new Map<string, string>();
    for (const assignment of input.completedAssignments) {
      if (assignment.outcome !== "completed" || assignment.result === undefined) {
        continue;
      }
      const row = publicMessages.find((message) => message.role === "bot"
        && message.senderBotId === assignment.botId
        && message.runId === run.id
        && message.content === assignment.result);
      if (row) {
        publicResultOf.set(assignment.id, row.id);
      }
    }
    return {
      type: "dispatch",
      mode: decision.mode,
      assignments: decision.assignments.map((assignment) => {
        const bot = this.options.readBot(assignment.botId);
        if (!bot) {
          throw new ConversationError(
            "router_unknown_member",
            `assignment "${assignment.id}" targets bot "${assignment.botId}" which no longer exists`,
          );
        }
        const triggers = new Set(assignment.triggerMessageIds);
        triggers.add(run.requestMessageId);
        for (const dependency of assignment.dependsOn ?? []) {
          const resultId = publicResultOf.get(dependency);
          if (resultId) {
            triggers.add(resultId);
          }
        }
        return {
          id: assignment.id,
          botId: assignment.botId,
          task: assignment.task,
          ...(assignment.expectedOutput !== undefined ? { expectedOutput: assignment.expectedOutput } : {}),
          ...(assignment.dependsOn !== undefined ? { dependsOn: assignment.dependsOn } : {}),
          triggerMessageIds: [...triggers],
          profileSnapshot: snapshotGroupMemberProfile(bot, target, now),
        };
      }),
    };
  }

  /**
   * The public assistant text this member produced in this Topic, or
   * undefined when it produced none. Only PUBLIC transcript rows are read, so
   * a sequential member can see exactly what the human sees — never the
   * hidden session of a sibling Bot.
   */
  private latestMemberResult(
    store: ConversationStore,
    run: ConversationRun,
    turn: MemberTurnRecord,
  ): string | undefined {
    const rows = store.listMessages({
      conversationId: run.conversationId,
      topicId: run.topicId,
      limit: 50,
      direction: "newest-first",
    });
    for (const row of rows) {
      if (row.role === "bot" && row.senderBotId === turn.botId && row.runId === run.id) {
        return row.content;
      }
    }
    return undefined;
  }
}
