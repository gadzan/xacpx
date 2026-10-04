import { ConversationError } from "./conversation-error";
import { gateRoutingDecision } from "./conversation-router-gate";
import { boundRoutingInput } from "./conversation-router-budget";
import type { ApplyRoutingDecisionInput } from "./conversation-store";
import { requestSnapshotMatches, requireMemberResult } from "./conversation-store";
import {
  isRouterCapabilityRestricted,
  MAX_ROUTER_MEMBER_METADATA,
  type ConversationRouter,
  type RoutingAssignmentRecord,
  type RoutingDecision,
  type RoutingExecutionTarget,
  type RoutingInput,
  type RoutingMember,
} from "./conversation-router-types";
import { snapshotGroupMemberProfile } from "../bots/bot-types";
import { BotError } from "../bots/bot-error";
import type {
  ConversationRecord,
  ConversationRun,
  ConversationTopic,
  MemberTurnRecord,
} from "./conversation-types";
import type { ConversationStore, ListMessagesQuery } from "./conversation-store";
import type { BotProfile } from "../bots/bot-types";

/** Bounded public transcript context handed to the Router (design §12). The
 *  window is newest-first below the Run's own request boundary, so a Topic
 *  longer than the bound still gives the Router the closest prior context —
 *  the same rule the dispatcher's frozen transcript uses. */
export const ROUTER_PUBLIC_TRANSCRIPT_MESSAGES = 200;
export const DEFAULT_ROUTER_DECISION_TIMEOUT_MS = 30_000;

/** Store-level decision shape (assignments carry their accepted snapshot). */
type RoutingDecisionStoreInput = ApplyRoutingDecisionInput["decision"];

export interface ConversationRouterEngineOptions {
  store: ConversationStore;
  /** Live Group membership + Bot metadata (AppState reads). */
  readGroup: (conversationId: string) => ConversationRecord | undefined;
  readTopic: (conversationId: string, topicId: string) => ConversationTopic | undefined;
  readBot: (botId: string) => BotProfile | undefined;
  /** Revalidation and durable commit share BotService's lifecycle gates. */
  runLifecycleAll: <T>(botIds: readonly string[], critical: () => Promise<T>) => Promise<T>;
  now: () => Date;
  decisionTimeoutMs?: number;
}

export interface RoutingAttemptOutcome {
  run: ConversationRun;
  outcome: "dispatched" | "need-human" | "complete" | "rejected" | "failed" | "skipped";
  /** Machine-readable reason: Router rejection code, store error code, or the
   *  durable completion reason. Surfaced through the Run + product events. */
  reason?: string;
  memberTurns?: MemberTurnRecord[];
}

/** Only terminal MemberTurns constitute assignment outcomes. Never turn a
 *  still-running assignment or unknown side effects into a guessed outcome. */
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
      throw new ConversationError("routing_batch_active", `member turn "${turn.id}" is not settled`);
  }
}

/**
 * PR8 automatic-Run router engine (design §12–§14, plan §11).
 *
 * Responsibilities, in order:
 * 1. Acquire a durable routing generation before the call, so a restart
 *    can re-route while fencing any older output.
 * 2. Build the stateless `RoutingInput` from durable rows + live membership.
 *    NO Direct/private/other-Topic or Router-side conversational history.
 * 3. Gate every decision: strict schema, then domain validation against the
 *    live input. Nothing malformed reaches the durable write.
 * 4. Commit through the store: dispatch inserts `router`-origin MemberTurns,
 *    need-human parks as `waiting-human`, complete terminalizes. Rejection
 *    fails the Run (`failed`), never a silent partial dispatch.
 */
