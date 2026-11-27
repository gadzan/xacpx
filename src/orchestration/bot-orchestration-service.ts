import { toDisplaySessionAlias } from "../channels/channel-scope";
import type {
  BotCreateInput,
  BotCreateResult,
  BotEnvironmentResult,
  BotSessionCreateInput,
  BotSessionCreateResult,
  BotSessionRenameInput,
} from "./orchestration-ipc";

/**
 * Milestone 1 bot-side orchestration for direct-execution RPCs
 * (`bot.environment`, `bot.session.create`, `bot.session.rename`, `bot.create`).
 *
 * Quotas are enforced here, at the service boundary:
 * - at most MAX_SESSIONS_CREATED_PER_EXECUTION ordinary sessions per execution
 * - at most MAX_BOTS_CREATED_PER_EXECUTION child bots per execution
 * - child-bot spawn depth never exceeds MAX_BOT_SPAWN_DEPTH (roots are depth 0)
 * - the instance never exceeds MAX_TOTAL_BOTS bots
 */
export const MAX_SESSIONS_CREATED_PER_EXECUTION = 8;
export const MAX_BOTS_CREATED_PER_EXECUTION = 4;
export const MAX_BOT_SPAWN_DEPTH = 3;
export const MAX_TOTAL_BOTS = 64;

export interface BotOrchestrationRequestContext {
  requestingBotId: string;
  topicId?: string;
  conversationId?: string;
  executionToken: string;
}

export interface BotOrchestrationDeps {
  getWorkspaces: () => Array<{
    name: string;
    cwd: string;
    description?: string;
  }>;
  getAgents: () => Array<{
    name: string;
    driver: string;
    model?: string;
  }>;
  /** Channel scope bot-dispatched sessions are created in ("relay" normally,
   *  "web" when the relay plugin is not loaded). Internal aliases are
   *  `${scope}:${slug}`. */
  sessionAliasScope: () => string;
  existingAliases: () => string[];
  isHiddenSession: (alias: string) => boolean;
  getSession: (alias: string) => { alias: string; archived?: boolean } | undefined;
  createLogicalSession: (input: {
    agent: string;
    workspace: string;
    /** Bare slug, no channel prefix — the composition scopes it. */
    slug: string;
    displayName?: string;
    model?: string;
  }) => Promise<{ alias: string; displayAlias: string }>;
  renameLogicalSession: (input: {
    alias: string;
    displayName: string;
  }) => Promise<{ alias: string; displayName: string }>;
  appendDispatchedSystemMessage: (input: {
    botId: string;
    topicId: string;
    message: string;
    conversationId?: string;
    dispatchedSession: {
      sessionAlias: string;
      displayName?: string;
      agent: string;
      workspace: string;
      taskPreview?: string;
    };
  }) => Promise<void>;
  dispatchTaskToSession: (input: {
    fromBotId: string;
    alias: string;
    task: string;
  }) => Promise<void>;
  getBot: (id: string) => { spawnDepth?: number } | undefined;
  countBots: () => number;
  createBot: (input: {
    name: string;
    agent: string;
    workspace?: string;
    role?: string;
    instructions?: string;
    model?: string;
    effort?: string;
    createdByBotId?: string;
    spawnDepth?: number;
  }) => Promise<{ id?: string; botId?: string; name: string }>;
  sendToBotPeer: (input: {
    fromBotId: string;
    toBotId: string;
    task: string;
    /** Current direct-execution token — the Bot→Bot send is authorized as the
     *  requesting Bot's own execution so the child sees from-kind="bot". */
    executionToken: string;
  }) => Promise<void>;
  getRequestContext: (
    params?: Record<string, unknown>,
  ) => BotOrchestrationRequestContext;
}

