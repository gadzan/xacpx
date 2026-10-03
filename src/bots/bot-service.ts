import type { AppConfig } from "../config/types";
import {
  createBotId,
  createConversationId,
  createDirectBindingId,
  createDirectConversationId,
  createDirectTopicId,
  createScopedDirectBindingId,
  createScopedGroupMemberBindingId,
} from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { StateStore } from "../state/state-store";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { AppState, LogicalSession } from "../state/types";
import { BotError } from "./bot-error";
import { BotLifecycleGate } from "./bot-lifecycle-gate";
import type { BotProfile, BotRuntimeBinding } from "./bot-types";
import type { ConversationRecord } from "../conversations/conversation-types";

const NAME_MAX = 80;
const TEXT_MAX = 16_384;

export interface CreateBotInput {
  name: string;
  avatar?: string;
  role?: string;
  instructions?: string;
  agent: string;
  workspace: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
}

export interface UpdateBotInput {
  name?: string;
  avatar?: string | null;
  role?: string | null;
  instructions?: string | null;
  agent?: string;
  workspace?: string;
  model?: string | null;
  effort?: string | null;
  enabled?: boolean | null;
}

export interface CreateGroupInput {
  title: string;
  description?: string;
  botIds: string[];
  leadBotId?: string;
}

export interface UpdateGroupInput {
  title?: string;
  description?: string | null;
  botIds?: string[];
  leadBotId?: string | null;
}

export type BotLifecycleMutation = "update" | "delete";

export type DirectBotSessionOwnership = "owned" | "foreign" | "conflict";
export type DirectBotRuntimeBinding = Extract<BotRuntimeBinding, { scope: "bot-direct" }>;
export type GroupMemberRuntimeBinding = Extract<BotRuntimeBinding, { scope: "group-member" }>;

export function classifyDirectBotRuntimeBindingOwnership(
  binding: BotRuntimeBinding,
  botId: string,
  conversationId = createDirectConversationId(botId),
): DirectBotSessionOwnership {
  if (binding.scope !== "bot-direct") {
    return "foreign";
  }
  const botMatches = binding.botId === botId;
  const conversationMatches = binding.conversationId === conversationId;
  const legacyIdMatches = binding.id === createDirectBindingId(botId);
  const scopedIdMatches = binding.id === createScopedDirectBindingId(
    conversationId,
    binding.topicId,
    botId,
  );

  if (botMatches) {
    if (!conversationMatches) {
      return "conflict";
    }
    if (legacyIdMatches) {
      return binding.topicId === createDirectTopicId(botId) ? "owned" : "conflict";
    }
    return scopedIdMatches ? "owned" : "conflict";
  }

  // A foreign Bot may never occupy this Bot's deterministic conversation/binding
  // identity. Treat that as contradictory rather than silently ignoring it.
  return conversationMatches || legacyIdMatches || scopedIdMatches ? "conflict" : "foreign";
}

/**
 * Classify Direct Bot ownership without letting legacy metadata override explicit
 * identity. PR2 records may omit botId and infer ownership from the deterministic
 * bindingId; if they also carry conversationId, both legacy signals must agree.
 */
export function classifyDirectBotSessionOwnership(
  session: Pick<LogicalSession, "owner">,
  botId: string,
  ownedBindingIds: ReadonlySet<string>,
  conversationId = createDirectConversationId(botId),
): DirectBotSessionOwnership {
  const owner = session.owner;
  if (owner?.kind !== "bot-direct") {
    return "foreign";
  }
  const bindingMatches = ownedBindingIds.has(owner.bindingId)
    || owner.bindingId === createDirectBindingId(botId);
  const hasConversation = owner.conversationId !== undefined;
  const conversationMatches = owner.conversationId === conversationId;

  if (owner.botId !== undefined) {
    if (owner.botId === botId) {
      return hasConversation && !conversationMatches ? "conflict" : "owned";
    }
    return bindingMatches || conversationMatches ? "conflict" : "foreign";
  }

  if (hasConversation) {
    if (bindingMatches !== conversationMatches) {
      return "conflict";
    }
    return bindingMatches ? "owned" : "foreign";
  }
  return bindingMatches ? "owned" : "foreign";
}

export function sessionOwnedByDirectBot(
  session: Pick<LogicalSession, "owner">,
  botId: string,
  ownedBindingIds: ReadonlySet<string>,
): boolean {
  return classifyDirectBotSessionOwnership(session, botId, ownedBindingIds) === "owned";
}

/**
 * Group-member mirror of the direct classifiers. Ownership is exact triple
 * (conversationId × topicId × botId) plus the deterministic scoped binding
 * id — never a display name, alias prefix, or Bot-count heuristic. A binding
 * or session that claims group membership for the wrong triple is a conflict,
 * not silently foreign: teardown and dispatch must fail closed on it.
 */
export function classifyGroupMemberBindingOwnership(
  binding: BotRuntimeBinding,
  botId: string,
  conversationId: string,
  topicId: string,
): DirectBotSessionOwnership {
  if (binding.scope !== "group-member") {
    return "foreign";
  }
  if (binding.conversationId !== conversationId || binding.topicId !== topicId) {
    return "foreign";
  }
  if (binding.botId !== botId) {
    return "conflict";
  }
  return binding.id === createScopedGroupMemberBindingId(conversationId, topicId, botId)
    ? "owned"
    : "conflict";
}

