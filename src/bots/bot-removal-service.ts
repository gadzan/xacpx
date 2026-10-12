import { BotError } from "./bot-error";
import {
  botRemovalRevision,
  groupRemovalBlocker,
  removalBlocksWork,
  tombstoneFromProfile,
  transitionBotRemoval,
  worktreeBlocksRemoval,
  type BotRemovalFacts,
  type BotRemovalPreview,
} from "./bot-removal";
import type { BotService } from "./bot-service";
import { ConversationError } from "../conversations/conversation-error";
import type { ConversationRunService } from "../conversations/conversation-run-service";
import {
  lifecycleOperationId,
  transitionLifecycleOperation,
  type LifecycleOperation,
} from "../conversations/lifecycle-operation";
import type { SqliteConversationStore } from "../conversations/sqlite-conversation-store";
import { createDirectConversationId } from "../domain/ids";
import type { AppState } from "../state/types";

const LIVE_MEMBER = new Set(["queued", "dispatched", "running"]);

export interface RemoveBotInput {
  botId: string;
  requestId: string;
  previewRevision: string;
  clearDirectHistory: boolean;
  releaseDirectBindings: boolean;
}

/**
 * Controlled bot removal. SQLite holds the accept barrier. AppState holds the
 * phase record. The barrier is written first. A later accept that finds the
 * AppState phase without a barrier installs the barrier before it admits work.
 */
export class BotRemovalService {
  constructor(
    private readonly bots: BotService,
    private readonly runs: ConversationRunService,
    private readonly store: SqliteConversationStore,
    private readonly state: AppState,
    private readonly now: () => Date = () => new Date(),
    private readonly afterBarrier?: () => Promise<void>,
  ) {}

  async preview(botId: string): Promise<BotRemovalPreview> {
    const identity = this.identity(botId);
    const facts = this.facts(botId, identity.directConversationId);
    const revision = botRemovalRevision(facts);
    const current = this.bots.removal(botId);
    if (!current || current.phase === "previewed") {
      await this.bots.writeRemoval(
        transitionBotRemoval(current, botId, { type: "preview", revision, at: this.stamp() }),
        false,
      );
    }
    return this.present(
      botId,
      identity.name,
      revision,
      facts,
      this.store.latestLifecycleOperation("bot-remove", botId),
    );
  }

  async remove(input: RemoveBotInput): Promise<LifecycleOperation> {
    const identity = this.identity(input.botId);
    const operationId = lifecycleOperationId("bot-remove", input.requestId);
    const existing = this.store.findLifecycleOperation("bot-remove", input.requestId);
    if (existing && existing.subjectId !== input.botId) {
      throw new ConversationError("lifecycle_operation_conflict", "request id is already used");
    }
    if (existing?.phase === "completed") {
      return existing;
    }
    const recorded = this.bots.removal(input.botId);
    if ((recorded?.phase === "retired" || this.store.botRemovalPhase(input.botId) === "retired")
      && recorded?.requestId
      && recorded.requestId !== input.requestId) {
      throw new BotError("bot_retired", `bot "${input.botId}" is already removed`);
    }
    if (recorded?.phase === "retired" || this.store.botRemovalPhase(input.botId) === "retired") {
      return await this.finishRetired(input.botId, operationId, input.requestId);
    }

    const clearDirectHistory = existing?.params?.clearDirectHistory ?? input.clearDirectHistory;
    const releaseDirectBindings = existing?.params?.releaseDirectBindings ?? input.releaseDirectBindings;
    await this.bots.runLifecycle(input.botId, async () => {
      const facts = this.facts(input.botId, identity.directConversationId);
      const revision = botRemovalRevision(facts);
      const open = this.store.getLifecycleOperation(operationId);
      if (!open && revision !== input.previewRevision) {
        throw new BotError("removal_stale", `bot "${input.botId}" changed since the preview`, { revision });
      }
      this.assertRemovable(input.botId, facts, releaseDirectBindings);
      const at = this.stamp();
      this.store.setBotRemovalBarrier(input.botId, "deleting", at);
      await this.bots.writeRemoval(transitionBotRemoval(this.bots.removal(input.botId), input.botId, {
        type: "begin",
        operationId,
        requestId: input.requestId,
        revision: input.previewRevision,
        clearDirectHistory,
        releaseDirectBindings,
        at,
      }), false);
      this.store.saveLifecycleOperation(transitionLifecycleOperation(open ?? existing, {
        type: "start",
        id: operationId,
        kind: "bot-remove",
        subjectId: input.botId,
        requestId: input.requestId,
        previewRevision: input.previewRevision,
        params: { clearDirectHistory, releaseDirectBindings },
        at,
      }));
    });

    await this.afterBarrier?.();
    try {
      await this.cleanup(input.botId, clearDirectHistory, releaseDirectBindings);
      return await this.retire(input.botId, operationId);
    } catch (error) {
      await this.noteFailure(input.botId, operationId, error);
      throw error;
    }
  }