export class ConversationRouterEngine {
  private readonly decisionTimeoutMs: number;
  constructor(
    /** The configured Router. Must be `undefined` when automatic mode must
     *  be unsupported; a present RESTRICTED router is the only automatic
     *  configuration. */
    private readonly router: ConversationRouter | undefined,
    private readonly options: ConversationRouterEngineOptions,
  ) {
    this.decisionTimeoutMs = options.decisionTimeoutMs ?? DEFAULT_ROUTER_DECISION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.decisionTimeoutMs) || this.decisionTimeoutMs <= 0 || this.decisionTimeoutMs > 2_147_483_647) {
      throw new ConversationError("invalid_router_timeout", "Router decision timeout must be a positive timer duration");
    }
  }

  /** True when this engine may route at all. An absent Router leaves
   *  automatic mode unsupported (callers must refuse the accept). */
  get available(): boolean {
    return ConversationRouterEngine.isUsable(this.router);
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
  async route(runId: string, signal?: AbortSignal): Promise<RoutingAttemptOutcome> {
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
    let routingGeneration: number;
    // A Run with zero remaining budget is terminated by budget, not routed:
    // `maxMemberTurns` is a loop guard, not a completion definition, so this
    // must be an EXPLICIT terminal reason (failed + budget-exhausted), never
    // a "completed" Run and never a silent truncation of a Router batch.
    try {
      routingGeneration = store.markRoutingState(runId, "routing", this.options.now().toISOString()).routingGeneration!;
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
    let input: RoutingInput;
    try {
      input = this.buildRoutingInput(store.getRun(runId)!);
    } catch (error) {
      const reason = error instanceof ConversationError ? error.code : "router-input-failed";
      return { run: this.failRouting(runId, reason, routingGeneration), outcome: "rejected", reason };
    }
    if (input.remainingBudget <= 0) {
      return { run: this.failRouting(runId, "budget-exhausted", routingGeneration), outcome: "failed", reason: "budget-exhausted" };
    }
    let raw: unknown;
    try {
      raw = await this.decideWithDeadline(router, input, signal);
    } catch (error) {
      // A Router failure (model error, transport error, timeout) is an
      // unrecoverable failure of THIS Run, not a reason to spin.
      const reason = error instanceof ConversationError && (error.code === "router_timeout" || error.code === "router_aborted")
        ? error.code : "router-execution-failed";
      const failed = this.failRouting(runId, reason, routingGeneration);
      return { run: failed, outcome: "failed", reason };
    }
    const gate = gateRoutingDecision(raw, input);
    if (gate.kind === "rejected") {
      // Malformed/unsafe decisions fail closed BEFORE any durable MemberTurn
      // is created: the Run fails with the machine-readable gate code.
      const failed = this.failRouting(runId, gate.code, routingGeneration);
      return { run: failed, outcome: "rejected", reason: gate.code };
    }
    try {
      const selected = gate.decision.type === "dispatch" ? gate.decision.assignments.map((a) => a.botId) : [];
      const applied = await this.options.runLifecycleAll(selected, async () => {
        if (signal?.aborted) throw new ConversationError("router_aborted", "Router attempt was aborted");
        const decision = this.attachMemberSnapshots(run, gate.decision);
        return store.applyRoutingDecision({
          runId, routingGeneration,
          now: this.options.now().toISOString(),
          decision,
          requestMessageId: run.requestMessageId,
        });
      });
      if (applied.terminal) {
        return {
          run: applied.run,
          outcome: applied.terminal === "waiting-human" ? "need-human" : applied.terminal === "failed" ? "failed" : "complete",
          ...(applied.terminal === "waiting-human"
            ? { reason: "needs-input" }
            : { reason: applied.run.completionReason }),
          memberTurns: applied.memberTurns,
        };
      }
      return { run: applied.run, outcome: "dispatched", memberTurns: applied.memberTurns };
    } catch (error) {
      if (error instanceof ConversationError || error instanceof BotError) {
        const reason = error.code === "bot_not_found" ? "router_unknown_member"
          : error.code === "bot_disabled" ? "router_disabled_member" : error.code;
        const current = store.getRun(runId);
        if (current && (current.state === "completed" || current.state === "failed"
          || current.state === "cancelled" || current.state === "indeterminate")) {
          return { run: current, outcome: "skipped", reason: current.state };
        }
        if (reason === "routing_batch_active" || reason === "stale_routing_attempt") {
          // Another drain already committed a batch for this Run; nothing to do.
          return { run: current ?? run, outcome: "skipped", reason };
        }
        // A domain rejection must settle this attempt durably, including a
        // throwing Bot lookup; the generation fence protects any newer owner.
        const failed = this.failRouting(runId, reason, routingGeneration);
        return { run: failed, outcome: "rejected", reason };
      }
      throw error;
    }
  }

  private async decideWithDeadline(router: ConversationRouter, input: RoutingInput, parent?: AbortSignal): Promise<RoutingDecision> {
    const controller = new AbortController();
    const abort = () => controller.abort(new ConversationError("router_aborted", "Router attempt was aborted"));
    const timer = setTimeout(() => controller.abort(new ConversationError("router_timeout", "Router decision exceeded its deadline")), this.decisionTimeoutMs);
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) abort();
    try {
      // Race owns the lifecycle even when a provider ignores its signal. The
      // attached handlers also consume a detached provider's late rejection.
      const provider = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return router.decide(input, { signal: controller.signal });
      });
      return await Promise.race([provider, aborted]);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  }

  private failRouting(runId: string, reason: string, routingGeneration: number): ConversationRun {
    return this.options.store.failRun(runId, reason, "failed", this.options.now().toISOString(), routingGeneration);
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
    if (!request || !requestSnapshotMatches(request, run)) {
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
    };
    const transcript = store.listMessages(transcriptQuery).reverse().map((message) => ({
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
    const candidates: RoutingMember[] = [];
    const disabled: RoutingMember[] = [];
    for (const botId of conversation.botIds) {
      const bot = this.options.readBot(botId);
      // A member whose Bot row vanished mid-Run is not routable: report it
      // disabled rather than fabricating metadata.
      if (!bot) {
        if (disabled.length < MAX_ROUTER_MEMBER_METADATA) disabled.push({ botId, name: botId, agent: "", workspace: topic.executionTarget.workspace, enabled: false });
        continue;
      }
      const metadata: RoutingMember = {
        botId: bot.id,
        name: bot.name,
        ...(bot.role ? { role: bot.role } : {}),
        agent: bot.agent,
        workspace: bot.workspace,
        ...(bot.model ? { model: bot.model } : {}),
        ...(bot.effort ? { effort: bot.effort } : {}),
        enabled: bot.enabled === true,
      };
      if (metadata.enabled) candidates.push(metadata);
      else if (disabled.length < MAX_ROUTER_MEMBER_METADATA) disabled.push(metadata);
      if (candidates.length === MAX_ROUTER_MEMBER_METADATA) break;
    }
    const memberMetadata = conversation.botIds.length <= MAX_ROUTER_MEMBER_METADATA
      // Keep the public Group order for ordinary snapshots.
      ? [...candidates, ...disabled].sort((a, b) => conversation.botIds.indexOf(a.botId) - conversation.botIds.indexOf(b.botId))
      : [...candidates, ...disabled].slice(0, MAX_ROUTER_MEMBER_METADATA);
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
        assignment.result = requireMemberResult(store, turn).content;
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
    return boundRoutingInput({
      runId: run.id,
      conversationId: run.conversationId,
      topicId: run.topicId,
      request: request.content,
      requestMessageId: request.id,
      publicTranscript: transcript,
      memberMetadata,
      ...(conversation.botIds.length > memberMetadata.length ? { omittedMemberCount: conversation.botIds.length - memberMetadata.length } : {}),
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
    });
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
    // Resolve dependencies by exact durable MemberTurn execution identity.
    const publicResultOf = new Map<string, string>();
    for (const turn of this.options.store.listMemberTurns(run.id)) {
      if (turn.state !== "completed" || !turn.assignmentId) {
        continue;
      }
      const row = requireMemberResult(this.options.store, turn);
      publicResultOf.set(turn.assignmentId, row.id);
    }
    const assignments = decision.assignments.map((assignment) => {
      const group = this.options.readGroup(run.conversationId);
      // A removed Bot may already have been deleted; production getBot throws
      // in that case. Reject membership before reading its live profile.
      if (!group?.botIds.includes(assignment.botId)) {
        throw new ConversationError("router_unknown_member", `assignment "${assignment.id}" targets a removed member`);
      }
      const bot = this.options.readBot(assignment.botId);
      if (!bot) {
        throw new ConversationError("router_unknown_member", `assignment "${assignment.id}" targets a missing bot`);
      }
      if (!bot.enabled) {
        throw new ConversationError("router_disabled_member", `assignment "${assignment.id}" targets disabled bot "${bot.id}"`);
      }
      const triggers = new Set(assignment.triggerMessageIds);
      triggers.add(run.requestMessageId);
      for (const dependency of assignment.dependsOn ?? []) {
        const resultId = publicResultOf.get(dependency);
        if (resultId) triggers.add(resultId);
      }
      return { ...assignment, triggerMessageIds: [...triggers], profileSnapshot: snapshotGroupMemberProfile(bot, target, now) };
    });
    if (decision.mode === "parallel") {
      const commonTriggers = [...new Set(assignments.flatMap((assignment) => assignment.triggerMessageIds))];
      for (const assignment of assignments) assignment.triggerMessageIds = [...commonTriggers];
    }
    return {
      type: "dispatch",
      mode: decision.mode,
      assignments,
    };
  }

}