export function classifyGroupMemberSessionOwnership(
  session: Pick<LogicalSession, "owner">,
  botId: string,
  bindingId: string,
  conversationId: string,
  topicId: string,
): DirectBotSessionOwnership {
  const owner = session.owner;
  if (owner?.kind !== "group-member") {
    return "foreign";
  }
  if (owner.bindingId !== bindingId) {
    return "foreign";
  }
  if (owner.botId !== undefined && owner.botId !== botId) {
    return "conflict";
  }
  if (owner.conversationId !== undefined && owner.conversationId !== conversationId) {
    return "conflict";
  }
  if (owner.topicId !== undefined && owner.topicId !== topicId) {
    return "conflict";
  }
  return "owned";
}

/** A persisted member binding may drive physical teardown only when its
 *  cross-record link resolves to exactly the same owned LogicalSession. */
export function classifyGroupMemberBindingSessionLink(
  binding: GroupMemberRuntimeBinding,
  session: LogicalSession,
  bindingId: string,
  botId: string,
  conversationId: string,
  topicId: string,
): "owned" | "conflict" {
  const ownership = classifyGroupMemberSessionOwnership(
    session,
    botId,
    bindingId,
    conversationId,
    topicId,
  );
  const owner = session.owner;
  if (
    ownership !== "owned"
    || session.alias !== binding.sessionAlias
    || session.logical_session_id !== binding.logicalSessionId
    || owner?.kind !== "group-member"
    || owner.bindingId !== binding.id
    || (owner.topicId !== undefined && owner.topicId !== binding.topicId)
  ) {
    return "conflict";
  }
  return "owned";
}

/** A persisted binding may drive physical teardown only when its cross-record
 *  link resolves to exactly the same owned LogicalSession. */
export function classifyDirectBotBindingSessionLink(
  binding: DirectBotRuntimeBinding,
  session: LogicalSession,
  ownedBindingIds: ReadonlySet<string>,
): "owned" | "conflict" {
  const ownership = classifyDirectBotSessionOwnership(
    session,
    binding.botId,
    ownedBindingIds,
    binding.conversationId,
  );
  const owner = session.owner;
  if (
    ownership !== "owned"
    || session.alias !== binding.sessionAlias
    || session.logical_session_id !== binding.logicalSessionId
    || owner?.kind !== "bot-direct"
    || owner.bindingId !== binding.id
    || (owner.topicId !== undefined && owner.topicId !== binding.topicId)
  ) {
    return "conflict";
  }
  return "owned";
}

export interface BotConversationWork {
  hasDurableBotWork(botId: string): boolean;
  /** True when any durable Conversation rows exist for a Group (runs,
   *  messages, dispatches, lifecycle, or seq allocation). Optional so older
   *  implementers (tests) keep working; absence means "unknown, do not
   *  block". */
  hasDurableGroupWork?: (conversationId: string) => boolean;
  /** True when a nonterminal MemberTurn in this Conversation references the
   *  Bot. Membership removal must wait until that work terminals (PR6
   *  freeze: removed-member durable work has no correct interpretation —
   *  its claims would requeue forever). Optional so older implementers
   *  (tests) keep working; absence means "unknown, do not block". */
  hasNonterminalGroupMemberWork?: (conversationId: string, botId: string) => boolean;
}

export interface BotServiceOptions {
  now?: () => Date;
  createId?: () => string;
  stateMutex?: AsyncMutex;
  lifecycleGate?: BotLifecycleGate;
  beforeLifecycleMutation?: (input: { botId: string; op: BotLifecycleMutation }) => Promise<void>;
  /** Test-only seam: runs between the updateGroup stale probe and gate
   *  acquisition, so tests can deterministically interleave a racing commit.
   *  Never wired in production. */
  beforeGroupGatesAcquired?: () => Promise<void>;
  conversationWork?: BotConversationWork;
  /** Called after a Bot transitions false -> true. Used to wake pending
   *  durable work (e.g. Runs deferred while disabled) without a new prompt. */
  onBotReenabled?: (botId: string) => void;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };

