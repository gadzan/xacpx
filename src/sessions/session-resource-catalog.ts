import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { LogicalSession } from "../state/types";
import {
  getChannelIdFromChatKey,
  isSessionAliasVisibleInChannel,
  toDisplaySessionAlias,
} from "../channels/channel-scope";
import type { SessionService } from "./session-service";

/**
 * A point-in-time snapshot of one logical session's resource identity. The
 * immutable `logicalSessionId` is the ONLY stable key: aliases, display names
 * and transport bindings can all change under the same id. `cwd` is resolved
 * authoritatively from the core workspace config — callers (e.g. browsers)
 * never contribute a cwd. Descriptors are snapshots: a previously returned
 * descriptor never mutates when the underlying session changes.
 */
export interface SessionResourceDescriptor {
  logicalSessionId: string;
  channelId: string;
  internalAlias: string;
  displayAlias: string;
  workspace: string;
  cwd: string;
  archived: boolean;
}

export type SessionResourceLifecycleEvent =
  | { type: "archived"; session: SessionResourceDescriptor }
  | { type: "restored"; session: SessionResourceDescriptor }
  | { type: "removed"; session: SessionResourceDescriptor };

/**
 * Generic, channel-agnostic catalog over logical session resources. Contains
 * no channel- or consumer-specific vocabulary; structured channels (and their
 * plugins) use it to enumerate and resolve the sessions they own.
 */
export interface SessionResourceCatalog {
  /**
   * Resolve a chat-scoped alias (display or internal form) to a descriptor.
   * Uses the same chat-scope resolution as ControlService: a caller can never
   * reach another channel's sessions. Returns null for unknown aliases and
   * for sessions whose workspace is no longer registered (their cwd cannot be
   * authoritatively resolved).
   */
  resolve(chatKey: string, alias: string): Promise<SessionResourceDescriptor | null>;
  /** All sessions of one channel, active AND archived, for reconciliation. */
  list(channelId: string): Promise<SessionResourceDescriptor[]>;
  /**
   * Register a lifecycle listener; returns an unsubscribe function. Listener
   * exceptions are caught and logged to the app log: they never roll back the
   * underlying session operation and never block other listeners.
   */
  subscribe(listener: (event: SessionResourceLifecycleEvent) => void): () => void;
}

interface SessionResourceCatalogDeps {
  sessions: SessionService;
  config: AppConfig;
  logger: AppLogger;
}

/**
 * Production catalog assembled by the core runtime over the live SessionService
 * and workspace config. Plugin/channel tests should use their own in-memory
 * implementation of the interface instead of this adapter.
 */
export class CoreSessionResourceCatalog implements SessionResourceCatalog {
  private readonly listeners = new Set<(event: SessionResourceLifecycleEvent) => void>();

  constructor(private readonly deps: SessionResourceCatalogDeps) {}

  async resolve(chatKey: string, alias: string): Promise<SessionResourceDescriptor | null> {
    let internalAlias: string;
    try {
      // Same chat-scope alias resolution ControlService uses.
      internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    } catch {
      // Empty/blank alias input — treat as unresolvable rather than throwing.
      return null;
    }
    const record = this.deps.sessions.getLogicalSessionRecord(internalAlias);
    if (!record) {
      return null;
    }
    // Defense in depth: the legacy (unprefixed) weixin fallback inside
    // resolveSessionAliasForInput can return an exact internal alias that
    // belongs to a different channel; never leak it across the scope.
    const channelId = getChannelIdFromChatKey(chatKey);
    if (!isSessionAliasVisibleInChannel(record.alias, channelId)) {
      return null;
    }
    return this.toDescriptor(record);
  }

  async list(channelId: string): Promise<SessionResourceDescriptor[]> {
    const descriptors: SessionResourceDescriptor[] = [];
    for (const record of this.deps.sessions.listLogicalSessionRecords()) {
      if (!isSessionAliasVisibleInChannel(record.alias, channelId)) {
        continue;
      }
      const descriptor = this.toDescriptor(record);
      if (descriptor) {
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  }

  subscribe(listener: (event: SessionResourceLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Task 6 wires the real archive/restore/remove transitions (with durable
   * ordering: persist first, then publish) to this hook. Until then it is
   * private and only exercised by the subscribe-mechanics tests.
   */
  private emit(event: SessionResourceLifecycleEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // Listener failures are isolated: they must not roll back the session
        // operation that produced the event, nor block remaining listeners.
        void this.deps.logger
          .error("sessions.resource_catalog.listener_failed", "session resource listener threw; delivery continues", {
            message: error instanceof Error ? error.message : String(error),
            eventType: event.type,
            internalAlias: event.session.internalAlias,
          })
          .catch(() => {});
      }
    }
  }

  private toDescriptor(record: LogicalSession): SessionResourceDescriptor | null {
    // cwd is authoritative from the core workspace config. A session whose
    // workspace was de-registered has no trustworthy cwd, so it is omitted
    // rather than served with a fabricated or stale path.
    const workspace = this.deps.config.workspaces[record.workspace];
    if (!workspace) {
      return null;
    }
    return {
      logicalSessionId: record.logical_session_id,
      channelId: getChannelIdFromChatKey(record.alias),
      internalAlias: record.alias,
      displayAlias: toDisplaySessionAlias(record.alias),
      workspace: record.workspace,
      cwd: workspace.cwd,
      archived: record.archived === true,
    };
  }
}
