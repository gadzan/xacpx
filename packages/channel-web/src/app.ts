import { randomBytes, randomUUID } from "node:crypto";

import { serveStatic } from "@hono/node-server/serve-static";
import { MemoryMessageStore, compactHistoryMessage, createControlBridge, historyMessagesToRows, type ControlBridgeOptions } from "@ganglion/xacpx-control-bridge";
import {
  MSG,
  RELAY_CAPABILITIES,
  encodeEnvelope,
  isErrorPayload,
  parseControlPayload,
  webEventEnvelope,
  type ControlEventDto,
  type LiveTurnSnapshotDto,
  type SessionHistoryRowDto,
  type WebAgentDirectoryEndpointDto,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import type { PublicControlService } from "xacpx/plugin-api";

import { LOCAL_INSTANCE_ID, localInstanceName, type WebChannelConfig } from "./config.js";
import { LocalInteractions, LOCAL_OWNER_ID } from "./interactions.js";
import { hostHeaderAllowed, jsonContentType, originAllowed, tokensMatch } from "./security.js";
import type { LocalTerminalClient } from "./terminal.js";
import { terminalMessage } from "./terminal.js";

export const SESSION_COOKIE = "xacpx_web_session";
const LOCAL_ACCOUNT = "local";
const LOCAL_CHAT_KEY = "web:local";

const CHAT_SCOPED = new Set<string>([
  MSG.prompt, MSG.promptCancel, MSG.commandExecute, MSG.queueCancel,
  MSG.scheduledList, MSG.scheduledCreate, MSG.scheduledCancel,
  MSG.sessionsList, MSG.sessionsCreate, MSG.sessionsNativeList, MSG.sessionsHistory, MSG.sessionsRemove,
  MSG.sessionsArchive, MSG.sessionsUnarchive, MSG.sessionsRename, MSG.sessionsFork,
  MSG.sessionModelGet, MSG.sessionModelSet, MSG.sessionEffortGet, MSG.sessionEffortSet,
]);

interface Client {
  send: (data: string, done?: (error?: Error) => void) => void;
  end: () => void;
  session: string | undefined;
}

export interface LocalWebApp {
  app: Hono;
  messages: MemoryMessageStore;
  interactions: LocalInteractions;
  ports: { current: number };
  publish: (event: WebServerEvent) => void;
  project: (event: ControlEventDto) => void;
  /** A control event that may have changed the published endpoint set: schedules a
   *  debounced agent-directory re-read and broadcast. */
  noteDirectoryEvent: (event: ControlEventDto) => void;
  /** Turns that arrived before their queue reply, still waiting to be claimed. */
  earlyTurns: () => string[];
  allows: (session: string | undefined) => boolean;
  attach: (send: (data: string, done?: (error?: Error) => void) => void, end: () => void, session: string | undefined) => (raw?: string) => void;
  close: () => void;
}

export interface LocalWebAppOptions {
  config: WebChannelConfig;
  port: number;
  webRoot?: string;
  control: PublicControlService;
  trustedConversationPrompt?: ControlBridgeOptions["trustedConversationPrompt"];
  trustedConversationPolicyPrompt?: ControlBridgeOptions["trustedConversationPolicyPrompt"];
  terminal?: LocalTerminalClient;
  now?: () => number;
}

export function createLocalWebApp(options: LocalWebAppOptions): LocalWebApp {
  const { config, control } = options;
  const ports = { current: options.port };
  const now = options.now ?? Date.now;
  const messages = new MemoryMessageStore(() => new Date(now()));
  const turns = new Map<string, { text: string; startedAt: number }>();
  const sessions = new Set<string>();
  const clients = new Set<Client>();
  const instanceName = localInstanceName(config);
  const viewers = new Map<Client, string>();
  let nextViewer = 1;
  let publish: (event: WebServerEvent) => void = () => undefined;
  const interactions = new LocalInteractions(now, setTimeout, clearTimeout, (frame) => {
    publish({
      kind: "control-event",
      instanceId: LOCAL_INSTANCE_ID,
      event: frame as never,
    });
  });
  const bridge = createControlBridge(control, {
    ...(options.trustedConversationPrompt ? { trustedConversationPrompt: options.trustedConversationPrompt } : {}),
    ...(options.trustedConversationPolicyPrompt ? { trustedConversationPolicyPrompt: options.trustedConversationPolicyPrompt } : {}),
  });

  publish = (event: WebServerEvent): void => {
    const data = encodeEnvelope(webEventEnvelope(event));
    for (const client of clients) client.send(data);
  };

  const inflightPrompts = new Map<string, number>();
  const earlyStarts = new Map<string, Set<string>>();

  /**
   * The @ mention selector's candidate source, and the connect-time snapshot a
   * fresh dashboard needs before any event arrives. Read from the control
   * facade: the daemon already publishes its endpoint set for the relay hub, so
   * this console reuses it instead of inventing a second inventory. A control
   * facade without the reader (an older core) answers an empty directory rather
   * than failing the route.
   */
  const readAgentDirectory = async (): Promise<WebAgentDirectoryEndpointDto[]> => {
    const read = (control as { getPublishedAgentEndpoints?: () => Promise<unknown[]> })
      .getPublishedAgentEndpoints;
    if (typeof read !== "function") return [];
    const endpoints = await read.call(control);
    return Array.isArray(endpoints)
      ? endpoints.map((endpoint) => ({
        ...(endpoint as Record<string, unknown>),
        instanceId: LOCAL_INSTANCE_ID,
      }) as WebAgentDirectoryEndpointDto)
      : [];
  };

  const publishAgentDirectory = (): void => {
    void readAgentDirectory()
      .then((endpoints) => { publish({ kind: "agent-directory", endpoints }); })
      .catch(() => { /* best effort: the next event re-reads the directory */ });
  };

  /** Trailing-debounced re-read. The trigger set is the relay channel's: sessions,
   *  worker bindings, Bots and turn boundaries are exactly what changes the
   *  published endpoint set, and a burst of them collapses into one snapshot. */
  let directoryTimer: ReturnType<typeof setTimeout> | undefined;
  const noteDirectoryEvent = (event: ControlEventDto): void => {
    const type = (event as { type?: string }).type;
    if (
      type !== "sessions-changed" &&
      type !== "orchestration-changed" &&
      type !== "bots-changed" &&
      type !== "turn-started" &&
      type !== "turn-finished"
    ) {
      return;
    }
    if (directoryTimer) clearTimeout(directoryTimer);
    directoryTimer = setTimeout(() => {
      directoryTimer = undefined;
      publishAgentDirectory();
    }, 250);
  };

  /**
   * What this console can serve, read from the core rather than assumed.
   *
   * The timeline is the dashboard's only conversation surface: without its
   * capability the pane shows an upgrade notice and disables every write entry
   * point. The core exposes a probe, so ask it — a daemon that answers `true`
   * projects `control.conversation.timeline`, and our own validator must accept
   * the payload before we advertise it.
   */
  /**
   * A Bot's own workspace is allocated by the core, so the create dialog must not
   * ask the user to pick one. The core gates this behind a probe (an older core
   * still requires `workspace`); advertising the capability tells the dashboard it
   * may omit the field. Both halves are required — the probe AND our validator
   * accepting the payload — because either one alone would let the web send a
   * request this instance rejects.
   */
  const botWorkspaceCapabilities = (): string[] => {
    const capabilities: string[] = [];
    const create = (control as { supportsBotDedicatedWorkspace?: unknown }).supportsBotDedicatedWorkspace;
    if (typeof create === "function" && (create as () => unknown).call(control) === true
      && parseControlPayload(MSG.botsCreate, { name: "probe", agent: "probe" }) !== null) {
      capabilities.push(RELAY_CAPABILITIES.botsDedicatedWorkspaceV1);
    }
    const update = (control as { supportsBotDedicatedWorkspaceUpdate?: unknown }).supportsBotDedicatedWorkspaceUpdate;
    if (typeof update === "function" && (update as () => unknown).call(control) === true
      && parseControlPayload(MSG.botsUpdate, { id: "probe", dedicatedWorkspace: true }) !== null) {
      capabilities.push(RELAY_CAPABILITIES.botsDedicatedWorkspaceUpdateV1);
    }
    const cleanup = (control as { supportsBotDedicatedWorkspaceCleanup?: unknown }).supportsBotDedicatedWorkspaceCleanup;
    if (typeof cleanup === "function" && (cleanup as () => unknown).call(control) === true
      && parseControlPayload(MSG.botsRemove, {
        id: "probe", requestId: "probe", previewRevision: "probe", deleteDedicatedWorkspace: true,
      }) !== null) {
      capabilities.push(RELAY_CAPABILITIES.botsDedicatedWorkspaceCleanupV1);
    }
    return capabilities;
  };

  const instanceCapabilities = (): string[] => {
    const capabilities: string[] = [];
    if (options.terminal?.ready === true) {
      capabilities.push(RELAY_CAPABILITIES.terminalRmuxRecoveryV1, RELAY_CAPABILITIES.terminalMultiViewV1);
    }
    const probe = (control as { supportsConversationTimelineV1?: unknown }).supportsConversationTimelineV1;
    if (typeof probe === "function" && (probe as () => unknown).call(control) === true) {
      const accepted = parseControlPayload(MSG.conversationTimeline, {
        conversationId: "probe", topicId: "probe", limit: 1,
      }) !== null;
      if (accepted) capabilities.push(RELAY_CAPABILITIES.conversationTimelineV1);
    }
    capabilities.push(...botWorkspaceCapabilities());
    return capabilities;
  };

  /**
   * Install a daemon-recovered transcript for a session, at most once.
   *
   * Two seeders deliver the same daemon mirror: the `session-history` control
   * event below, and the on-demand read the dashboard makes when this console's
   * in-memory store is empty. The emptiness check sits immediately above the
   * appends with no `await` between them, so it is atomic: two seeders that both
   * arrive while the store is empty cannot both pass, because the first one's
   * rows are already in by the time the second one checks. The check used to live
   * in the HTTP handler, before an `await` on the daemon read — two in-flight
   * reads then both saw an empty store and each appended the whole backlog, so
   * the dashboard rendered every message twice.
   */
  function installRecoveredHistory(alias: string, rows: readonly SessionHistoryRowDto[]): boolean {
    if (rows.length === 0) return false;
    if (messages.listBySession(LOCAL_ACCOUNT, LOCAL_INSTANCE_ID, alias, { limit: 1 }).messages.length > 0) return false;
    for (const row of rows) {
      if (typeof row.text !== "string" || (row.direction !== "in" && row.direction !== "out")) continue;
      messages.append(LOCAL_INSTANCE_ID, alias, row.direction, row.text, row.structured);
    }
    return true;
  }

  /**
   * Recover a session's transcript from the daemon when this console holds none.
   *
   * The daemon reads the agent's own on-disk record, so a session created before
   * this process started still has its turns. Rows land in the in-memory store so
   * later reads and the event projection see them too; a failure yields false and
   * the caller reports the (empty) in-memory page, which is the old behavior.
   */
  const seedFromDaemon = async (alias: string, limit: number): Promise<boolean> => {
    const result = await new Promise<unknown>((resolve) => {
      bridge(
        {
          protocolVersion: 1,
          kind: "request",
          type: MSG.sessionsHistory,
          payload: { chatKey: LOCAL_CHAT_KEY, sessionAlias: alias, limit },
        } as never,
        resolve,
      );
    });
    if (!result || typeof result !== "object" || isErrorPayload(result)) return false;
    const rows = (result as { messages?: unknown }).messages;
    if (!Array.isArray(rows)) return false;
    const native = rows.filter(
      (row): row is Parameters<typeof historyMessagesToRows>[0][number] =>
        Boolean(row) && typeof row === "object"
        && ((row as { role?: unknown }).role === "user" || (row as { role?: unknown }).role === "agent")
        && typeof (row as { text?: unknown }).text === "string",
    );
    // The same mapper the session-history event uses, so a transcript recovered
    // over this read carries its process instead of degrading to bare text.
    return installRecoveredHistory(alias, historyMessagesToRows(native));
  };
  const project = (event: ControlEventDto): void => {
    if (!("sessionAlias" in event) || typeof event.sessionAlias !== "string") return;
    const alias = event.sessionAlias;
    if (event.type === "turn-started") {
      turns.set(alias, { text: "", startedAt: now() });
      if (typeof event.queueItemId === "string") {
        const promoted = messages.promoteQueued({ instanceId: LOCAL_INSTANCE_ID, sessionAlias: alias, queueItemId: event.queueItemId });
        const waiting = earlyStarts.get(alias);
        if (promoted) waiting?.delete(event.queueItemId);
        else if ((inflightPrompts.get(alias) ?? 0) > 0) {
          const ids = waiting ?? new Set<string>();
          ids.add(event.queueItemId);
          earlyStarts.set(alias, ids);
        }
      }
    } else if (event.type === "session-history") {
      installRecoveredHistory(alias, event.messages);
    } else if (event.type === "turn-output") {
      const turn = turns.get(alias) ?? { text: "", startedAt: now() };
      turn.text += event.chunk;
      turns.set(alias, turn);
    } else if (event.type === "turn-finished") {
      const turn = turns.get(alias);
      const text = typeof event.text === "string" && event.text.length > 0 ? event.text : turn?.text ?? "";
      if (text) messages.append(LOCAL_INSTANCE_ID, alias, "out", text);
      turns.delete(alias);
    }
  };

  const app = new Hono();

  app.use("*", async (c, next) => {
    if (!hostHeaderAllowed(c.req.header("host"), config.host, ports.current)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const method = c.req.method.toUpperCase();
    const changing = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if ((changing || c.req.path === "/ws") && !originAllowed(c.req.header("origin"), config.host, ports.current)) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (changing && c.req.path.startsWith("/api/") && !jsonContentType(c.req.header("content-type"))) {
      return c.json({ error: "unsupported-media-type" }, 415);
    }
    return next();
  });

  const signedIn = (cookie: string | undefined): boolean => {
    if (!config.token) return true;
    return cookie !== undefined && sessions.has(cookie);
  };

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/config" || c.req.path === "/api/login") return next();
    if (!signedIn(getCookie(c, SESSION_COOKIE))) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/api/config", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      hostMode: "local",
      auth: { required: Boolean(config.token), mode: "token" },
      capabilities: {
        multiInstance: false,
        pairing: false,
        invites: false,
        webPush: false,
        relayUpdate: false,
        agentDirectory: true,
        terminal: options.terminal?.ready === true,
        desktop: false,
      },
      defaultInstanceId: LOCAL_INSTANCE_ID,
      historyRetention: { mode: "client-side", days: 30, maxPerSession: 2000 },
    });
  });

  app.post("/api/login", async (c) => {
    if (!config.token) return c.json({ username: LOCAL_ACCOUNT });
    const body = await c.req.json().catch(() => ({})) as { token?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    if (!tokensMatch(config.token, token)) return c.json({ error: "unauthorized" }, 401);
    const session = randomBytes(32).toString("base64url");
    sessions.add(session);
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    return c.json({ username: LOCAL_ACCOUNT });
  });

  app.post("/api/logout", (c) => {
    const session = getCookie(c, SESSION_COOKIE);
    if (session) {
      sessions.delete(session);
      for (const client of clients) {
        if (client.session === session) client.end();
      }
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.get("/api/me", (c) => c.json({ username: LOCAL_ACCOUNT }));

  app.get("/api/instances", (c) => c.json({
    instances: [{
      id: LOCAL_INSTANCE_ID,
      name: instanceName,
      online: true,
      capabilities: instanceCapabilities(),
    }],
  }));

  app.patch("/api/instances/:id", async (c) => {
    if (c.req.param("id") !== LOCAL_INSTANCE_ID) return c.json({ error: "not-found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    if (typeof body.name === "string" && body.name.trim()) {
      return c.json({ id: LOCAL_INSTANCE_ID, name: body.name.trim(), online: true });
    }
    return c.json({ error: "bad-request" }, 400);
  });

  app.get("/api/active-turns", (c) => {
    const live: LiveTurnSnapshotDto[] = [...turns.entries()].map(([sessionAlias, turn]) => ({
      instanceId: LOCAL_INSTANCE_ID,
      sessionAlias,
      parts: turn.text ? [{ type: "text", text: turn.text }] : [],
      status: turn.text ? "streaming" : "working",
      startedAt: turn.startedAt,
    }));
    return c.json({ turns: live, usage: [], commands: [], conversationCommands: [] });
  });

  /**
   * The @ mention selector's candidate source. The relay hub broadcasts this
   * snapshot to every connected dashboard; a local console has no hub in front of
   * it, so serve the same view straight from the control facade — the daemon's
   * published endpoint set (logical sessions + Bots), tagged with this instance.
   */
  app.get("/api/agent-directory", async (c) =>
    c.json({ endpoints: await readAgentDirectory() }));

  app.get("/api/instances/:id/sessions/:alias/messages/:messageId", (c) => {
    if (c.req.param("id") !== LOCAL_INSTANCE_ID) return c.json({ error: "not-found" }, 404);
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId) || messageId <= 0) return c.json({ error: "not-found" }, 404);
    const message = messages.getById(LOCAL_ACCOUNT, LOCAL_INSTANCE_ID, c.req.param("alias"), Math.floor(messageId));
    if (!message) return c.json({ error: "not-found" }, 404);
    return c.json({ message });
  });

  app.get("/api/instances/:id/sessions/:alias/messages", async (c) => {
    if (c.req.param("id") !== LOCAL_INSTANCE_ID) return c.json({ error: "not-found" }, 404);
    const alias = c.req.param("alias");
    if (c.req.query("view") === "pending") {
      const pending = messages.listPendingBySession(LOCAL_ACCOUNT, LOCAL_INSTANCE_ID, alias);
      return c.json({ items: pending });
    }
    const limitRaw = Number(c.req.query("limit"));
    const beforeRaw = Number(c.req.query("before"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : undefined;
    const page = messages.listBySession(LOCAL_ACCOUNT, LOCAL_INSTANCE_ID, alias, {
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    // An empty in-memory transcript does not mean the session has no history: the
    // daemon can still read the agent's own record. The browser cache only speeds
    // up rendering, so recover from the daemon rather than reporting "no messages".
    // Answer from a re-read afterwards: a concurrent seeder may have installed the
    // rows while this request was reading the daemon, and `page` predates that.
    if (page.messages.length === 0 && before === undefined) {
      await seedFromDaemon(alias, limit);
    }
    const effective = page.messages.length === 0 && before === undefined
      ? messages.listBySession(LOCAL_ACCOUNT, LOCAL_INSTANCE_ID, alias, { limit })
      : page;
    if (c.req.query("view") === "compact") {
      return c.json({ ...effective, messages: effective.messages.map(compactHistoryMessage) });
    }
    return c.json(effective);
  });

  app.post("/api/instances/:id/rpc", async (c) => {
    if (c.req.param("id") !== LOCAL_INSTANCE_ID) return c.json({ error: "not-found" }, 404);
    const body = await c.req.json().catch(() => ({})) as { type?: unknown; payload?: unknown };
    if (typeof body.type !== "string" || !body.type.startsWith("control.")) {
      return c.json({ error: "invalid-rpc-type" }, 400);
    }
    let payload = (body.payload ?? {}) as Record<string, unknown>;
    if (body.type === MSG.interactionRequest || body.type === MSG.interactionWithdraw) {
      return c.json({ error: "unsupported-rpc" }, 403);
    }
    if (CHAT_SCOPED.has(body.type)) {
      payload = {
        ...payload,
        chatKey: LOCAL_CHAT_KEY,
        senderId: LOCAL_ACCOUNT,
        isOwner: true,
        chatType: "direct",
      };
    }
    if (body.type === MSG.conversationPrompt || body.type === MSG.conversationPromptWithPolicy) {
      payload = {
        ...payload,
        requestId: typeof payload.requestId === "string" && payload.requestId ? payload.requestId : randomUUID(),
        humanIngress: {
          chatKey: LOCAL_CHAT_KEY,
          senderId: LOCAL_ACCOUNT,
          accountId: LOCAL_ACCOUNT,
          senderName: LOCAL_ACCOUNT,
          isOwner: true,
          chatType: "direct",
        },
      };
    }
    if (body.type === MSG.interactionRespond) {
      const answer = parseControlPayload(MSG.interactionRespond, payload);
      if (!answer) return c.json({ error: "invalid-payload" }, 400);
      const pending = interactions.peek(answer.requestId);
      const allowed = pending?.interaction.permission?.availableOutcomes;
      if (pending?.interaction.kind === "permission" && allowed && !allowed.includes(answer.action)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      if (!pending || pending.interaction.expiresAt <= now() || pending.interaction.kind !== answer.kind) {
        if (pending && pending.interaction.expiresAt <= now()) {
          interactions.answer(answer.requestId, { responded: false, reason: "expired" });
        }
        return c.json({ error: "interaction-gone" }, 409);
      }
      interactions.answer(answer.requestId, {
        responded: true,
        response: { ...answer, responderId: LOCAL_OWNER_ID },
      });
      return c.json({ result: { ok: true } });
    }
    const promptAlias = body.type === MSG.prompt && typeof payload.sessionAlias === "string" ? payload.sessionAlias : undefined;
    const promptText = promptAlias && typeof payload.text === "string" ? payload.text : undefined;
    const promptId = promptAlias && promptText
      ? messages.append(LOCAL_INSTANCE_ID, promptAlias, "in", promptText)
      : undefined;
    if (promptAlias) inflightPrompts.set(promptAlias, (inflightPrompts.get(promptAlias) ?? 0) + 1);
    let result: unknown;
    let finishedPrompt = false;
    try {
      result = await new Promise((resolve) => {
        bridge({ protocolVersion: 1, kind: "request", type: body.type, payload } as never, resolve);
      });
    } finally {
      if (promptAlias) {
        const left = (inflightPrompts.get(promptAlias) ?? 1) - 1;
        if (left > 0) inflightPrompts.set(promptAlias, left);
        else {
          inflightPrompts.delete(promptAlias);
          finishedPrompt = true;
        }
      }
    }
    const queuedId = result !== null && typeof result === "object" && "queued" in result && result.queued === true
      && "queueItemId" in result && typeof result.queueItemId === "string"
      ? result.queueItemId : undefined;
    const startedEarly = Boolean(queuedId && promptAlias && earlyStarts.get(promptAlias)?.has(queuedId));
    if (finishedPrompt && promptAlias) earlyStarts.delete(promptAlias);
    const rejected = !queuedId && (isErrorPayload(result)
      || (result !== null && typeof result === "object" && "ok" in result && result.ok === false));
    if (queuedId && promptId !== undefined && promptAlias && !startedEarly) {
      messages.markQueued(promptId, { instanceId: LOCAL_INSTANCE_ID, sessionAlias: promptAlias, queueItemId: queuedId });
    } else if (rejected && promptId !== undefined && promptAlias) {
      messages.drop(LOCAL_INSTANCE_ID, promptAlias, promptId);
    }
    if (body.type === MSG.queueCancel && !isErrorPayload(result) && typeof payload.itemId === "string" && typeof payload.sessionAlias === "string") {
      const cancelled = result !== null && typeof result === "object" && "cancelled" in result ? result.cancelled : undefined;
      if (cancelled !== false) messages.deletePendingByQueueItem(LOCAL_INSTANCE_ID, payload.sessionAlias, payload.itemId);
    }
    if (isErrorPayload(result)) {
      const code = result.error.code;
      const status = code === "invalid-payload" || code === "bad-request" ? 400 : code === "timeout" ? 504 : 500;
      return c.json({ error: code }, status);
    }
    return c.json({ result });
  });

  const allows = (session: string | undefined): boolean => {
    if (!config.token) return true;
    return session !== undefined && sessions.has(session);
  };

  const receive = async (client: Client, raw: string): Promise<void> => {
    const message = terminalMessage(raw);
    if (!message || !options.terminal?.ready) return;
    let viewerId = viewers.get(client);
    if (!viewerId) {
      viewerId = `local-viewer-${nextViewer}`;
      nextViewer += 1;
      viewers.set(client, viewerId);
    }
    await options.terminal.handle(message, viewerId, (event, done) => client.send(encodeEnvelope(webEventEnvelope(event)), done));
  };

  const attach = (send: (data: string, done?: (error?: Error) => void) => void, end: () => void, session: string | undefined): ((raw?: string) => void) => {
    const client = { send, end, session };
    clients.add(client);
    client.send(encodeEnvelope(webEventEnvelope({
      kind: "interaction-snapshot",
      instanceId: LOCAL_INSTANCE_ID,
      interactions: interactions.list(),
    })));
    // The directory snapshot the hub pushes on connect: without it a fresh
    // dashboard shows no @ candidates until the first endpoint-affecting event.
    void readAgentDirectory().then((endpoints) => {
      client.send(encodeEnvelope(webEventEnvelope({ kind: "agent-directory", endpoints })));
    });    return (raw?: string) => {
      if (raw === undefined) {
        const viewerId = viewers.get(client);
        if (viewerId) options.terminal?.detachViewer(viewerId);
        clients.delete(client);
        viewers.delete(client);
        return;
      }
      void receive(client, raw);
    };
  };

  if (options.webRoot) {
    const root = options.webRoot;
    app.use("/*", async (c, next) => {
      await next();
      if (c.req.path.startsWith("/api") || c.req.path.startsWith("/ws") || !c.res.ok) return;
      const html = (c.res.headers.get("content-type") ?? "").includes("text/html");
      c.header("Cache-Control", !html && c.req.path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache");
    });
    app.use("/*", serveStatic({ root }));
    // SPA fallback: an unknown route is a client-side navigation and gets the app shell.
    // A missing /assets/* file must NOT: answering it with index.html returns 200 + HTML
    // for a script, so the browser runs markup as JavaScript and a service worker
    // precaches the junk under the old file's name. A stale worker then keeps serving a
    // dead chunk forever, because nothing ever saw a 404 for it.
    app.get("/*", async (c, next) => {
      if (c.req.path.startsWith("/assets/")) {
        await next();
        return;
      }
      return await serveStatic({ path: "index.html", root })(c, next);
    });
  }

  return {
    app,
    messages,
    interactions,
    ports,
    publish,
    project,
    noteDirectoryEvent,
    earlyTurns: () => [...earlyStarts.values()].flatMap((ids) => [...ids]),
    allows,
    attach,
    close: () => {
      interactions.closeAll("shutdown");
      if (directoryTimer) clearTimeout(directoryTimer);
      for (const client of clients) client.end();
      clients.clear();
      sessions.clear();
    },
  };
}