  getOperation(id: string): LifecycleOperation {
    const operation = this.store.getLifecycleOperation(id);
    if (!operation) {
      throw new ConversationError("lifecycle_operation_not_found", `operation "${id}" does not exist`);
    }
    return operation;
  }

  private async cleanup(botId: string, clearDirectHistory: boolean, releaseDirectBindings: boolean): Promise<void> {
    const direct = await this.runs.cancelDirectExecution(botId);
    if (direct === "indeterminate") {
      throw new ConversationError("conversation_indeterminate", `bot "${botId}" has indeterminate direct work`);
    }
    const member = await this.runs.releaseDepartedMemberExecution(botId);
    if (member === "indeterminate") {
      throw new ConversationError("conversation_indeterminate", `bot "${botId}" has indeterminate group work`);
    }
    await this.runs.releaseDirectExecution(botId, releaseDirectBindings || clearDirectHistory);
    if (this.store.hasOpenBotDispatch(botId)) {
      throw new ConversationError("conversation_not_settled", `bot "${botId}" still has an open dispatch`);
    }
    if (clearDirectHistory) {
      await this.runs.eraseDirectHistory(botId);
    }
  }

  private async retire(botId: string, operationId: string): Promise<LifecycleOperation> {
    return await this.bots.runLifecycle(botId, async () => {
      const live = this.state.bots[botId];
      if (!live) {
        throw new BotError("bot_not_found", `bot "${botId}" does not exist`);
      }
      const at = this.stamp();
      this.store.setBotRemovalBarrier(botId, "retired", at);
      await this.bots.writeRemoval(transitionBotRemoval(this.bots.removal(botId), botId, {
        type: "retire",
        tombstone: tombstoneFromProfile(live, at),
        at,
      }), true);
      const completed = transitionLifecycleOperation(this.store.getLifecycleOperation(operationId), {
        type: "complete",
        at,
      });
      this.store.saveLifecycleOperation(completed);
      return completed;
    });
  }

  private async finishRetired(botId: string, operationId: string, requestId: string): Promise<LifecycleOperation> {
    const at = this.stamp();
    this.store.setBotRemovalBarrier(botId, "retired", at);
    const live = this.state.bots[botId];
    if (live) {
      await this.bots.writeRemoval(transitionBotRemoval(this.bots.removal(botId), botId, {
        type: "retire",
        tombstone: tombstoneFromProfile(live, at),
        at,
      }), true);
    }
    const current = this.store.getLifecycleOperation(operationId);
    const started = transitionLifecycleOperation(current, {
      type: "start",
      id: operationId,
      kind: "bot-remove",
      subjectId: botId,
      requestId,
      at,
    });
    const done = transitionLifecycleOperation(started, { type: "complete", at });
    this.store.saveLifecycleOperation(done);
    return done;
  }

