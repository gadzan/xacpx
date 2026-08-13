import { randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { isLegacyCodexCommand, resolveAgentCommand, resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import {
  classifyRecordedPreinstalledAdapterCommand,
  isManagedAdapterCommand,
} from "../adapters/adapter-catalog";
import { isDefaultHermesCommand, isHermesShimCommand } from "../adapters/hermes-shim";
import { isDerivedAgentArgv, renderAgentArgvIdentity, type AgentLaunchSpec } from "../config/agent-launch";
import { resolveConfigPathForCurrentEnv } from "../config/config-path";
import type { AgentConfig, AppConfig, WechatReplyMode } from "../config/types";
import { t } from "../i18n/index.js";
import { AsyncMutex } from "../orchestration/async-mutex";
import { sameCoordinatorSession, stableCoordinatorSession } from "../orchestration/coordinator-identity";
import type { StateStore } from "../state/state-store";
import { replaceRuntimeState } from "../state/replace-runtime-state";
import type { AppState, BackgroundResult, ChatContextState, LogicalSession } from "../state/types";
import type { SessionResourceLifecyclePublishInput } from "./session-resource-catalog";
import type { AgentSession, ResolvedSession } from "../transport/types";
import {
  buildDefaultTransportSession,
  getChannelIdFromChatKey,
  isSessionAliasVisibleInChannel,
  resolveSessionAliasForInput,
  toDisplaySessionAlias,
} from "../channels/channel-scope";

interface SessionListItem {
  alias: string;
  internalAlias: string;
  agent: string;
  workspace: string;
  isCurrent: boolean;
}

export interface SessionSwitchResult {
  alias: string;
  agent: string;
  workspace: string;
  previousAlias?: string;
}

export type FuzzyAliasResult =
  | { kind: "match"; alias: string }
  | { kind: "ambiguous"; candidates: Array<{ alias: string; agent: string; workspace: string }> }
  | { kind: "none" };

interface NativeSessionAttachmentInput {
  alias: string;
  agent: string;
  workspace: string;
  transportSession: string;
  transportAgentCommand?: string;
  /** Positional acpx agent for structured launches (overlay alias or driver). */
  transportAcpxAgent?: string;
  transportAgentArgv?: string[];
  agentSessionId: string;
  title?: string | null;
  updatedAt?: string;
}

interface NativeSessionListInput {
  agent: string;
  workspace?: string;
  cwd: string;
  sessions: AgentSession[];
  nextCursor?: string | null;
}

interface NativeSessionListResult {
  agent: string;
  workspace?: string;
  cwd: string;
  sessions: AgentSession[];
  nextCursor?: string | null;
}

interface SessionServiceOptions {
  stateMutex?: AsyncMutex;
  now?: () => number;
  /** Injectable for tests; defaults to the real platform. */
  platform?: NodeJS.Platform;
  /** Trusted root for classifying persisted preinstalled adapter identities. */
  runtimeRoot?: string;
}

export interface SessionStateWriter extends Pick<StateStore, "save"> {
  saveNow(state: AppState): Promise<void>;
}

export interface SessionLockedTransaction {
  setTransportAgentCommandDurably(alias: string, transportAgentCommand: string | undefined): Promise<void>;
}

export class SessionService {
  private readonly stateMutex: AsyncMutex;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly runtimeRoot: string;
  private readonly pendingSessionAliasOperations = new Set<string>();
  private lifecyclePublisher: ((input: SessionResourceLifecyclePublishInput) => void) | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly stateStore: SessionStateWriter,
    private readonly state: AppState,
    options: SessionServiceOptions = {},
  ) {
    this.stateMutex = options.stateMutex ?? new AsyncMutex();
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.runtimeRoot = options.runtimeRoot ?? dirname(resolveConfigPathForCurrentEnv());
  }

  async createSession(alias: string, agent: string, workspace: string): Promise<ResolvedSession> {
    return await this.createLogicalSession(alias, agent, workspace, `${workspace}:${alias}`);
  }

  /**
   * All currently-known logical sessions resolved to transport sessions, deduped by
   * the composite identity acpx keys its session records on (agent + agent command +
   * cwd + transport session name). Two aliases sharing a transport-session *name*
   * but differing in agent/cwd (possible via /session attach) resolve to different
   * acpx records with their own warm queue owners, so both must survive. Sessions
   * whose agent or workspace is no longer registered are skipped (toResolvedSession
   * would throw). Used by startup/shutdown cleanup to reap warm acpx queue owners;
   * never throws.
   */
  listAllResolvedSessions(): ResolvedSession[] {
    const seen = new Set<string>();
    const resolved: ResolvedSession[] = [];
    for (const session of Object.values(this.state.sessions)) {
      let candidate: ResolvedSession;
      try {
        candidate = this.toResolvedSession(session);
      } catch {
        // Agent/workspace de-registered since this session was created — skip it.
        continue;
      }
      // Same composite key as reapQueueOwners/defaultResolveRecordId; JSON.stringify
      // so cwd values with arbitrary characters cannot collide.
      const key = JSON.stringify([
        candidate.agent,
        candidate.agentCommand ?? null,
        candidate.cwd,
        candidate.transportSession,
      ]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push(candidate);
    }
    return resolved;
  }

  resolveSession(alias: string, agent: string, workspace: string, transportSession: string): ResolvedSession {
    this.validateSession(alias, agent, workspace);
    const existing = this.state.sessions[alias];
    // A cached transport agent command is only valid for the same agent; never
    // reuse it across agents (e.g. alias recreated with --agent claude after codex).
    const sameAgentExisting = existing && existing.agent === agent ? existing : undefined;
    return this.toResolvedSession({
      alias,
      agent,
      workspace,
      transport_session: transportSession,
      // Transient (never persisted by this method): carry the live session's id
      // when one exists; the placeholder is discarded on the next real create.
      logical_session_id: existing?.logical_session_id ?? randomUUID(),
      transport_agent_command: sameAgentExisting?.transport_agent_command,
      transport_acpx_agent: sameAgentExisting?.transport_acpx_agent,
      transport_agent_argv: sameAgentExisting?.transport_agent_argv,
      // Carry the same-agent model so a recreated session is ensured under the
      // same model that gets persisted (keeps acpx and state in agreement).
      model: sameAgentExisting?.model,
      effort: sameAgentExisting?.effort,
      created_at: existing?.created_at ?? new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    });
  }

  async attachSession(
    alias: string,
    agent: string,
    workspace: string,
    transportSession: string,
    transportAgentCommand?: string,
    transportAcpxAgent?: string,
    transportAgentArgv?: string[],
  ): Promise<ResolvedSession> {
    return await this.createLogicalSession(
      alias,
      agent,
      workspace,
      transportSession,
      transportAgentCommand,
      undefined,
      transportAcpxAgent,
      transportAgentArgv,
    );
  }

  async attachNativeSession(input: NativeSessionAttachmentInput): Promise<ResolvedSession> {
    return await this.createLogicalSession(
      input.alias,
      input.agent,
      input.workspace,
      input.transportSession,
      input.transportAgentCommand,
      {
        source: "agent-side",
        agentSessionId: input.agentSessionId,
        title: input.title,
        updatedAt: input.updatedAt,
      },
      input.transportAcpxAgent,
      input.transportAgentArgv,
    );
  }

  async getSession(alias: string): Promise<ResolvedSession | null> {
    const session = this.state.sessions[alias];
    if (!session) {
      return null;
    }

    return this.toResolvedSession(session);
  }

  /**
   * Synchronously resolve a session by its internal alias (as stored in state).
   * Returns null if the alias is unknown or if the referenced agent/workspace is
   * no longer registered (i.e. toResolvedSession would throw).
   *
   * Used by handlePrompt to honour a `boundSessionAlias` captured at dispatch
   * time without requiring an async state mutation.
   */
  getResolvedSessionByInternalAlias(alias: string): ResolvedSession | null {
    const session = this.state.sessions[alias];
    if (!session) {
      return null;
    }
    try {
      return this.toResolvedSession(session);
    } catch {
      return null;
    }
  }

  // Read-only peek at the chat's current internal session alias. Unlike
  // getCurrentSession it does NOT touch last_used_at or persist, so it is safe to
  // call on the hot dispatch path for every inbound message.
  peekCurrentSessionAlias(chatKey: string): string | undefined {
    return this.state.chat_contexts[chatKey]?.current_session;
  }

  async getPreferredSessionForTransport(transportSession: string): Promise<ResolvedSession | null> {
    const target = stableCoordinatorSession(transportSession);
    const matches = Object.values(this.state.sessions)
      .filter((session) => stableCoordinatorSession(session.transport_session) === target)
      .sort((left, right) => right.last_used_at.localeCompare(left.last_used_at));

    const expectedAlias = target.split(":").at(-1);
    const expectedWorkspace = target.split(":")[0];
    const preferred =
      matches.find(
        (session) => session.alias === expectedAlias && session.workspace === expectedWorkspace,
      ) ?? matches[0];
    return preferred ? this.toResolvedSession(preferred) : null;
  }

  async findAttachedNativeSession(
    chatKey: string,
    agent: string,
    agentSessionId: string,
  ): Promise<ResolvedSession | null> {
    const channelId = getChannelIdFromChatKey(chatKey);
    for (const session of Object.values(this.state.sessions)) {
      if (session.source !== "agent-side") {
        continue;
      }
      if (session.agent !== agent || session.agent_session_id !== agentSessionId) {
        continue;
      }
      if (!isSessionAliasVisibleInChannel(session.alias, channelId)) {
        continue;
      }
      return this.toResolvedSession(session);
    }
    return null;
  }

  async useSession(chatKey: string, alias: string): Promise<SessionSwitchResult> {
    return await this.mutate(async () => {
      const channelId = getChannelIdFromChatKey(chatKey);
      const internalAlias = resolveSessionAliasForInput(channelId, alias, Object.keys(this.state.sessions));
      const session = this.state.sessions[internalAlias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }

      // Automatic restore is a durability-gated lifecycle transition: apply the
      // whole mutation copy-on-write, publish it only after saveNow succeeds,
      // then emit exactly one `restored` event. A plain switch (nothing to
      // restore) keeps the cheap debounced in-place persist and emits nothing.
      if (session.archived) {
        const nextState = structuredClone(this.state);
        const result = this.applyUseSession(nextState, chatKey, internalAlias);
        await this.commitLifecycleTransition(nextState);
        this.publishLifecycleEvent("restored", nextState.sessions[internalAlias]!);
        return result;
      }

      const result = this.applyUseSession(this.state, chatKey, internalAlias);
      await this.persist();
      return result;
    });
  }

  /** Apply the use-session mutation (switch, plus restore when archived). */
  private applyUseSession(state: AppState, chatKey: string, internalAlias: string): SessionSwitchResult {
    const session = state.sessions[internalAlias]!;
    const prevCtx = state.chat_contexts[chatKey];
    const previousCurrent = prevCtx?.current_session;
    const carriedPrevious =
      previousCurrent && previousCurrent !== internalAlias ? previousCurrent : prevCtx?.previous_session;

    session.last_used_at = new Date().toISOString();
    // Sending a message to (or selecting) an archived session restores it.
    if (session.archived) {
      delete session.archived;
      delete session.archived_at;
    }
    // Spread the previous context so unread background_results (and any other
    // per-chat state) survive the switch; only current/previous change.
    const nextCtx: ChatContextState = { ...prevCtx, current_session: internalAlias };
    if (carriedPrevious) {
      nextCtx.previous_session = carriedPrevious;
    } else {
      delete nextCtx.previous_session;
    }
    state.chat_contexts[chatKey] = nextCtx;

    return {
      alias: toDisplaySessionAlias(session.alias),
      agent: session.agent,
      workspace: session.workspace,
      previousAlias: carriedPrevious ? toDisplaySessionAlias(carriedPrevious) : undefined,
    };
  }

  async usePreviousSession(chatKey: string): Promise<SessionSwitchResult | null> {
    return await this.mutate(async () => {
      const ctx = this.state.chat_contexts[chatKey];
      const prevInternal = ctx?.previous_session;
      if (!prevInternal) {
        return null;
      }
      const prevSession = this.state.sessions[prevInternal];
      if (!prevSession) {
        if (ctx) {
          delete ctx.previous_session;
          await this.persist();
        }
        return null;
      }

      const currentInternal = ctx?.current_session;
      prevSession.last_used_at = new Date().toISOString();
      // Preserve background_results and other per-chat state on toggle.
      const nextCtx: ChatContextState = { ...ctx, current_session: prevInternal };
      if (currentInternal && currentInternal !== prevInternal) {
        nextCtx.previous_session = currentInternal;
      } else {
        delete nextCtx.previous_session;
      }
      this.state.chat_contexts[chatKey] = nextCtx;
      await this.persist();

      return {
        alias: toDisplaySessionAlias(prevSession.alias),
        agent: prevSession.agent,
        workspace: prevSession.workspace,
        previousAlias:
          currentInternal && currentInternal !== prevInternal ? toDisplaySessionAlias(currentInternal) : undefined,
      };
    });
  }

  async setBackgroundResult(chatKey: string, alias: string, result: BackgroundResult): Promise<void> {
    await this.mutate(async () => {
      const ctx = this.state.chat_contexts[chatKey] ?? { current_session: "" };
      const results = { ...(ctx.background_results ?? {}), [alias]: result };
      this.state.chat_contexts[chatKey] = { ...ctx, background_results: results };
      await this.persist();
    });
  }

  async takeBackgroundResult(chatKey: string, alias: string): Promise<BackgroundResult | null> {
    return await this.mutate(async () => {
      const ctx = this.state.chat_contexts[chatKey];
      const found = ctx?.background_results?.[alias];
      if (!ctx || !found) return null;
      const remaining = { ...ctx.background_results };
      delete remaining[alias];
      if (Object.keys(remaining).length > 0) {
        this.state.chat_contexts[chatKey] = { ...ctx, background_results: remaining };
      } else {
        const { background_results: _omit, ...rest } = ctx;
        this.state.chat_contexts[chatKey] = rest;
      }
      await this.persist();
      return found;
    });
  }

  // Read-only; no persistence.
  listBackgroundResultAliases(chatKey: string): string[] {
    const results = this.state.chat_contexts[chatKey]?.background_results;
    return results ? Object.keys(results) : [];
  }

  resolveFuzzyAlias(chatKey: string, fragment: string): FuzzyAliasResult {
    const channelId = getChannelIdFromChatKey(chatKey);
    const frag = fragment.trim();
    const items = Object.values(this.state.sessions)
      .filter((session) => isSessionAliasVisibleInChannel(session.alias, channelId))
      .map((session) => ({
        display: toDisplaySessionAlias(session.alias),
        agent: session.agent,
        workspace: session.workspace,
      }));

    const toCandidate = (item: { display: string; agent: string; workspace: string }) => ({
      alias: item.display,
      agent: item.agent,
      workspace: item.workspace,
    });

    const exact = items.find((item) => item.display === frag);
    if (exact) {
      return { kind: "match", alias: exact.display };
    }

    const prefix = items.filter((item) => item.display.startsWith(frag));
    if (prefix.length === 1) {
      return { kind: "match", alias: prefix[0]!.display };
    }
    if (prefix.length > 1) {
      return { kind: "ambiguous", candidates: prefix.map(toCandidate) };
    }

    const substring = items.filter((item) => item.display.includes(frag));
    if (substring.length === 1) {
      return { kind: "match", alias: substring[0]!.display };
    }
    if (substring.length > 1) {
      return { kind: "ambiguous", candidates: substring.map(toCandidate) };
    }

    return { kind: "none" };
  }

  async resolveAliasForChat(chatKey: string, displayAlias: string): Promise<string> {
    const channelId = getChannelIdFromChatKey(chatKey);
    const candidate = resolveSessionAliasForInput(channelId, displayAlias, Object.keys(this.state.sessions));
    return candidate;
  }

  buildDefaultTransportSessionForChat(chatKey: string, displayAlias: string): string {
    return buildDefaultTransportSession(getChannelIdFromChatKey(chatKey), displayAlias);
  }

  /**
   * Claim an alias before any transport side effects begin. The claim is synchronous,
   * so concurrent create entry points cannot both pass an existence check and orphan
   * one of two newly-created transport sessions.
   */
  tryReserveNewSessionAlias(alias: string): (() => void) | null {
    if (this.state.sessions[alias]) {
      return null;
    }
    return this.tryReserveSessionAliasOperation(alias);
  }

  /** Exclusively claim any lifecycle operation that can replace an alias binding. */
  tryReserveSessionAliasOperation(alias: string): (() => void) | null {
    if (this.pendingSessionAliasOperations.has(alias)) {
      return null;
    }
    this.pendingSessionAliasOperations.add(alias);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingSessionAliasOperations.delete(alias);
    };
  }

  /**
   * Derive a free internal alias for a new session. When `desiredAlias` is already
   * taken (by an active OR archived session), append `-2`, `-3`, … until a free
   * slot is found.
   *
   * The alias may carry a channel prefix (`relay:demo`, `weixin:chat123/demo`); the
   * numeric suffix is always appended to the last path segment after the rightmost
   * `:` so prefix semantics are preserved (e.g. `relay:demo-2`, never `relay-2:demo`).
   */
  deriveFreeAlias(desiredAlias: string): string {
    const taken = Object.keys(this.state.sessions);
    const takenSet = new Set(taken);
    if (!takenSet.has(desiredAlias)) return desiredAlias;
    const sep = desiredAlias.lastIndexOf(":");
    const prefix = sep >= 0 ? desiredAlias.slice(0, sep + 1) : "";
    const base = sep >= 0 ? desiredAlias.slice(sep + 1) : desiredAlias;
    // If the base already carries a numeric suffix (e.g. "demo-2"), start
    // incrementing from that suffix instead of stacking a new one ("demo-2-2").
    const suffixMatch = /-(\d+)$/.exec(base);
    let startN = 2;
    let stem = base;
    if (suffixMatch) {
      startN = Number(suffixMatch[1]) + 1;
      stem = base.slice(0, -suffixMatch[0].length);
    }
    for (let n = startN; n <= 9999; n += 1) {
      const candidate = `${prefix}${stem}-${n}`;
      if (!takenSet.has(candidate)) return candidate;
    }
    // Extremely defensive fallback — 9999 collisions would require an absurd number
    // of sessions sharing the same base alias.
    throw new Error(`could not derive a free alias for "${desiredAlias}" after 9999 attempts`);
  }

  /**
   * Convenience: atomically derive a free alias (see `deriveFreeAlias`) AND
   * reserve it via `tryReserveNewSessionAlias`. If the derived alias loses the
   * race between the derive step and the reserve step (extremely rare because
   * callers typically run this while holding the state mutex), retry up to a
   * small, bounded number of times.
   *
   * Returns the chosen alias together with the reservation release callback, or
   * `null` if no reservation could be obtained.
   */
  tryReserveFreeSessionAlias(desiredAlias: string): { alias: string; release: () => void } | null {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const alias = this.deriveFreeAlias(desiredAlias);
      const release = this.tryReserveNewSessionAlias(alias);
      if (release) return { alias, release };
    }
    return null;
  }

  /**
   * Allocate a fresh acpx transport incarnation while preserving a stable logical
   * coordinator identity. Explicit "new session" paths use this; archive/restore
   * deliberately keep the transport already stored on the logical session.
   */
  buildFreshTransportSession(stableTransportSession: string): string {
    // Timestamp keeps names diagnosable; a full 64-bit random nonce prevents reuse
    // across daemon restarts, clock rollback, and independent SessionService instances.
    const timestamp = Math.max(0, Math.trunc(this.now()));
    const nonce = randomBytes(8).readBigUInt64BE().toString().padStart(20, "0");
    const generation = `${timestamp}${nonce}`;
    return `${stableTransportSession}:reset-${generation}`;
  }

  listInternalAliases(): string[] {
    return Object.keys(this.state.sessions);
  }

  /**
   * Read-only access to the persisted logical session record by internal alias.
   * Returns the LIVE record — callers must treat it as immutable. Exists for
   * consumers (the session resource catalog) that need fields ResolvedSession
   * does not carry (immutable logical_session_id, archived flag).
   */
  getLogicalSessionRecord(alias: string): LogicalSession | null {
    return this.state.sessions[alias] ?? null;
  }

  /** Read-only view of every persisted logical session record, across all channels. */
  listLogicalSessionRecords(): LogicalSession[] {
    return Object.values(this.state.sessions);
  }

  async setCurrentSessionMode(chatKey: string, modeId: string | undefined): Promise<void> {
    await this.mutate(async () => {
      const currentAlias = this.state.chat_contexts[chatKey]?.current_session;
      if (!currentAlias) {
        throw new Error("no current session selected");
      }

      const session = this.state.sessions[currentAlias];
      if (!session) {
        throw new Error("no current session selected");
      }

      const normalizedModeId = modeId?.trim();
      if (normalizedModeId) {
        session.mode_id = normalizedModeId;
      } else {
        delete session.mode_id;
      }

      session.last_used_at = new Date().toISOString();
      await this.persist();
    });
  }

  async setCurrentSessionReplyMode(chatKey: string, replyMode: "stream" | "final" | "verbose" | undefined): Promise<void> {
    await this.mutate(async () => {
      const currentAlias = this.state.chat_contexts[chatKey]?.current_session;
      if (!currentAlias) {
        throw new Error("no current session selected");
      }

      const session = this.state.sessions[currentAlias];
      if (!session) {
        throw new Error("no current session selected");
      }

      if (replyMode) {
        session.reply_mode = replyMode;
      } else {
        delete session.reply_mode;
      }

      session.last_used_at = new Date().toISOString();
      await this.persist();
    });
  }

  async getCurrentSession(chatKey: string): Promise<ResolvedSession | null> {
    return await this.mutate(async () => {
      const currentAlias = this.state.chat_contexts[chatKey]?.current_session;
      if (!currentAlias) {
        return null;
      }

      const session = this.state.sessions[currentAlias];
      if (!session) {
        return null;
      }

      session.last_used_at = new Date().toISOString();
      await this.persist();
      return this.toResolvedSession(session);
    });
  }

  async listSessions(chatKey: string): Promise<SessionListItem[]> {
    const channelId = getChannelIdFromChatKey(chatKey);
    const currentAlias = this.state.chat_contexts[chatKey]?.current_session;
    return Object.values(this.state.sessions)
      .filter((session) => isSessionAliasVisibleInChannel(session.alias, channelId))
      .map((session) => ({
        alias: toDisplaySessionAlias(session.alias),
        internalAlias: session.alias,
        agent: session.agent,
        workspace: session.workspace,
        isCurrent: session.alias === currentAlias,
      }));
  }

  countAliasesSharingTransport(transportSession: string, excludeAlias?: string): number {
    let count = 0;
    for (const session of Object.values(this.state.sessions)) {
      if (session.transport_session !== transportSession) {
        continue;
      }
      if (excludeAlias !== undefined && session.alias === excludeAlias) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  /**
   * Wire the sink for resource lifecycle events (production: the core
   * SessionResourceCatalog; the runtime calls this once after constructing
   * the catalog). Archive/restore/remove transitions report through it only
   * AFTER their state has been durably persisted — never before.
   */
  setSessionResourceLifecyclePublisher(publish: (input: SessionResourceLifecyclePublishInput) => void): void {
    this.lifecyclePublisher = publish;
  }

  private publishLifecycleEvent(type: SessionResourceLifecyclePublishInput["type"], record: LogicalSession): void {
    this.lifecyclePublisher?.({ type, record });
  }

  /**
   * Durability gate for lifecycle transitions: persist the copy-on-write
   * snapshot first (saveNow rejects on write failure, so the live state, chat
   * contexts and event stream all stay untouched), then publish the persisted
   * snapshot to the runtime state. Only after this resolves may the lifecycle
   * event be emitted.
   */
  private async commitLifecycleTransition(nextState: AppState): Promise<void> {
    await this.stateStore.saveNow(nextState);
    replaceRuntimeState(this.state, nextState);
  }

  async setArchived(alias: string, archived: boolean): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }
      // Only a genuine transition persists durably and publishes: re-archiving
      // an archived session (or unarchiving an active one) is a no-op, so each
      // logical operation produces at most one lifecycle event.
      const wasArchived = session.archived === true;
      if (wasArchived === archived) {
        return;
      }
      const nextState = structuredClone(this.state);
      const nextSession = nextState.sessions[alias]!;
      if (archived) {
        nextSession.archived = true;
        nextSession.archived_at = new Date(this.now()).toISOString();
      } else {
        delete nextSession.archived;
        delete nextSession.archived_at;
      }
      await this.commitLifecycleTransition(nextState);
      this.publishLifecycleEvent(archived ? "archived" : "restored", nextSession);
    });
  }

  async removeSession(alias: string): Promise<{ wasActive: boolean }> {
    return await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }
      // Pre-delete snapshot: the `removed` event must carry the session's
      // descriptor as it existed BEFORE deletion, so capture the record before
      // the copy-on-write transition drops it.
      const snapshot = structuredClone(session);

      const nextState = structuredClone(this.state);
      const wasActive = Object.values(nextState.chat_contexts).some(
        (ctx) => ctx.current_session === alias,
      );

      delete nextState.sessions[alias];

      for (const [chatKey, ctx] of Object.entries(nextState.chat_contexts)) {
        // Prune only references to the removed alias; keep the rest of the
        // chat context (other aliases' background_results, previous_session).
        if (ctx.previous_session === alias) {
          delete ctx.previous_session;
        }
        if (ctx.current_session === alias) {
          if (ctx.previous_session) {
            ctx.current_session = ctx.previous_session;
            delete ctx.previous_session;
          } else {
            ctx.current_session = "";
          }
        }
        if (ctx.background_results && alias in ctx.background_results) {
          delete ctx.background_results[alias];
          if (Object.keys(ctx.background_results).length === 0) {
            delete ctx.background_results;
          }
        }
        if (!ctx.current_session && !ctx.previous_session && !ctx.background_results) {
          delete nextState.chat_contexts[chatKey];
        }
      }

      await this.commitLifecycleTransition(nextState);
      this.publishLifecycleEvent("removed", snapshot);
      return { wasActive };
    });
  }

  async cacheNativeSessionList(chatKey: string, input: NativeSessionListInput): Promise<void> {
    await this.mutate(async () => {
      this.state.native_session_lists[chatKey] = {
        created_at: new Date(this.now()).toISOString(),
        agent: input.agent,
        ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
        cwd: input.cwd,
        sessions: input.sessions.map((session) => ({
          session_id: session.sessionId,
          ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
          ...(session.title !== undefined ? { title: session.title } : {}),
          ...(session.updatedAt !== undefined ? { updated_at: session.updatedAt } : {}),
        })),
        ...(input.nextCursor !== undefined ? { next_cursor: input.nextCursor } : {}),
      };
      await this.persist();
    });
  }

  async getNativeSessionList(chatKey: string, ttlMs = 10 * 60 * 1000): Promise<NativeSessionListResult | null> {
    const cached = this.state.native_session_lists[chatKey];
    if (!cached) {
      return null;
    }

    const createdAt = Date.parse(cached.created_at);
    if (Number.isNaN(createdAt)) {
      await this.deleteNativeSessionListIfCurrent(chatKey, cached);
      return null;
    }
    if (this.now() - createdAt > ttlMs) {
      await this.deleteNativeSessionListIfCurrent(chatKey, cached);
      return null;
    }

    return {
      agent: cached.agent,
      ...(cached.workspace !== undefined ? { workspace: cached.workspace } : {}),
      cwd: cached.cwd,
      sessions: cached.sessions.map((session) => ({
        sessionId: session.session_id,
        ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
        ...(session.title !== undefined ? { title: session.title } : {}),
        ...(session.updated_at !== undefined ? { updatedAt: session.updated_at } : {}),
      })),
      ...(cached.next_cursor !== undefined ? { nextCursor: cached.next_cursor } : {}),
    };
  }

  private async deleteNativeSessionListIfCurrent(
    chatKey: string,
    cached: AppState["native_session_lists"][string],
  ): Promise<void> {
    await this.mutate(async () => {
      if (this.state.native_session_lists[chatKey] !== cached) {
        return;
      }
      delete this.state.native_session_lists[chatKey];
      await this.persist();
    });
  }

  private toResolvedSession(session: LogicalSession): ResolvedSession {
    const agentConfig = this.config.agents[session.agent];
    if (!agentConfig) {
      throw new Error(
        `session "${session.alias}" references agent "${session.agent}", but that agent is no longer registered`,
      );
    }

    const workspaceConfig = this.config.workspaces[session.workspace];
    if (!workspaceConfig) {
      throw new Error(
        `session "${session.alias}" references workspace "${session.workspace}", but that workspace is no longer registered`,
      );
    }

    // The relay/control channel ALWAYS uses raw "stream" reply mode and intentionally
    // ignores every replyMode setting (per-session override AND channel/global config).
    // replyMode — stream/verbose/final — only exists for TEXT channels (WeChat, Feishu)
    // that batch agent output into a limited number of discrete chat messages. The relay
    // web dashboard renders a single live markdown bubble and consumes the verbatim token
    // stream, so batched paragraph reconstruction would only shred multi-line markdown
    // (tables/headings). There is therefore no reason to ever run relay in another mode,
    // so it's hardcoded here rather than routed through resolve-reply-mode.
    //
    // Detection is by the alias's channel prefix (`session.alias` is the internal,
    // channel-prefixed key of `state.sessions`). The one false positive is a LEGACY
    // (unprefixed) WeChat session a user literally named "relay:…": it would be read as
    // relay and stream instead of batch. This is an accepted edge of the pre-existing
    // channel-scope ambiguity (legacy weixin aliases aren't namespaced); the only robust
    // fix is a per-session channel field / prefixing weixin aliases — a schema migration
    // not worth it for this. Worst case: that one oddly-named session streams.
    //
    // Non-relay channels return `undefined` so their existing `replyMode ?? "verbose"`
    // resolution (including per-session overrides via `session.reply_mode`) is unchanged.
    const channelId = getChannelIdFromChatKey(session.alias);
    const effectiveReplyMode = channelId === "relay" ? "stream" : undefined;
    const launch = this.resolveLaunchSpec(session, agentConfig);

    return {
      alias: session.alias,
      agent: session.agent,
      driver: agentConfig.driver,
      settingsPolicy: agentConfig.settingsPolicy,
      agentCommand: launch.agentCommand,
      acpxAgent: launch.acpxAgent,
      rawCommand: launch.rawCommand,
      agentArgv: launch.agentArgv,
      // Session-level model wins; otherwise fall back to the agent config default.
      model: session.model ?? agentConfig.model,
      effort: session.effort,
      displayName: session.display_name,
      workspace: session.workspace,
      transportSession: session.transport_session,
      source: session.source,
      agentSessionId: session.agent_session_id,
      agentSessionTitle: session.agent_session_title,
      agentSessionUpdatedAt: session.agent_session_updated_at,
      attachedAt: session.attached_at,
      modeId: session.mode_id,
      replyMode: session.reply_mode,
      effectiveReplyMode,
      cwd: workspaceConfig.cwd,
      archived: session.archived === true,
    };
  }

  /**
   * The launch spec for a session. Precedence mirrors the historical command
   * resolution: explicit config overrides win over recorded launches; recorded
   * launches stay sticky only when genuinely custom. Derived launches (managed
   * adapter pins, hermes shim, local fallback) are recomputed on restart from the
   * current pin, so the acpx session identity follows the current pin.
   */
  private resolveLaunchSpec(
    session: LogicalSession,
    agentConfig: AgentConfig,
    platform: NodeJS.Platform = this.platform,
  ): AgentLaunchSpec {
    const current = resolveConfiguredAgentLaunch(agentConfig, this.config.transport, {
      platform,
      runtimeRoot: this.runtimeRoot,
    });
    // 1. Explicit config `command` wins over any recording. On Unix this is a
    // raw `--agent` override; on Windows a single-token command is synthesized
    // into argv — either way the CURRENT config command must beat sticky
    // recorded history so operators can intentionally rebind an agent.
    if (current.rawCommand || resolveAgentCommand(agentConfig.driver, agentConfig.command)) {
      return current;
    }
    // 2. Recorded custom argv stays sticky (like recorded raw commands): a
    // session created under argv A must keep operating as A even if the config
    // later changes to B — otherwise the session silently jumps to B's alias
    // and its history is orphaned.
    const recordedArgv = isDerivedAgentArgv(
      agentConfig.driver,
      session.transport_agent_argv,
      this.runtimeRoot,
      platform,
    )
      ? undefined
      : session.transport_agent_argv;
    if (recordedArgv && session.transport_acpx_agent) {
      return {
        acpxAgent: session.transport_acpx_agent,
        agentCommand: session.transport_agent_command ?? renderAgentArgvIdentity(recordedArgv),
        agentArgv: recordedArgv,
      };
    }
    // 3. Explicit config `argv` (for sessions that have no recorded launch).
    if (agentConfig.argv) {
      return current;
    }
    // 4. Recorded legacy custom raw command stays sticky so a session launched
    // with a custom command keeps its identity even if config changed later.
    // Derived recorded commands (legacy codex paths, hermes shim, managed npx
    // pins) yield to the current resolution instead.
    const recordedIsDerived = Boolean(session.transport_agent_command) && (
      (agentConfig.driver === "codex" && isLegacyCodexCommand(session.transport_agent_command!)) ||
      (agentConfig.driver === "hermes" && (
        isDefaultHermesCommand(session.transport_agent_command!) ||
        isHermesShimCommand(session.transport_agent_command!)
      )) ||
      isManagedAdapterCommand(agentConfig.driver, session.transport_agent_command) ||
      classifyRecordedPreinstalledAdapterCommand(session.transport_agent_command, {
        runtimeRoot: this.runtimeRoot,
        platform,
      }) === agentConfig.driver
    );
    const recordedCommand = recordedIsDerived ? undefined : session.transport_agent_command;
    if (recordedCommand) {
      // Pass the historical raw string through as an acpx `--agent` selector on
      // every platform. Do NOT split or guess argv here: acpx 0.13 looks up the
      // old session by agent_command, backfills built-in agentArgv from the
      // record parser, and fail-closes custom raw history that cannot spawn.
      return { acpxAgent: agentConfig.driver, rawCommand: recordedCommand, agentCommand: recordedCommand };
    }
    // 5. Derived current resolution (managed pin, hermes shim, local fallback, bare driver).
    return current;
  }

  /** Persist (or clear) a session's model override by internal alias. */
  async setSessionModel(alias: string, modelId: string | undefined): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }

      const normalized = modelId?.trim();
      if (normalized) {
        session.model = normalized;
      } else {
        delete session.model;
      }

      session.last_used_at = new Date(this.now()).toISOString();
      await this.persist();
    });
  }

  /** Persist (or clear) a session's reasoning-effort preference by internal alias. */
  async setSessionEffort(alias: string, effort: string | undefined): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }

      const normalized = effort?.trim();
      if (normalized) {
        session.effort = normalized;
      } else {
        delete session.effort;
      }

      session.last_used_at = new Date(this.now()).toISOString();
      await this.persist();
    });
  }

  /** Set (or clear) a session's relay-web display label. Identity (`alias`) is untouched. */
  async setDisplayName(alias: string, name?: string): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }

      const normalized = name?.trim();
      if (normalized) {
        session.display_name = normalized;
      } else {
        delete session.display_name;
      }

      session.last_used_at = new Date(this.now()).toISOString();
      await this.persist();
    });
  }

  /** Persist (or clear) the model override of the chat's current session. */
  async setCurrentSessionModel(chatKey: string, modelId: string | undefined): Promise<void> {
    await this.mutate(async () => {
      const currentAlias = this.state.chat_contexts[chatKey]?.current_session;
      if (!currentAlias) {
        throw new Error("no current session selected");
      }

      const session = this.state.sessions[currentAlias];
      if (!session) {
        throw new Error("no current session selected");
      }

      const normalized = modelId?.trim();
      if (normalized) {
        session.model = normalized;
      } else {
        delete session.model;
      }

      session.last_used_at = new Date(this.now()).toISOString();
      await this.persist();
    });
  }

  async setSessionTransportAgentCommand(
    alias: string,
    transportAgentCommand: string | undefined,
    transportAcpxAgent?: string,
    transportAgentArgv?: string[],
  ): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }

      const normalized = transportAgentCommand?.trim();
      if (normalized) {
        session.transport_agent_command = normalized;
      } else {
        delete session.transport_agent_command;
      }
      // Structured launch fields are only ever UPDATED here, never cleared by
      // omission: refresh paths call with (alias, command) only, and deleting
      // the recorded alias/argv on such a call would orphan the session from
      // its exact launch identity right after attach recorded it.
      if (transportAcpxAgent !== undefined) {
        session.transport_acpx_agent = transportAcpxAgent;
      }
      if (transportAgentArgv !== undefined) {
        if (transportAgentArgv.length > 0) {
          session.transport_agent_argv = [...transportAgentArgv];
        } else {
          delete session.transport_agent_argv;
        }
      }

      session.last_used_at = new Date().toISOString();
      await this.persist();
    });
  }

  /**
   * Execute one non-reentrant session transaction. Callers may acquire narrower
   * locks (for example adapter-op) inside the callback, but must never call a
   * SessionService mutation from it; use the supplied transaction operations.
   */
  async withSessionLock<T>(critical: (transaction: SessionLockedTransaction) => Promise<T>): Promise<T> {
    return await this.stateMutex.run(async () => await critical({
      setTransportAgentCommandDurably: (alias, command) => this.setTransportAgentCommandDurablyUnlocked(alias, command),
    }));
  }

  private async setTransportAgentCommandDurablyUnlocked(alias: string, transportAgentCommand: string | undefined): Promise<void> {
    if (!this.state.sessions[alias]) throw new Error(`session "${alias}" does not exist`);
    const nextState = structuredClone(this.state);
    const nextSession = nextState.sessions[alias]!;
    const normalized = transportAgentCommand?.trim();
    if (normalized) nextSession.transport_agent_command = normalized;
    else delete nextSession.transport_agent_command;
    await this.stateStore.saveNow(nextState);
    replaceRuntimeState(this.state, nextState);
  }

  private async mutate<T>(critical: () => Promise<T>): Promise<T> {
    return await this.stateMutex.run(critical);
  }

  // Commits the state snapshot to the store; with the production
  // DebouncedStateStore this resolves at commit time (the disk write happens
  // debounced, off the mutex), so persisting inside mutate() is cheap.
  private async persist(): Promise<void> {
    await this.stateStore.save(this.state);
  }

  private async createLogicalSession(
    alias: string,
    agent: string,
    workspace: string,
    transportSession: string,
    transportAgentCommand?: string,
    native?: {
      source?: LogicalSession["source"];
      agentSessionId?: string;
      title?: string | null;
      updatedAt?: string;
    },
    transportAcpxAgent?: string,
    transportAgentArgv?: string[],
  ): Promise<ResolvedSession> {
    return await this.mutate(async () => {
      this.validateSession(alias, agent, workspace);
      if (
        Object.keys(this.state.orchestration.externalCoordinators).some((coordinatorSession) =>
          sameCoordinatorSession(coordinatorSession, transportSession),
        )
      ) {
        throw new Error(`transport session "${transportSession}" conflicts with an external coordinator`);
      }
      const existingSession = this.state.sessions[alias];
      // Per-agent settings (cached transport command, mode, reply mode) are only
      // carried over when the alias is recreated with the same agent. A different
      // agent must start clean, otherwise prompts would go to the old agent binary.
      const sameAgentExisting =
        existingSession && existingSession.agent === agent ? existingSession : undefined;
      const now = new Date(this.now()).toISOString();
      const normalizedTransportAgentCommand = transportAgentCommand?.trim();
      const session: LogicalSession = {
        alias,
        agent,
        workspace,
        transport_session: transportSession,
        // Fresh immutable identity for every create/attach. Deliberately NOT
        // carried over from an existing same-alias record: a deleted/recreated
        // alias is a new logical session and must get a new id.
        logical_session_id: randomUUID(),
        source: native?.source,
        agent_session_id: native?.agentSessionId,
        agent_session_title: native?.title ?? undefined,
        agent_session_updated_at: native?.updatedAt,
        attached_at: native ? now : undefined,
        ...(normalizedTransportAgentCommand
          ? { transport_agent_command: normalizedTransportAgentCommand }
          : sameAgentExisting?.transport_agent_command
            ? { transport_agent_command: sameAgentExisting.transport_agent_command }
            : {}),
        ...(transportAcpxAgent
          ? { transport_acpx_agent: transportAcpxAgent }
          : sameAgentExisting?.transport_acpx_agent
            ? { transport_acpx_agent: sameAgentExisting.transport_acpx_agent }
            : {}),
        ...(transportAgentArgv && transportAgentArgv.length > 0
          ? { transport_agent_argv: [...transportAgentArgv] }
          : sameAgentExisting?.transport_agent_argv
            ? { transport_agent_argv: [...sameAgentExisting.transport_agent_argv] }
            : {}),
        mode_id: sameAgentExisting?.mode_id,
        model: sameAgentExisting?.model,
        effort: sameAgentExisting?.effort,
        reply_mode: sameAgentExisting?.reply_mode,
        display_name: sameAgentExisting?.display_name,
        created_at: existingSession?.created_at ?? now,
        last_used_at: now,
      };

      this.state.sessions[alias] = session;
      await this.persist();
      return this.toResolvedSession(session);
    });
  }

  private validateSession(alias: string, agent: string, workspace: string): void {
    if (alias.trim().length === 0) {
      throw new Error("session alias must be a non-empty string");
    }

    if (agent.trim().length === 0) {
      throw new Error("agent must be a non-empty string");
    }

    if (workspace.trim().length === 0) {
      throw new Error("workspace must be a non-empty string");
    }

    if (!this.config.workspaces[workspace]) {
      throw new Error(t().misc.workspaceNotRegistered(workspace));
    }

    if (!this.config.agents[agent]) {
      throw new Error(t().misc.agentNotRegistered(agent));
    }
  }
}