export class BotService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly stateMutex: AsyncMutex;
  private readonly lifecycleGate: BotLifecycleGate;
  private readonly beforeLifecycleMutation?: (input: { botId: string; op: BotLifecycleMutation }) => Promise<void>;
  private readonly beforeGroupGatesAcquired?: () => Promise<void>;
  private _onBotReenabled?: (botId: string) => void;
  private conversationWork?: BotConversationWork;
  private closed = false;

  constructor(
    private readonly config: Pick<AppConfig, "agents" | "workspaces">,
    private readonly state: AppState,
    private readonly stateStore: SessionWriter,
    options?: BotServiceOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.createId = options?.createId ?? (() => createBotId());
    this.stateMutex = options?.stateMutex ?? new AsyncMutex();
    this.lifecycleGate = options?.lifecycleGate ?? new BotLifecycleGate();
    this.beforeLifecycleMutation = options?.beforeLifecycleMutation;
    this.beforeGroupGatesAcquired = options?.beforeGroupGatesAcquired;
    this._onBotReenabled = options?.onBotReenabled;
    this.conversationWork = options?.conversationWork;
  }

  /** Shared with BotRuntimeManager: one botId, one exclusive lifecycle. */
  runLifecycle<T>(botId: string, critical: () => Promise<T>): Promise<T> {
    return this.lifecycleGate.run(botId, critical);
  }

  /** Run one section while holding every listed Bot gate simultaneously. */
  runLifecycleAll<T>(botIds: readonly string[], critical: () => Promise<T>): Promise<T> {
    return this.lifecycleGate.runAll(botIds, critical);
  }

  /** Composition hook: wake pending durable work when a Bot re-enables. */
  setReenabledHook(hook: ((botId: string) => void) | undefined): void {
    this._onBotReenabled = hook;
  }

  setConversationWork(work: BotConversationWork | undefined): void {
    this.conversationWork = work;
  }

  /** Composition shutdown: no new Bot mutations may start. Reads stay available for drain. */
  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new BotError("runtime_closed", "conversation runtime is closed");
    }
  }

  listBots(): BotProfile[] {
    return Object.values(this.state.bots).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getBot(id: string): BotProfile {
    const bot = this.state.bots[id];
    if (!bot) {
      throw new BotError("bot_not_found", `bot "${id}" does not exist`);
    }
    return bot;
  }

  /** True once the Bot materialized any runtime (direct or group-member).
   *  Agent changes lock on this. Workspace-default changes lock only on
   *  direct runtime: Group Topics always carry an explicit workspace, so the
   *  Bot default never applies to member sessions. A persisted Direct
   *  Conversation alone keeps delete fail-closed via bot_in_use but must NOT
   *  permanently lock identity. */
  hasRuntime(id: string): boolean {
    this.getBot(id);
    return this.hasMaterializedRuntime(id);
  }

  async createBot(input: CreateBotInput): Promise<BotProfile> {
    this.assertOpen();
    return await this.mutate(async () => {
      this.assertOpen();
      this.rejectUnsupportedCwd(input);
      const id = this.nextId();
      const timestamp = this.now().toISOString();
      const bot: BotProfile = {
        id,
        ...this.requireIdentity(input),
        ...this.optionalFields(input),
        enabled: input.enabled ?? true,
        profileRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.bots[id] = bot;
      await this.persist(next);
      return bot;
    });
  }

  async updateBot(id: string, patch: UpdateBotInput): Promise<BotProfile> {
    this.assertOpen();
    return await this.runLifecycle(id, async () => {
      this.assertOpen();
      await this.beforeLifecycleMutation?.({ botId: id, op: "update" });
      return await this.mutate(async () => {
        this.assertOpen();
        this.rejectUnsupportedCwd(patch);
        const existing = this.getBot(id);
        if (patch.agent !== undefined && patch.agent !== existing.agent && this.hasMaterializedRuntime(id)) {
          throw new BotError("runtime_identity_locked", `bot "${id}" agent cannot change while a runtime exists`);
        }
        // Group Topics always carry an explicit workspace (Bot default never
        // applies to member sessions), so only direct runtime locks the
        // workspace default. Agent changes stay locked by any runtime.
        if (patch.workspace !== undefined && patch.workspace !== existing.workspace && this.hasDefaultWorkspaceRuntime(id)) {
          throw new BotError("runtime_identity_locked", `bot "${id}" workspace cannot change while a runtime exists`);
        }
        const identity = this.requireIdentity({
          name: this.requirePatchString(patch.name, existing.name, "name"),
          agent: this.requirePatchString(patch.agent, existing.agent, "agent"),
          workspace: this.requirePatchString(patch.workspace, existing.workspace, "workspace"),
        });
        const next: BotProfile = {
          ...existing,
          ...identity,
          ...this.patchOptional(existing, patch),
          enabled: patch.enabled === undefined || patch.enabled === null ? existing.enabled : patch.enabled,
          profileRevision: (existing.profileRevision ?? 1) + 1,
          updatedAt: this.now().toISOString(),
        };
        const nextState = structuredClone(this.state);
        nextState.bots[id] = next;
        await this.persist(nextState);
        if (!existing.enabled && next.enabled) {
          this._onBotReenabled?.(id);
        }
        return next;
      });
    });
  }

  async deleteBot(id: string): Promise<void> {
    this.assertOpen();
    await this.runLifecycle(id, async () => {
      this.assertOpen();
      await this.beforeLifecycleMutation?.({ botId: id, op: "delete" });
      await this.mutate(async () => {
        this.assertOpen();
        this.getBot(id);
        const groups = Object.values(this.state.conversations).filter(
          (conversation) => conversation.kind === "group" && conversation.botIds.includes(id),
        );
        if (groups.length > 0) {
          throw new BotError("bot_in_group", `bot "${id}" is referenced by groups`, {
            conversationIds: groups.map((group) => group.id),
          });
        }
        const runtime = this.directRuntimeRefs(id);
        if (runtime.conversationIds.length > 0 || runtime.bindingIds.length > 0 || runtime.sessionAliases.length > 0) {
          throw new BotError("bot_in_use", `bot "${id}" still has a direct runtime`, runtime);
        }
        // Provisional controller rows resolving to this Bot's deterministic
        // Direct root have no release path: deleting the Bot would orphan a
        // hidden session whose cleanup root (the Bot) is gone — and even
        // verified Direct teardown could no longer run (getBot fails).
        const controller = this.controllerResidueForDirectRoot(id);
        if (controller.bindingIds.length > 0 || controller.sessionAliases.length > 0) {
          throw new BotError("bot_in_use", `bot "${id}" still has a provisional controller runtime`, controller);
        }
        // Binding-less group-member crash-window sessions carry no binding
        // row and the session classifier above only recognizes bot-direct
        // owners: a removed member's durable session would otherwise pass
        if (this.hasGroupMemberRuntime(id)) {
          throw new BotError("bot_in_use", `bot "${id}" still has a group-member runtime`, {
            conversationIds: [],
          });
        }
        if (this.conversationWork?.hasDurableBotWork(id)) {
          throw new BotError("bot_in_use", `bot "${id}" still has durable conversation work`, {
            conversationIds: [createDirectConversationId(id)],
          });
        }
        const next = structuredClone(this.state);
        delete next.bots[id];
        await this.persist(next);
      });
    });
  }
  /**
   * PR6 Group metadata. A Group is a durable membership record only: no
   * execution, routing, or member sessions happen here. Membership stores Bot
   * ids that must exist at write time; enabled-ness is NOT checked here (a
   * temporary disable must not destroy Group shape, and a write-time enabled
   * check would be TOCTOU anyway). PR7 explicit routing refuses disabled or
   * missing members at dispatch time. The lead, when set, must belong to
   * membership. Group identity is a random opaque id — never derived from
   * title or member names.
   */
  async createGroup(input: CreateGroupInput): Promise<ConversationRecord> {
    this.assertOpen();
    return await this.mutate(async () => {
      this.assertOpen();
      const membership = this.requireGroupMembership(input.botIds);
      const leadBotId = this.requireGroupLead(input.leadBotId, membership);
      const title = this.requireGroupTitle(input.title);
      const description = this.optionalGroupDescription(input.description);
      const timestamp = this.now().toISOString();
      const id = createConversationId();
      const record: ConversationRecord = {
        id,
        kind: "group",
        title,
        ...(description ? { description } : {}),
        botIds: membership,
        ...(leadBotId ? { leadBotId } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next = structuredClone(this.state);
      next.conversations[id] = record;
      await this.persist(next);
      return record;
    });
  }

  async updateGroup(id: string, patch: UpdateGroupInput): Promise<ConversationRecord> {
    this.assertOpen();
    // Linearize membership edits against member materialization and topic
    // teardown: hold old ∪ new member gates while validating + writing, so a
    // materializer cannot snapshot membership, then mint a session for a Bot
    // that concurrently leaves the Group (binding-less orphan), and teardown
    // cannot miss a member added mid-barrier. Non-membership edits still take
    // the union (existing membership) for the same reason. Deleting Groups
    // refuse edits: the record is about to disappear.
    //
    // The union is a STALE probe: a concurrent updateGroup can commit a new
    // membership after this probe reads, so acquisition re-verifies inside
    // the gates (retry-with-widen) before updateGroupInner runs. A Bot added
    // by the racing commit must be gated before it can be removed again —
    // otherwise the remover never holds the added Bot's gate and a racing
    // materializer for it publishes binding-less residue past the edit.
    for (;;) {
      const probe = this.state.conversations[id];
      if (!probe || probe.kind !== "group") {
        return await this.mutate(async () => this.updateGroupInner(id, patch));
      }
      const previewMembership = patch.botIds !== undefined ? [...patch.botIds] : [...probe.botIds];
      const previewLead = patch.leadBotId !== undefined ? patch.leadBotId : probe.leadBotId;
      const gateSet = new Set<string>([...probe.botIds, ...previewMembership]);
      if (previewLead !== undefined && previewLead !== null) {
        gateSet.add(previewLead);
      }
      await this.beforeGroupGatesAcquired?.();
      // Existence is required only for NEW membership and the (new) lead:
      // those must be live Bots a materializer could actually target. OLD
      // members stay as gate keys for linearization only — a load-quarantined
      // Bot can never start a materializer (its mutex is minted but never
      // contended), and requiring its existence would make the Group
      // unrepairable: even a healthy `botIds` patch or a title edit would
      // fail bot_not_found before any gate is acquired.
      const mustExist = new Set<string>(patch.botIds !== undefined ? patch.botIds : []);
      if (patch.leadBotId !== undefined && patch.leadBotId !== null) {
        mustExist.add(patch.leadBotId);
      }
      for (const botId of mustExist) {
        this.getBot(botId);
      }
      const committed = await this.runLifecycleAll([...gateSet], async () => {
        const live = this.state.conversations[id];
        if (!live || live.kind !== "group") {
          // Deleted (or never a Group) while acquiring: inner re-reads
          // under the same gates and fails closed with the canonical
          // not-found code — never a silent no-op.
          return await this.updateGroupInner(id, patch);
        }
        const liveMembership = live.botIds;
        const uncovered = [...liveMembership, ...(live.leadBotId ? [live.leadBotId] : [])].filter(
          (botId) => !gateSet.has(botId),
        );
        if (uncovered.length > 0) {
          return null;
        }
        // Validate BEFORE committing: membership/lead/title shape errors
        // must throw now (not retry) — retrying a deterministically
        // invalid patch would spin forever re-acquiring the same gates.
        if (patch.botIds !== undefined) {
          this.requireGroupMembership(patch.botIds);
          // PR6 authority freeze: removing a member that still has
          // nonterminal durable work has no correct interpretation — its
          // claims would requeue forever (materialize fails
          // group_member_not_member; the generic pre-start path releases the
          // claim back to pending). Refuse the removal; retry once the Run
          // terminals or is cancelled. Adding members is never blocked.
          const removed = live.botIds.filter((botId) => !patch.botIds!.includes(botId));
          for (const botId of removed) {
            if (this.conversationWork?.hasNonterminalGroupMemberWork?.(id, botId)) {
              throw new BotError(
                "group_member_has_work",
                `bot "${botId}" still has nonterminal work in group "${id}"; wait for the Run to finish or cancel it first`,
                { botId, conversationId: id },
              );
            }
          }
        }
        const livePreview = patch.botIds !== undefined ? patch.botIds : live.botIds;
        if (patch.leadBotId !== undefined) {
          this.requireGroupLead(patch.leadBotId, livePreview);
        } else {
          this.requireGroupLead(live.leadBotId, livePreview);
        }
        if (patch.title !== undefined) {
          this.requireGroupTitle(patch.title);
        }
        return await this.updateGroupInner(id, patch);
        },
      );
      if (committed !== null) {
        return committed;
      }
    }
  }

  private async updateGroupInner(id: string, patch: UpdateGroupInput): Promise<ConversationRecord> {
    return await this.mutate(async () => {
      this.assertOpen();
      const existing = this.getGroup(id);
      if (existing.lifecycle === "deleting") {
        throw new BotError("conversation_deleting", `group "${id}" is deleting`);
      }
      const membership = patch.botIds !== undefined ? this.requireGroupMembership(patch.botIds) : existing.botIds;
      const leadBotId = patch.leadBotId !== undefined
        ? this.requireGroupLead(patch.leadBotId, membership)
        : this.requireGroupLead(existing.leadBotId, membership);
      const title = patch.title !== undefined ? this.requireGroupTitle(patch.title) : existing.title;
      const description = patch.description !== undefined
        ? this.optionalGroupDescription(patch.description)
        : existing.description;
      const next: ConversationRecord = {
        ...existing,
        title,
        ...(description ? { description } : {}),
        botIds: membership,
        ...(leadBotId ? { leadBotId } : {}),
        updatedAt: this.now().toISOString(),
      };
      if (!leadBotId) {
        delete next.leadBotId;
      }
      if (!description) {
        delete next.description;
      }
      const nextState = structuredClone(this.state);
      nextState.conversations[id] = next;
      await this.persist(nextState);
      return next;
    });
  }

  /**
   * Group metadata delete. Fail-closed while the Group still owns Topics,
   * member bindings/sessions, or durable Conversation rows: deleting the
   * record first would orphan Topics whose teardown requires the Group row
   * (`requireGroupTopic`) and strand runtime ownership with no cleanup
   * entrypoint. Callers teardown every Topic first
   * (`ConversationRunService.teardownGroupTopic`), then delete the Group.
   * A read of `state` inside `mutate` is safe: `mutate` serializes writers
   * on the daemon stateMutex and the check+delete are one critical section.
   */
  async deleteGroup(id: string): Promise<void> {
    this.assertOpen();
    return await this.mutate(async () => {
      this.assertOpen();
      this.getGroup(id);
      const topics = Object.values(this.state.conversation_topics).filter(
        (topic) => topic.conversationId === id,
      );
      if (topics.length > 0) {
        throw new BotError("group_has_topics", `group "${id}" still has ${topics.length} topic(s)`, {
          conversationId: id,
          topicIds: topics.map((topic) => topic.id),
        });
      }
      const bindings = Object.values(this.state.bot_runtime_bindings).filter(
        (binding) => binding.conversationId === id,
      );
      if (bindings.length > 0) {
        throw new BotError("group_has_runtime", `group "${id}" still has runtime bindings`, {
          conversationId: id,
          bindingIds: bindings.map((binding) => binding.id),
        });
      }
      // Binding-less crash-window sessions carry no binding row but still pin
      // ownership (and the agent identity lock). Any group-member owned
      // session — exact, partial, or contradictory — blocks the delete; the
      // verified teardown path releases or fails closed on it first.
      const memberSessions = Object.values(this.state.sessions).filter(
        (session) => session.owner?.kind === "group-member" && session.owner.conversationId === id,
      );
      // Legacy owners may omit conversationId: resolve through the binding
      // row; an unresolvable legacy owner for this group still blocks.
      const legacySessions = Object.values(this.state.sessions).filter((session) => {
        const owner = session.owner;
        if (owner?.kind !== "group-member" || owner.conversationId !== undefined) {
          return false;
        }
        const bound = this.state.bot_runtime_bindings[owner.bindingId];
        return bound !== undefined && bound.conversationId === id;
      });
      const residue = [...memberSessions, ...legacySessions];
      if (residue.length > 0) {
        throw new BotError("group_has_runtime", `group "${id}" still has member sessions`, {
          conversationId: id,
          sessionAliases: residue.map((session) => session.alias),
        });
      }
      // Provisional controller rows have no verified release path: any
      // controller binding (already blocked above when a row exists, kept
      // here for the code) or controller session resolving to this Group —
      // exact, binding-resolved, live-topic-linked, or unattributable —
      // blocks the metadata-only delete like the verified teardown does.
      // Unattributable group-member owners block too: they prove nothing
      // about any root, so deleting this Group could strand them.
      this.assertNoUnattributableGroupMemberSessions(id);
      const controller = this.controllerResidueForGroup(id);
      if (controller.bindingIds.length > 0 || controller.sessionAliases.length > 0) {
        throw new BotError("group_has_runtime", `group "${id}" still has provisional controller runtime`, {
          conversationId: id,
          bindingIds: controller.bindingIds,
          sessionAliases: controller.sessionAliases,
        });
      }
      if (this.conversationWork?.hasDurableGroupWork?.(id)) {
        throw new BotError("group_has_work", `group "${id}" still has durable conversation work`, {
          conversationIds: [id],
        });
      }
      const next = structuredClone(this.state);
      delete next.conversations[id];
      await this.persist(next);
    });
  }

  getGroup(id: string): ConversationRecord {
    const record = this.state.conversations[id];
    if (!record || record.kind !== "group") {
      throw new BotError("group_not_found", `group "${id}" does not exist`);
    }
    return record;
  }

  /** PR7 separate Group listing. Never merged into the Direct-only
   *  conversations list: kinds stay on distinct surfaces. */
  listGroups(): ConversationRecord[] {
    return Object.values(this.state.conversations)
      .filter((conversation) => conversation.kind === "group")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private requireGroupTitle(title: string): string {
    if (typeof title !== "string" || !title.trim()) {
      throw new BotError("title_required", "group title must be a non-empty string");
    }
    const trimmed = title.trim();
    if (trimmed.length > NAME_MAX) {
      throw new BotError("title_too_long", `group title must be at most ${NAME_MAX} characters`);
    }
    return trimmed;
  }

  private optionalGroupDescription(description: string | null | undefined): string | undefined {
    if (description === undefined || description === null) {
      return undefined;
    }
    if (typeof description !== "string") {
      throw new BotError("description_required", "group description must be a string");
    }
    const trimmed = description.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > TEXT_MAX) {
      throw new BotError("description_too_long", `group description must be at most ${TEXT_MAX} characters`);
    }
    return trimmed;
  }

  private requireGroupMembership(botIds: string[]): string[] {
    if (!Array.isArray(botIds) || botIds.length < 2) {
      throw new BotError("group_membership_min", "group requires at least two member Bots");
    }
    if (new Set(botIds).size !== botIds.length) {
      throw new BotError("group_membership_duplicate", "group member Bots must be unique");
    }
    for (const botId of botIds) {
      if (typeof botId !== "string" || !botId) {
        throw new BotError("bot_not_found", "group member Bot id must be a non-empty string");
      }
      this.getBot(botId);
    }
    return [...botIds];
  }

  private requireGroupLead(leadBotId: string | null | undefined, membership: string[]): string | undefined {
    if (leadBotId === undefined || leadBotId === null) {
      return undefined;
    }
    if (typeof leadBotId !== "string" || !membership.includes(leadBotId)) {
      throw new BotError("group_lead_not_member", "group lead must belong to group membership");
    }
    return leadBotId;
  }

  private nextId(): string {
    const id = this.createId();
    return id.startsWith("bot_") ? id : createBotId(() => id);
  }

  private requireIdentity(input: Pick<CreateBotInput, "name" | "agent" | "workspace">): Pick<BotProfile, "name" | "agent" | "workspace"> {
    const name = input.name.trim();
    if (!name) {
      throw new BotError("name_required", "bot name must be a non-empty string");
    }
    if (name.length > NAME_MAX) {
      throw new BotError("name_too_long", `bot name must be at most ${NAME_MAX} characters`);
    }
    if (!this.config.agents[input.agent]) {
      throw new BotError("agent_not_registered", `agent "${input.agent}" is not registered`);
    }
    if (!this.config.workspaces[input.workspace]) {
      throw new BotError("workspace_not_registered", `workspace "${input.workspace}" is not registered`);
    }
    return { name, agent: input.agent, workspace: input.workspace };
  }
  /** PR6 seam: Group Topics resolve their ExecutionTarget workspace against
   *  the same registry Bot identity uses. No Bot is involved; the caller
   *  owns membership validation. */
  assertWorkspaceRegistered(workspace: string): void {
    if (typeof workspace !== "string" || !this.config.workspaces[workspace]) {
      throw new BotError("workspace_not_registered", `workspace "${workspace}" is not registered`);
    }
  }

  private requirePatchString(value: string | undefined, fallback: string, field: "name" | "agent" | "workspace"): string {
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "string") {
      throw new BotError(`${field}_required`, `bot ${field} must be a string`);
    }
    return value;
  }

  private optionalFields(input: CreateBotInput): Partial<Pick<BotProfile, "avatar" | "role" | "instructions" | "model" | "effort">> {
    return {
      ...(this.optionalString(input.avatar, "avatar", 512) ? { avatar: this.optionalString(input.avatar, "avatar", 512) } : {}),
      ...(this.optionalString(input.role, "role", 256) ? { role: this.optionalString(input.role, "role", 256) } : {}),
      ...(this.optionalString(input.instructions, "instructions") ? { instructions: this.optionalString(input.instructions, "instructions") } : {}),
      ...(this.optionalString(input.model, "model", 256) ? { model: this.optionalString(input.model, "model", 256) } : {}),
      ...(this.optionalString(input.effort, "effort", 64) ? { effort: this.optionalString(input.effort, "effort", 64) } : {}),
    };
  }

  private patchOptional(existing: BotProfile, patch: UpdateBotInput): Partial<BotProfile> {
    const next: Partial<BotProfile> = {};
    const apply = (field: "avatar" | "role" | "instructions" | "model" | "effort", max?: number) => {
      if (!(field in patch)) {
        return;
      }
      const value = patch[field];
      if (value === null || value === undefined) {
        next[field] = undefined;
        return;
      }
      next[field] = this.optionalString(value, field, max);
    };
    apply("avatar", 512);
    apply("role", 256);
    apply("instructions");
    apply("model", 256);
    apply("effort", 64);
    return {
      avatar: "avatar" in next ? next.avatar : existing.avatar,
      role: "role" in next ? next.role : existing.role,
      instructions: "instructions" in next ? next.instructions : existing.instructions,
      model: "model" in next ? next.model : existing.model,
      effort: "effort" in next ? next.effort : existing.effort,
    };
  }

  private optionalString(value: string | undefined, field: string, max = TEXT_MAX): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length > max) {
      throw new BotError(`${field}_too_long`, `bot ${field} must be at most ${max} characters`);
    }
    return trimmed;
  }

  private rejectUnsupportedCwd(input: object): void {
    if ("cwd" in input && (input as { cwd?: unknown }).cwd !== undefined) {
      throw new BotError("cwd_unsupported", "bot cwd is not supported until runtime migration exists");
    }
  }

  private hasMaterializedRuntime(botId: string): boolean {
    const refs = this.directRuntimeRefs(botId);
    return refs.bindingIds.length > 0 || refs.sessionAliases.length > 0
      || this.hasGroupMemberRuntime(botId);
  }

  private hasLockedRuntime(botId: string): boolean {
    const refs = this.directRuntimeRefs(botId);
    return refs.conversationIds.length > 0 || refs.bindingIds.length > 0 || refs.sessionAliases.length > 0
      || this.hasGroupMemberRuntime(botId);
  }

  /**
   * Exact group-member owned sessions participate in the agent identity lock:
   * a binding-less crash-window session (persisted, binding never published)
   * still pins the Bot's agent, so updateBot cannot change identity under it
   * and later recovery cannot silently adopt the old-Agent context.
   */
  private hasGroupMemberRuntime(botId: string): boolean {
    for (const session of Object.values(this.state.sessions)) {
      const owner = session.owner;
      if (owner?.kind !== "group-member") {
        continue;
      }
      if (owner.botId !== undefined && owner.botId !== botId) {
        continue;
      }
      if (owner.botId === undefined) {
        const bound = this.state.bot_runtime_bindings[owner.bindingId];
        if (!bound || bound.scope !== "group-member" || bound.botId !== botId) {
          continue;
        }
      }
      return true;
    }
    return Object.values(this.state.bot_runtime_bindings).some(
      (binding) => binding.scope === "group-member" && binding.botId === botId,
    );
  }
  /**
   * Provisional group-controller rows have no release path, so they pin
   * every root they resolve to. Mirrors the run-service controller fences
   * without importing the upper layer: BotService is the lower layer, and
   * these are pure state scans. A controller row is only valid against a
   * Group root; one resolving to a Bot's deterministic Direct root blocks
   * deleteBot, and one resolving to a Group blocks metadata-only
   * deleteGroup. Conversation-exact always fences; conversation-less owners
   * resolve through a live binding or a live topic row. Unattributable
   * owners (no conversation, no live binding, no live topic link) fail
   * every delete closed — deleting any root could strand them.
   */
  private controllerResidueForDirectRoot(botId: string): { bindingIds: string[]; sessionAliases: string[] } {
    const conversationId = createDirectConversationId(botId);
    const directTopicIds = new Set(
      Object.values(this.state.conversation_topics)
        .filter((topic) => topic.conversationId === conversationId)
        .map((topic) => topic.id),
    );
    const bindings = Object.values(this.state.bot_runtime_bindings).filter(
      (binding) => binding.scope === "group-controller"
        && (binding.conversationId === conversationId
          || (binding.topicId !== undefined && directTopicIds.has(binding.topicId))),
    );
    const sessions = Object.values(this.state.sessions).filter((session) => {
      const owner = session.owner;
      if (owner?.kind !== "group-controller") {
        return false;
      }
      if (owner.conversationId !== undefined) {
        return owner.conversationId === conversationId;
      }
      const bound = owner.bindingId !== undefined
        ? this.state.bot_runtime_bindings[owner.bindingId]
        : undefined;
      if (bound !== undefined) {
        return bound.conversationId === conversationId
          || (bound.topicId !== undefined && directTopicIds.has(bound.topicId));
      }
      return owner.topicId !== undefined && directTopicIds.has(owner.topicId);
    });
    const ambiguous = this.ambiguousControllerSessions();
    return {
      bindingIds: bindings.map((binding) => binding.id),
      sessionAliases: [...sessions.map((session) => session.alias), ...ambiguous.map((session) => session.alias)],
    };
  }

  private controllerResidueForGroup(groupId: string): { bindingIds: string[]; sessionAliases: string[] } {
    const bindings = Object.values(this.state.bot_runtime_bindings).filter(
      (binding) => binding.scope === "group-controller" && binding.conversationId === groupId,
    );
    const groupTopicIds = new Set(
      Object.values(this.state.conversation_topics)
        .filter((topic) => topic.conversationId === groupId)
        .map((topic) => topic.id),
    );
    const sessions = Object.values(this.state.sessions).filter((session) => {
      const owner = session.owner;
      if (owner?.kind !== "group-controller") {
        return false;
      }
      if (owner.conversationId !== undefined) {
        return owner.conversationId === groupId;
      }
      const bound = owner.bindingId !== undefined
        ? this.state.bot_runtime_bindings[owner.bindingId]
        : undefined;
      if (bound !== undefined) {
        return bound.conversationId === groupId;
      }
      return owner.topicId !== undefined && groupTopicIds.has(owner.topicId);
    });
    const ambiguous = this.ambiguousControllerSessions();
    return {
      bindingIds: bindings.map((binding) => binding.id),
      sessionAliases: [...sessions.map((session) => session.alias), ...ambiguous.map((session) => session.alias)],
    };
  }

  /**
   * Unattributable group-member owners prove nothing about any root (no
   * conversationId, no live binding, no live anything): deleting any Group
   * could strand them. Mirrors the run-service destructive-path gate; the
   * metadata-only delete must enforce the same rule as verified teardown.
   */
  private assertNoUnattributableGroupMemberSessions(groupId: string): void {
    const blocked = Object.entries(this.state.sessions).filter(([key, session]) => {
      const owner = session.owner;
      if (owner?.kind !== "group-member") {
        return false;
      }
      // Storage identity is the map key: a hidden owner whose record alias
      // disagrees with its key cannot be attributed to any root — the
      // disagreement itself is corruption. Block every Group delete on it
      // (mirrors the run-service key-identity fence); it proves nothing
      // about which Group owns it, so deleting any Group could strand it.
      if (key !== session.alias) {
        return true;
      }
      if (owner.conversationId !== undefined) {
        return false;
      }
      const bound = owner.bindingId !== undefined
        ? this.state.bot_runtime_bindings[owner.bindingId]
        : undefined;
      return bound === undefined;
    });
    if (blocked.length === 0) {
      return;
    }
    throw new BotError("group_has_runtime", `group "${groupId}" still has unattributable member sessions`, {
      conversationId: groupId,
      sessionAliases: blocked.map(([key]) => key),
    });
  }

  private ambiguousControllerSessions(): Array<{ alias: string }> {
    return Object.values(this.state.sessions).filter((session) => {
      const owner = session.owner;
      if (owner?.kind !== "group-controller") {
        return false;
      }
      if (owner.conversationId !== undefined) {
        return false;
      }
      const bound = owner.bindingId !== undefined
        ? this.state.bot_runtime_bindings[owner.bindingId]
        : undefined;
      if (bound !== undefined) {
        return false;
      }
      if (owner.topicId === undefined) {
        return true;
      }
      return this.state.conversation_topics[owner.topicId] === undefined;
    });
  }

  /**
   * Runtimes that consume the Bot workspace DEFAULT: direct sessions only.
   * Group Topics always carry an explicit executionTarget (create-time
   * required; legacy/missing target fails closed at materialize), so the Bot
   * default never applies to member sessions and changing it never rebuilds
   * them. Agent changes stay locked by ANY runtime (hasMaterializedRuntime);
   * workspace-default changes only by direct runtime.
   */
  private hasDefaultWorkspaceRuntime(botId: string): boolean {
    // Scope-narrow: only bot-direct bindings/sessions consume the Bot
    // workspace default. directRuntimeRefs.bindingIds also covers
    // group-member bindings (any non-controller scope), which must NOT lock
    // the default — their Topics own an explicit workspace.
    const hasDirectBinding = Object.values(this.state.bot_runtime_bindings).some(
      (binding) => binding.scope === "bot-direct" && binding.botId === botId,
    );
    if (hasDirectBinding) {
      return true;
    }
    const refs = this.directRuntimeRefs(botId);
    return refs.sessionAliases.length > 0;
  }

  private directRuntimeRefs(botId: string): {
    conversationIds: string[];
    bindingIds: string[];
    sessionAliases: string[];
  } {
    const conversationIds = Object.values(this.state.conversations)
      .filter((conversation) => conversation.kind === "bot" && conversation.botIds.includes(botId))
      .map((conversation) => conversation.id);
    const bindingIds = Object.values(this.state.bot_runtime_bindings)
      .filter((binding): binding is Extract<typeof binding, { botId: string }> => (
        binding.scope !== "group-controller" && binding.botId === botId
      ))
      .map((binding) => binding.id);
    const ownedBindingIds = new Set(bindingIds);
    ownedBindingIds.add(createDirectBindingId(botId));
    const sessionAliases = Object.values(this.state.sessions)
      // Conflicting ownership is still a runtime lock: never let delete/update
      // make the contradiction harder to recover from.
      .filter((session) => (
        classifyDirectBotSessionOwnership(
          session,
          botId,
          ownedBindingIds,
          createDirectConversationId(botId),
        ) !== "foreign"
      ))
      .map((session) => session.alias);
    return { conversationIds, bindingIds, sessionAliases };
  }

  private async persist(next: AppState): Promise<void> {
    if (typeof this.stateStore.saveNow === "function") {
      await this.stateStore.saveNow(next);
    } else {
      await this.stateStore.save(next);
    }
    replaceRuntimeState(this.state, next);
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    return await this.stateMutex.run(fn);
  }
}
