import type { AppConfig } from "../config/types";
import { normalizeWorkspacePath } from "../commands/workspace-path";
import { createBotId } from "../domain/ids";
import { AsyncMutex } from "../orchestration/async-mutex";
import type { StateStore } from "../state/state-store";
import type { AppState } from "../state/types";
import { BotError } from "./bot-error";
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
  cwd?: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
}

export type UpdateBotInput = {
  [K in keyof CreateBotInput]?: CreateBotInput[K] | null;
};

export interface BotServiceOptions {
  now?: () => Date;
  createId?: () => string;
  stateMutex?: AsyncMutex;
}

export class BotService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly stateMutex: AsyncMutex;

  constructor(
    private readonly config: Pick<AppConfig, "agents" | "workspaces">,
    private readonly state: AppState,
    private readonly stateStore: Pick<StateStore, "save">,
    options?: BotServiceOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.createId = options?.createId ?? (() => createBotId());
    this.stateMutex = options?.stateMutex ?? new AsyncMutex();
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
    return await this.mutate(async () => {
      const id = this.nextId();
      const timestamp = this.now().toISOString();
      const bot: BotProfile = {
        id,
        ...this.requireIdentity(input),
        ...this.optionalFields(input),
        enabled: input.enabled ?? true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state.bots[id] = bot;
      await this.stateStore.save(this.state);
      return bot;
    });
  }

  async updateBot(id: string, patch: UpdateBotInput): Promise<BotProfile> {
    return await this.mutate(async () => {
      const existing = this.getBot(id);
      const mergedName = patch.name === undefined ? existing.name : String(patch.name);
      const mergedAgent = patch.agent === undefined ? existing.agent : String(patch.agent);
      const mergedWorkspace = patch.workspace === undefined ? existing.workspace : String(patch.workspace);
      const identity = this.requireIdentity({
        name: mergedName,
        agent: mergedAgent,
        workspace: mergedWorkspace,
      });
      const next: BotProfile = {
        ...existing,
        ...identity,
        ...this.patchOptional(existing, patch),
        enabled: patch.enabled === undefined || patch.enabled === null ? existing.enabled : patch.enabled,
        updatedAt: this.now().toISOString(),
      };
      this.state.bots[id] = next;
      await this.stateStore.save(this.state);
      return next;
    });
  }

  async deleteBot(id: string): Promise<void> {
    await this.mutate(async () => {
      this.getBot(id);
      const groups = Object.values(this.state.conversations).filter(
        (conversation) => conversation.kind === "group" && conversation.botIds.includes(id),
      );
      if (groups.length > 0) {
        throw new BotError("bot_in_group", `bot "${id}" is referenced by groups`, {
          conversationIds: groups.map((group) => group.id),
        });
      }
      delete this.state.bots[id];
      await this.stateStore.save(this.state);
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

  private optionalFields(input: CreateBotInput): Partial<Pick<BotProfile, "avatar" | "role" | "instructions" | "cwd" | "model" | "effort">> {
    return {
      ...(this.optionalString(input.avatar, "avatar", 512) ? { avatar: this.optionalString(input.avatar, "avatar", 512) } : {}),
      ...(this.optionalString(input.role, "role", 256) ? { role: this.optionalString(input.role, "role", 256) } : {}),
      ...(this.optionalString(input.instructions, "instructions") ? { instructions: this.optionalString(input.instructions, "instructions") } : {}),
      ...(this.optionalCwd(input.cwd) ? { cwd: this.optionalCwd(input.cwd) } : {}),
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
      const normalized = this.optionalString(value, field, max);
      next[field] = normalized;
    };
    apply("avatar", 512);
    apply("role", 256);
    apply("instructions");
    apply("model", 256);
    apply("effort", 64);
    if ("cwd" in patch) {
      next.cwd = patch.cwd === null || patch.cwd === undefined ? undefined : this.optionalCwd(patch.cwd);
    }
    return {
      avatar: "avatar" in next ? next.avatar : existing.avatar,
      role: "role" in next ? next.role : existing.role,
      instructions: "instructions" in next ? next.instructions : existing.instructions,
      cwd: "cwd" in next ? next.cwd : existing.cwd,
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

  private optionalCwd(value: string | undefined): string | undefined {
    const trimmed = this.optionalString(value, "cwd", 4096);
    return trimmed ? normalizeWorkspacePath(trimmed) : undefined;
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    return await this.stateMutex.run(fn);
  }
}