function requireNonEmpty(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a nonempty string`);
  }
  if (value.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  if (value.includes("\0")) {
    throw new Error(`${field} must not contain NUL`);
  }
  return value;
}

function optionalBounded(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max || value.includes("\0")) {
    throw new Error(`${field} must be a string of at most ${max} characters`);
  }
  return value;
}

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug : "session";
}

export class BotOrchestrationService {
  private readonly sessionCounts = new Map<string, number>();
  private readonly botCounts = new Map<string, number>();

  constructor(private readonly deps: BotOrchestrationDeps) {}

  async environment(
    _input?: Record<string, unknown>,
  ): Promise<BotEnvironmentResult> {
    return {
      workspaces: this.deps.getWorkspaces(),
      agents: this.deps.getAgents(),
    };
  }

  async createSession(
    input: BotSessionCreateInput & Record<string, unknown>,
  ): Promise<BotSessionCreateResult> {
    const ctx = this.deps.getRequestContext(input);
    const spent = this.sessionCounts.get(ctx.executionToken) ?? 0;
    if (spent >= MAX_SESSIONS_CREATED_PER_EXECUTION) {
      throw new Error(
        `session quota exceeded: at most ${MAX_SESSIONS_CREATED_PER_EXECUTION} sessions per execution`,
      );
    }
    const agent = requireNonEmpty(input.agent, "agent", 128);
    const workspace = requireNonEmpty(input.workspace, "workspace", 256);
    const name = optionalBounded(input.name, "name", 256);
    const requestedAlias = optionalBounded(input.alias, "alias", 256);
    const model = optionalBounded(input.model, "model", 256);
    const task =
      input.task === undefined
        ? undefined
        : requireNonEmpty(input.task, "task", 16000);
    const requested = requestedAlias ?? name ?? "session";
    if (requested.startsWith("brt_")) {
      throw new Error("bot-created sessions must not use the brt_ prefix");
    }
    const scope = this.deps.sessionAliasScope();
    const slugBase = slugify(requested);
    const existing = this.deps.existingAliases();
    const takenInternal = new Set(existing);
    const takenDisplay = new Set(existing.map((a) => toDisplaySessionAlias(a)));
    let slug = slugBase;
    for (let suffix = 2; takenInternal.has(`${scope}:${slug}`) || takenDisplay.has(slug); suffix += 1) {
      slug = `${slugBase}-${suffix}`;
    }
    const internalAlias = `${scope}:${slug}`;
    if (internalAlias.startsWith("brt_")) {
      throw new Error("bot-created sessions must not use the brt_ prefix");
    }
    const created = await this.deps.createLogicalSession({
      agent,
      workspace,
      slug,
      ...(name ? { displayName: name } : {}),
      ...(model ? { model } : {}),
    });
    this.sessionCounts.set(ctx.executionToken, spent + 1);
    const taskPreview = task ? task.slice(0, 500) : undefined;
    const displayName = created.displayAlias;
    await this.deps.appendDispatchedSystemMessage({
      botId: ctx.requestingBotId,
      topicId: ctx.topicId ?? "",
      message: `Dispatched session ${displayName}${name ? ` ("${name}")` : ""}${task ? " with task" : ""}.`,
      ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      dispatchedSession: {
        // Display alias: the Web indexes ordinary sessions by display alias.
        sessionAlias: displayName,
        ...(name ? { displayName: name } : {}),
        agent,
        workspace,
        ...(taskPreview ? { taskPreview } : {}),
      },
    });
    if (task) {
      await this.deps.dispatchTaskToSession({
        fromBotId: ctx.requestingBotId,
        alias: created.alias,
        task,
      });
    }
    return {
      alias: displayName,
      handle: created.alias,
      ...(name ? { displayName: name } : {}),
    };
  }

  async renameSession(
    input: BotSessionRenameInput & Record<string, unknown>,
  ): Promise<{ alias: string; displayName: string }> {
    const requested = requireNonEmpty(input.alias, "alias", 256);
    const displayName = requireNonEmpty(input.displayName, "displayName", 256);
    if (requested.startsWith("brt_")) {
      throw new Error("hidden product sessions cannot be renamed");
    }
    // Accept display or internal aliases; hidden/archived checks run on the
    // resolved internal record. Bare `brt_*` input is rejected above, and an
    // internal `brt_*`/hidden record is rejected below — no owner metadata
    // is ever trusted from the caller's string alone.
    const existing = this.deps.existingAliases();
    const internal = existing.includes(requested)
      ? requested
      : existing.find((a) => toDisplaySessionAlias(a) === requested);
    if (!internal) {
      throw new Error("session not found");
    }
    if (internal.startsWith("brt_") || this.deps.isHiddenSession(internal)) {
      throw new Error("hidden product sessions cannot be renamed");
    }
    const record = this.deps.getSession(internal);
    if (record?.archived === true) {
      throw new Error("archived sessions cannot be renamed");
    }
    return await this.deps.renameLogicalSession({ alias: internal, displayName });
  }

  async createBot(
    input: BotCreateInput & Record<string, unknown>,
  ): Promise<BotCreateResult> {
    const ctx = this.deps.getRequestContext(input);
    const spent = this.botCounts.get(ctx.executionToken) ?? 0;
    if (spent >= MAX_BOTS_CREATED_PER_EXECUTION) {
      throw new Error(
        `bot quota exceeded: at most ${MAX_BOTS_CREATED_PER_EXECUTION} bots per execution`,
      );
    }
    const name = requireNonEmpty(input.name, "name", 256);
    const agent = requireNonEmpty(input.agent, "agent", 128);
    const workspace = optionalBounded(input.workspace, "workspace", 256);
    const role = optionalBounded(input.role, "role", 256);
    const instructions = optionalBounded(input.instructions, "instructions", 16000);
    const model = optionalBounded(input.model, "model", 256);
    const effort = optionalBounded(input.effort, "effort", 64);
    const task =
      input.task === undefined
        ? undefined
        : requireNonEmpty(input.task, "task", 16000);
    if (this.deps.countBots() >= MAX_TOTAL_BOTS) {
      throw new Error(
        `bot limit exceeded: at most ${MAX_TOTAL_BOTS} bots per instance`,
      );
    }
    const requester = this.deps.getBot(ctx.requestingBotId);
    const spawnDepth = (requester?.spawnDepth ?? 0) + 1;
    if (spawnDepth > MAX_BOT_SPAWN_DEPTH) {
      throw new Error(
        `bot spawn depth exceeded: at most ${MAX_BOT_SPAWN_DEPTH}`,
      );
    }
    const created = await this.deps.createBot({
      name,
      agent,
      ...(workspace ? { workspace } : {}),
      ...(role ? { role } : {}),
      ...(instructions ? { instructions } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      createdByBotId: ctx.requestingBotId,
      spawnDepth,
    });
    this.botCounts.set(ctx.executionToken, spent + 1);
    const botId = created.botId ?? created.id;
    if (!botId) {
      throw new Error("bot creation did not return an id");
    }
    if (task) {
      await this.deps.sendToBotPeer({
        fromBotId: ctx.requestingBotId,
        toBotId: botId,
        task,
        executionToken: ctx.executionToken,
      });
    }
    return { botId, name: created.name };
  }
}
