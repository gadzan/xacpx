import type { AppConfig } from "../config/types";
import { createBotId, createDirectBindingId, createDirectConversationId } from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { StateStore } from "../state/state-store";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { AppState, LogicalSession } from "../state/types";
import { BotError } from "./bot-error";
import { BotLifecycleGate } from "./bot-lifecycle-gate";
import type { BotProfile } from "./bot-types";

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

export type BotLifecycleMutation = "update" | "delete";

/** True when a LogicalSession is owned by this Direct Bot, including PR2
 *  bindingId-only records that predate `owner.botId`. An explicit botId is
 *  authoritative: legacy metadata must never override a conflicting owner. */
export function sessionOwnedByDirectBot(
  session: Pick<LogicalSession, "owner">,
  botId: string,
  ownedBindingIds: ReadonlySet<string>,
): boolean {
  const owner = session.owner;
  if (owner?.kind !== "bot-direct") {
    return false;
  }
  if (owner.botId !== undefined) {
    return owner.botId === botId;
  }
  if (ownedBindingIds.has(owner.bindingId)) {
    return true;
  }
  return owner.bindingId === createDirectBindingId(botId);
}

export interface BotConversationWork {
  hasDurableBotWork(botId: string): boolean;
}

export interface BotServiceOptions {
  now?: () => Date;
  createId?: () => string;
  stateMutex?: AsyncMutex;
  lifecycleGate?: BotLifecycleGate;
  beforeLifecycleMutation?: (input: { botId: string; op: BotLifecycleMutation }) => Promise<void>;
  conversationWork?: BotConversationWork;
}

type SessionWriter = Pick<StateStore, "save"> & { saveNow?: (state: AppState) => Promise<void> };

export class BotService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly stateMutex: AsyncMutex;
  private readonly lifecycleGate: BotLifecycleGate;
  private readonly beforeLifecycleMutation?: (input: { botId: string; op: BotLifecycleMutation }) => Promise<void>;
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
    this.conversationWork = options?.conversationWork;
  }

  /** Shared with BotRuntimeManager: one botId, one exclusive lifecycle. */
  runLifecycle<T>(botId: string, critical: () => Promise<T>): Promise<T> {
    return this.lifecycleGate.run(botId, critical);
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
        if (patch.agent !== undefined && patch.agent !== existing.agent && this.hasLockedRuntime(id)) {
          throw new BotError("runtime_identity_locked", `bot "${id}" agent cannot change while a runtime exists`);
        }
        if (patch.workspace !== undefined && patch.workspace !== existing.workspace && this.hasLockedRuntime(id)) {
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

  private hasLockedRuntime(botId: string): boolean {
    const refs = this.directRuntimeRefs(botId);
    return refs.conversationIds.length > 0 || refs.bindingIds.length > 0 || refs.sessionAliases.length > 0;
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
      .filter((session) => sessionOwnedByDirectBot(session, botId, ownedBindingIds))
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