  private async noteFailure(botId: string, operationId: string, error: unknown): Promise<void> {
    const code = error instanceof ConversationError || error instanceof BotError ? error.code : "internal";
    const message = error instanceof Error ? error.message : String(error);
    const at = this.stamp();
    const indeterminate = code === "conversation_indeterminate";
    this.store.setBotRemovalBarrier(botId, indeterminate ? "indeterminate" : "deleting", at);
    const record = this.bots.removal(botId);
    if (record && removalBlocksWork(record.phase)) {
      await this.bots.writeRemoval(transitionBotRemoval(record, botId, indeterminate
        ? { type: "indeterminate", error: { code, message }, at }
        : { type: "fail", error: { code, message }, at }), false);
    }
    const current = this.store.getLifecycleOperation(operationId);
    if (!current) {
      return;
    }
    this.store.saveLifecycleOperation(transitionLifecycleOperation(current, indeterminate
      ? { type: "indeterminate", error: { code, message }, at }
      : { type: "fail", error: { code, message }, at }));
  }

  private assertRemovable(botId: string, facts: BotRemovalFacts, releaseDirectBindings: boolean): void {
    if (facts.groups.length > 0) {
      throw new BotError("bot_in_group", `bot "${botId}" is still in a group`, {
        conversationIds: facts.groups.map((group) => group.conversationId),
      });
    }
    const residue = this.bots.directControllerResidue(botId);
    if (residue.bindingIds.length > 0 || residue.sessionAliases.length > 0) {
      throw new BotError("bot_in_use", `bot "${botId}" still has a controller runtime`, residue);
    }
    const blockingTrees = facts.worktreeKeys.filter((key) => key.endsWith(":blocking"));
    if (blockingTrees.length > 0) {
      throw new BotError("bot_worktree_pending", `bot "${botId}" still has an unmerged worktree`, {
        worktrees: blockingTrees,
      });
    }
    if (facts.memberUnsettledRunIds.length > 0) {
      throw new BotError("bot_member_unsettled", `bot "${botId}" still has group member work`, {
        runIds: facts.memberUnsettledRunIds,
      });
    }
    if (facts.bindingKeys.length > 0 && !releaseDirectBindings) {
      throw new BotError("bot_bindings_present", `bot "${botId}" still has external direct bindings`, {
        bindings: facts.bindingKeys,
      });
    }
  }

  private identity(botId: string): { name: string; directConversationId: string } {
    const profile = this.state.bots[botId];
    const tombstone = this.bots.removal(botId)?.tombstone;
    if (!profile && !tombstone) {
      throw new BotError("bot_not_found", `bot "${botId}" does not exist`);
    }
    return {
      name: profile?.name ?? tombstone?.name ?? botId,
      directConversationId: createDirectConversationId(botId),
    };
  }

  private facts(botId: string, directConversationId: string): BotRemovalFacts {
    const runs = this.store.listRuns(directConversationId);
    const memberTurns = this.store.listBotMemberTurns(botId)
      .filter((turn) => turn.conversationId !== directConversationId);
    const groups = Object.values(this.state.conversations)
      .filter((conversation) => conversation.kind === "group" && conversation.botIds.includes(botId))
      .map((conversation) => ({
        conversationId: conversation.id,
        memberCount: conversation.botIds.length,
        botIds: [...conversation.botIds],
      }));
    const runtimes: string[] = [];
    for (const binding of Object.values(this.state.bot_runtime_bindings)) {
      if (binding.scope === "group-member" && binding.botId === botId) {
        runtimes.push(`binding:${binding.id}`);
      }
    }
    for (const session of Object.values(this.state.sessions)) {
      if (session.owner?.kind === "group-member" && session.owner.botId === botId) {
        runtimes.push(`session:${session.alias}`);
      }
    }
    const worktreeKeys: string[] = [];
    for (const run of this.store.worktrees.list()) {
      for (const resource of run.resources) {
        if (resource.kind === "member" && resource.botId === botId) {
          const blocking = worktreeBlocksRemoval(resource.state, run.disposition);
          worktreeKeys.push(`${run.runId}:${resource.id}:${blocking ? "blocking" : "settled"}`);
        }
      }
    }
    const bindingKeys = [
      ...this.store.listConversationBindings()
        .filter((binding) => binding.conversationId === directConversationId)
        .map((binding) => binding.chatKey),
      ...this.store.listExternalRequests(directConversationId).map((request) => request.sourceKey),
    ];
    return {
      directTopicIds: Object.values(this.state.conversation_topics)
        .filter((topic) => topic.conversationId === directConversationId)
        .map((topic) => topic.id),
      activeRunIds: runs.filter((run) => run.state === "running" || run.state === "waiting-human").map((run) => run.id),
      queuedRunIds: runs.filter((run) => run.state === "queued").map((run) => run.id),
      indeterminateRunIds: runs.filter((run) => run.state === "indeterminate").map((run) => run.id),
      memberUnsettledRunIds: [...new Set(memberTurns.filter((turn) => LIVE_MEMBER.has(turn.state)).map((turn) => turn.runId))],
      groups,
      memberRuntimeKeys: runtimes,
      worktreeKeys,
      bindingKeys,
      history: this.store.botHistoryCounts(botId, directConversationId),
    };
  }

  private present(
    botId: string,
    name: string,
    revision: string,
    facts: BotRemovalFacts,
    operation: LifecycleOperation | undefined,
  ): BotRemovalPreview {
    const directConversationId = createDirectConversationId(botId);
    const phase = this.bots.removal(botId)?.phase ?? "active";
    return {
      botId,
      name,
      phase,
      revision,
      directTopics: Object.values(this.state.conversation_topics)
        .filter((topic) => topic.conversationId === directConversationId)
        .map((topic) => ({ id: topic.id, title: topic.title, status: topic.status })),
      runs: {
        active: facts.activeRunIds,
        queued: facts.queuedRunIds,
        indeterminate: facts.indeterminateRunIds,
      },
      groups: facts.groups.map((group) => ({
        conversationId: group.conversationId,
        title: this.state.conversations[group.conversationId]?.title ?? group.conversationId,
        memberCount: group.memberCount,
        blocker: groupRemovalBlocker(group.memberCount),
      })),
      departedMemberRuntimes: this.departedRuntimes(botId),
      worktrees: this.worktreeRows(botId),
      externalBindings: [
        ...this.store.listConversationBindings()
          .filter((binding) => binding.conversationId === directConversationId)
          .map((binding) => ({
            key: binding.chatKey,
            conversationId: binding.conversationId,
            topicId: binding.topicId,
          })),
        ...this.store.listExternalRequests(directConversationId).map((request) => ({
          key: request.sourceKey,
          conversationId: request.conversationId,
          topicId: request.topicId,
        })),
      ],
      history: facts.history,
      controllerResidue: this.bots.directControllerResidue(botId),
      memberUnsettledRunIds: facts.memberUnsettledRunIds,
      ...(operation
        ? {
          operation: {
            id: operation.id,
            requestId: operation.requestId,
            phase: operation.phase,
            ...(operation.error ? { error: operation.error } : {}),
          },
        }
        : {}),
    };
  }

  private departedRuntimes(botId: string): BotRemovalPreview["departedMemberRuntimes"] {
    const rows: BotRemovalPreview["departedMemberRuntimes"] = [];
    for (const binding of Object.values(this.state.bot_runtime_bindings)) {
      if (binding.scope !== "group-member" || binding.botId !== botId) {
        continue;
      }
      const group = this.state.conversations[binding.conversationId];
      if (group?.kind === "group" && group.botIds.includes(botId)) {
        continue;
      }
      rows.push({
        conversationId: binding.conversationId,
        topicId: binding.topicId,
        bindingId: binding.id,
        sessionAlias: binding.sessionAlias,
      });
    }
    return rows;
  }

  private worktreeRows(botId: string): BotRemovalPreview["worktrees"] {
    const rows: BotRemovalPreview["worktrees"] = [];
    for (const run of this.store.worktrees.list()) {
      for (const resource of run.resources) {
        if (resource.kind === "member" && resource.botId === botId && worktreeBlocksRemoval(resource.state, run.disposition)) {
          rows.push({
            runId: run.runId,
            conversationId: run.conversationId,
            topicId: run.topicId,
            state: resource.state,
          });
        }
      }
    }
    return rows;
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
