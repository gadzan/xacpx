import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";

import {
  isErrorPayload,
  MSG,
  parseControlPayload,
  type LiveTurnSnapshotDto,
  type PublishedAgentEndpointDto,
  type SessionCommandsSnapshotDto,
  type SessionUsageSnapshotDto,
  type WebAgentDirectoryEndpointDto,
} from "@ganglion/xacpx-relay-protocol";

import type { AccountRow, AccountStore } from "../stores/accounts.js";
import type { InstanceStore } from "../stores/instances.js";
import type { MessageStore } from "../stores/messages.js";
import type { PushSubscriptionStore } from "../stores/push-subscriptions.js";
import { isAllowedPushEndpoint } from "../push.js";
import type { RelayLogger } from "../logging.js";
import { clientIp } from "./client-ip.js";
import { compactHistoryMessage } from "./compact-history.js";
import { readRelayVersion, type UpdateCheck } from "../version.js";

export interface GatewayForApp {
  isOnline(instanceId: string): boolean;
  sendRequest(instanceId: string, type: string, payload: unknown): Promise<unknown>;
  getPublishedEndpoints(accountId: string): PublishedAgentEndpointDto[];
  getWebPublishedEndpoints?(accountId: string): WebAgentDirectoryEndpointDto[];
}

export interface AppDeps {
  accounts: AccountStore;
  instances: InstanceStore;
  gateway: GatewayForApp;
  messages: MessageStore;
  /** Snapshot the in-flight turns for an instance (for the active-turns endpoint). */
  activeTurns?: (instanceId: string) => LiveTurnSnapshotDto[];
  /** Snapshot the latest per-session context-usage for an instance (for the active-turns endpoint). */
  sessionUsage?: (instanceId: string) => SessionUsageSnapshotDto[];
  /** Snapshot the latest per-session agent-advertised commands for an instance (for the active-turns endpoint). */
  sessionCommands?: (instanceId: string) => SessionCommandsSnapshotDto[];
  webRoot?: string;
  sessionTtlMs?: number;
  pairingTtlMs?: number;
  historyRetentionDays?: number;
  maxMessagesPerSession?: number;
  /** Returns the hub's current version + whether a newer one is published. Injected
   *  by server.ts (cached). When omitted, /api/version reports current-only. */
  checkUpdate?: () => Promise<UpdateCheck>;
  trustProxy?: boolean;
  now?: () => Date;
  logger?: RelayLogger;
  /** Web push: current VAPID public key, or null when push is not configured. */
  vapidPublicKey?: () => string | null;
  /** Web push: browser subscription storage; omitted = push routes 503. */
  pushSubscriptions?: PushSubscriptionStore;
}

const SESSION_COOKIE = "xrelay_session";
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;
const LOGIN_FAILURES_SWEEP_AT = 1024;
const LOGIN_FAILURES_MAX = 4096;
// Global failure ceiling: total failed /api/login attempts across all IPs per window.
// Backstop so varied-IP / XFF-spoofing floods cannot fully bypass per-IP throttling.
export const GLOBAL_MAX_FAILURES = 200;

/** Chat-scoped control RPCs get chatKey/senderId/isOwner stamped server-side. */
const CHAT_SCOPED_TYPES = new Set<string>([
  MSG.prompt, MSG.promptCancel, MSG.commandExecute,
  // Cancelling a queued item resolves the queue within the caller's chat scope; without
  // the stamp the connector gets `chatKey: undefined` and cancelQueuedItem misses the queue.
  MSG.queueCancel,
  MSG.scheduledList, MSG.scheduledCreate, MSG.scheduledCancel,
  // Session ops are chat-scoped too: created sessions must land in the same
  // `relay:<accountId>` channel scope that prompt/list resolve against, else a
  // freshly created session is unreachable by a subsequent prompt.
  MSG.sessionsList, MSG.sessionsCreate, MSG.sessionsNativeList, MSG.sessionsRemove,
  // Archive/unarchive resolve the alias within the caller's chat scope too; without
  // the stamp the connector calls getChannelIdFromChatKey(undefined) and throws.
  MSG.sessionsArchive, MSG.sessionsUnarchive,
  // Rename resolves the alias within the caller's chat scope too; the connector's
  // payload validator requires chatKey, so an unstamped rename fails as invalid-payload.
  MSG.sessionsRename,
  // Model and effort get/set resolve the session within the caller's chat scope.
  MSG.sessionModelGet, MSG.sessionModelSet, MSG.sessionEffortGet, MSG.sessionEffortSet,
  // Terminal create carries sessionAlias; stamp chatKey/senderId/isOwner so the
  // connector can resolve the session within the caller's chat scope.
  MSG.terminalCreate,
]);

function requireJson(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("application/json");
}

/** Accept a persisted attachment preview only if it's a small image data URL. */
function safePreviewUrl(v: unknown): string | undefined {
  if (typeof v === "string" && v.startsWith("data:image/") && v.length <= 256 * 1024) {
    return v;
  }
  return undefined;
}

// Coarse pre-buffer ceiling for /rpc bodies: a 10MB upload as base64 inside a JSON
// envelope is ~13.33MB; 16MB leaves headroom for envelope overhead.
const RPC_MAX_BODY_BYTES = 16 * 1024 * 1024;
// Design spec caps attachments at ≤5 per message; bound persisted string fields too
// so arbitrarily long filename/mimeType can't bloat storage.
const MAX_PERSISTED_ATTACHMENTS = 5;
const MAX_ATTACHMENT_FIELD_LEN = 256;

/** Truncate a persisted attachment string field to a bounded length. */
function boundField<T extends string | undefined>(v: T): T {
  return (typeof v === "string" ? v.slice(0, MAX_ATTACHMENT_FIELD_LEN) : v) as T;
}

type SessionRpcLocks = {
  alias: string;
  lifecycle: boolean;
  turn: "none" | "shared" | "exclusive";
};

// Prompts take the turn lock in SHARED mode: concurrent prompts must reach the
// connector while a turn is running so its TurnQueue can see the busy session and
// enqueue them (exclusive mode would serialize prompt-vs-prompt at the hub and the
// queue would never engage). Lifecycle operations take the turn lock exclusively so
// they still wait for running turns, plus the lifecycle lock so they cannot race
// each other. Rename only serializes with lifecycle operations, not turns.
function rpcSessionLocks(type: string, payload: unknown): SessionRpcLocks | undefined {
  const value = payload as { alias?: unknown; sessionAlias?: unknown };
  if (type === MSG.prompt) {
    return typeof value.sessionAlias === "string" && value.sessionAlias
      ? { alias: value.sessionAlias, lifecycle: false, turn: "shared" }
      : undefined;
  }
  if (type === MSG.commandExecute) {
    return typeof value.sessionAlias === "string" && value.sessionAlias
      ? { alias: value.sessionAlias, lifecycle: false, turn: "exclusive" }
      : undefined;
  }
  if (type === MSG.sessionsRename) {
    return typeof value.alias === "string" && value.alias
      ? { alias: value.alias, lifecycle: true, turn: "none" }
      : undefined;
  }
  if (
    type === MSG.sessionsCreate ||
    type === MSG.sessionsRemove ||
    type === MSG.sessionsArchive ||
    type === MSG.sessionsUnarchive
  ) {
    return typeof value.alias === "string" && value.alias
      ? { alias: value.alias, lifecycle: true, turn: "exclusive" }
      : undefined;
  }
  return undefined;
}

function createKeyedRpcLock(): (key: string) => Promise<() => void> {
  const tails = new Map<string, Promise<void>>();
  return async (key: string) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
      if (tails.get(key) === tail) tails.delete(key);
    };
  };
}

// Keyed read-write lock: shared holders run concurrently; an exclusive holder waits
// for every prior holder and blocks later acquirers. A shared acquirer arriving after
// a queued exclusive opens a NEW group behind it (FIFO, so writers are never starved).
function createKeyedRwLock(): {
  acquireShared: (key: string) => Promise<() => void>;
  acquireExclusive: (key: string) => Promise<() => void>;
} {
  type SharedGroup = { count: number; settle: () => void; start: Promise<void> };
  const tails = new Map<string, Promise<void>>();
  const openShared = new Map<string, SharedGroup>();

  function setTail(key: string, tail: Promise<void>): void {
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
  }

  return {
    async acquireExclusive(key: string) {
      // Close the joinable group: shared acquirers arriving after this writer must
      // queue behind it instead of piggybacking on the running group.
      openShared.delete(key);
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      setTail(key, previous.then(() => held));
      await previous;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
      };
    },
    async acquireShared(key: string) {
      let group = openShared.get(key);
      if (!group) {
        const previous = tails.get(key) ?? Promise.resolve();
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        group = { count: 0, settle, start: previous };
        openShared.set(key, group);
        setTail(key, previous.then(() => settled));
      }
      group.count += 1;
      const g = group;
      await g.start;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        g.count -= 1;
        if (g.count === 0) {
          if (openShared.get(key) === g) openShared.delete(key);
          g.settle();
        }
      };
    },
  };
}

type Vars = { Variables: { account: AccountRow } };

export function createApp(deps: AppDeps): Hono<Vars> {
  const sessionTtlMs = deps.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const pairingTtlMs = deps.pairingTtlMs ?? 10 * 60 * 1000;
  const trustProxy = deps.trustProxy ?? false;
  const now = deps.now ?? (() => new Date());
  const acquireSessionLifecycleRpcLock = createKeyedRpcLock();
  const sessionTurnRpcLock = createKeyedRwLock();

  // Per-IP failure tracking
  const loginFailures = new Map<string, { count: number; windowStart: number }>();
  // Global failure window counter (single entry; reset on window expiry)
  let globalFailures: { count: number; windowStart: number } = { count: 0, windowStart: 0 };

  /**
   * Sweep stale entries from the per-IP failure Map when it grows oversized.
   * Only touches the per-IP Map; the global counter resets lazily in recordFailure.
   */
  function sweepPerIpLoginFailures(nowMs: number): void {
    if (loginFailures.size > LOGIN_FAILURES_SWEEP_AT) {
      for (const [k, v] of loginFailures) {
        if (nowMs - v.windowStart >= LOGIN_WINDOW_MS) loginFailures.delete(k);
      }
      // hard backstop: if still oversized, drop oldest-window entries
      if (loginFailures.size > LOGIN_FAILURES_MAX) {
        const sorted = [...loginFailures.entries()].sort((a, b) => a[1].windowStart - b[1].windowStart);
        for (let i = 0; i < sorted.length && loginFailures.size > LOGIN_FAILURES_MAX; i++) {
          const entry = sorted[i];
          if (entry) loginFailures.delete(entry[0]);
        }
      }
    }
  }

  /** Record a login failure for both the per-IP bucket and the global counter. */
  function recordFailure(ip: string, nowMs: number): void {
    // Per-IP bucket
    const perIp = loginFailures.get(ip);
    const ipEntry = perIp && nowMs - perIp.windowStart < LOGIN_WINDOW_MS
      ? { count: perIp.count + 1, windowStart: perIp.windowStart }
      : { count: 1, windowStart: nowMs };
    loginFailures.set(ip, ipEntry);

    // Global counter — reset if window expired
    if (nowMs - globalFailures.windowStart >= LOGIN_WINDOW_MS) {
      globalFailures = { count: 1, windowStart: nowMs };
    } else {
      globalFailures = { count: globalFailures.count + 1, windowStart: globalFailures.windowStart };
    }
  }

  /** Check whether this IP (or the global ceiling) is already rate-limited. */
  function isRateLimited(ip: string, nowMs: number): boolean {
    // Global ceiling check
    if (nowMs - globalFailures.windowStart < LOGIN_WINDOW_MS && globalFailures.count >= GLOBAL_MAX_FAILURES) {
      return true;
    }
    // Per-IP check
    const perIp = loginFailures.get(ip);
    return !!(perIp && nowMs - perIp.windowStart < LOGIN_WINDOW_MS && perIp.count >= LOGIN_MAX_FAILURES);
  }

  const app = new Hono<Vars>();

  app.post("/api/login", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    const nowMs = now().getTime();

    sweepPerIpLoginFailures(nowMs);

    const ip = clientIp(c, trustProxy);

    if (isRateLimited(ip, nowMs)) {
      deps.logger?.info("relay.login.rejected", "login rejected", { reason: "rate-limited", ip });
      return c.json({ error: "too-many-attempts" }, 429);
    }

    const r = deps.accounts.resolveLoginToken(body.token ?? "");
    if (!r) {
      recordFailure(ip, nowMs);
      deps.logger?.info("relay.login.rejected", "login rejected", { reason: "invalid-token", ip });
      return c.json({ error: "invalid-token" }, 401);
    }

    // Intentionally do NOT clear the per-IP failure bucket on success: on a shared
    // IP (NAT), one user's success must not launder away an attacker's accumulated
    // failures. The per-IP window expiry is the only reset path.
    const sess = deps.accounts.createWebSession(r.account.id, r.loginTokenId, sessionTtlMs);
    setCookie(c, SESSION_COOKIE, sess, {
      httpOnly: true, sameSite: "Lax", path: "/", maxAge: Math.floor(sessionTtlMs / 1000),
    });
    return c.json({ username: r.account.username });
  });

  // Tombstone: /api/register + /api/invites removed; explicit 404 registered before
  // the /api/* auth gate so unauthenticated calls see 404, not 401.
  app.post("/api/register", (c) => c.json({ error: "not-found" }, 404));
  app.post("/api/invites", (c) => c.json({ error: "not-found" }, 404));

  // Public: redeem a CLI-minted invite code for a brand-new account + login token.
  // Registered BEFORE the /api/* auth gate (same mechanism as /api/login and the
  // tombstones). Shares the login failure buckets: code guessing = token guessing.
  // No session cookie on success — the token is the artifact the user must save.
  app.post("/api/invites/redeem", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const body = (await c.req.json().catch(() => ({}))) as { code?: string };
    const nowMs = now().getTime();

    sweepPerIpLoginFailures(nowMs);

    const ip = clientIp(c, trustProxy);

    if (isRateLimited(ip, nowMs)) {
      deps.logger?.info("relay.invite.rejected", "invite redeem rejected", { reason: "rate-limited", ip });
      return c.json({ error: "too-many-attempts" }, 429);
    }

    const r = deps.accounts.redeemInviteCode(typeof body.code === "string" ? body.code : "");
    if (!r) {
      recordFailure(ip, nowMs);
      deps.logger?.info("relay.invite.rejected", "invite redeem rejected", { reason: "invalid-code", ip });
      return c.json({ error: "invalid-code" }, 401);
    }

    deps.logger?.info("relay.invite.redeemed", "invite redeemed", { accountId: r.accountId });
    return c.json({ token: r.token, username: r.username });
  });

  app.use("/api/*", async (c, next) => {
    // Belt-and-braces exemptions mirroring the pre-gate registrations above;
    // registration order alone already keeps these public, but if the gate is
    // ever hoisted the exemption keeps behavior identical.
    if (c.req.path === "/api/login" || c.req.path === "/api/invites/redeem") return next();
    const token = getCookie(c, SESSION_COOKIE);
    const account = token ? deps.accounts.getSessionAccount(token) : null;
    if (!account) return c.json({ error: "unauthorized" }, 401);
    c.set("account", account);
    return next();
  });

  app.post("/api/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deps.accounts.deleteWebSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => {
    const account = c.get("account");
    return c.json({ username: account.username });
  });

  app.get("/api/config", (c) => {
    return c.json({
      historyRetention: {
        days: deps.historyRetentionDays ?? 30,
        maxPerSession: deps.maxMessagesPerSession ?? 2000,
      },
    });
  });

  app.get("/api/version", async (c) => {
    const check = deps.checkUpdate
      ?? (async (): Promise<UpdateCheck> => ({ current: readRelayVersion(), latest: null, updateAvailable: false }));
    return c.json(await check());
  });
  app.get("/api/web-push/vapid-public-key", (c) => {
    return c.json({ publicKey: deps.vapidPublicKey ? deps.vapidPublicKey() : null });
  });

  app.put("/api/web-push/subscriptions", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    if (!deps.pushSubscriptions) return c.json({ error: "push-disabled" }, 503);
    const account = c.get("account");
    const body = (await c.req.json().catch(() => ({}))) as {
      endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown };
    };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
    const auth = typeof body.keys?.auth === "string" ? body.keys.auth : "";
    // Blind-SSRF guard: the hub POSTes to each stored endpoint from its own
    // network. Only known browser push-service origins are accepted — an
    // arbitrary client-supplied HTTPS URL would be a server-side POST primitive.
    const allowedEndpoint = isAllowedPushEndpoint(endpoint);
    if (!allowedEndpoint || !p256dh || !auth || endpoint.length > 2048 || p256dh.length > 512 || auth.length > 512) {
      return c.json({ error: "invalid-payload" }, 400);
    }
    deps.pushSubscriptions.upsert({ accountId: account.id, endpoint, p256dh, auth });
    return c.json({ ok: true });
  });

  app.delete("/api/web-push/subscriptions", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    if (!deps.pushSubscriptions) return c.json({ error: "push-disabled" }, 503);
    const account = c.get("account");
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint || endpoint.length > 2048) return c.json({ error: "invalid-payload" }, 400);
    deps.pushSubscriptions.deleteByEndpointAndAccount(account.id, endpoint);
    return c.json({ ok: true });
  });

  app.get("/api/instances", (c) => {
    const account = c.get("account");
    const rows = deps.instances.listByAccount(account.id).map((row) => ({
      ...row,
      online: deps.gateway.isOnline(row.id),
    }));
    return c.json({ instances: rows });
  });

  app.post("/api/instances/pairing-token", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const account = c.get("account");
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const issued = deps.instances.issuePairingToken(account.id, body.name, pairingTtlMs);
    return c.json({ token: issued.token, expiresAt: issued.expiresAt });
  });

  app.patch("/api/instances/:id", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const account = c.get("account");
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const name = (body.name ?? "").trim();
    if (!name) return c.json({ error: "invalid-name" }, 400);
    const ok = deps.instances.rename(c.req.param("id"), account.id, name);
    return ok ? c.json({ ok: true }) : c.json({ error: "not-found" }, 404);
  });

  app.delete("/api/instances/:id", (c) => {
    const account = c.get("account");
    const removed = deps.instances.remove(c.req.param("id"), account.id);
    return removed ? c.json({ ok: true }) : c.json({ error: "not-found" }, 404);
  });
  app.get("/api/agent-directory", (c) => {
    const account = c.get("account");
    const endpoints = deps.gateway.getWebPublishedEndpoints
      ? deps.gateway.getWebPublishedEndpoints(account.id)
      : deps.gateway.getPublishedEndpoints(account.id);
    return c.json({ endpoints });
  });

  // In-flight turns across all of the account's instances, so a refreshed web client
  // restores live HUDs / streaming bubbles / "working" dots without waiting for finish.
  app.get("/api/active-turns", (c) => {
    const account = c.get("account");
    const turns: LiveTurnSnapshotDto[] = [];
    const usage: SessionUsageSnapshotDto[] = [];
    const commands: SessionCommandsSnapshotDto[] = [];
    for (const inst of deps.instances.listByAccount(account.id)) {
      for (const t of deps.activeTurns?.(inst.id) ?? []) turns.push(t);
      for (const u of deps.sessionUsage?.(inst.id) ?? []) usage.push(u);
      for (const cmd of deps.sessionCommands?.(inst.id) ?? []) commands.push(cmd);
    }
    return c.json({ turns, usage, commands });
  });

  app.get("/api/instances/:id/sessions/:alias/messages/:messageId", (c) => {
    const account = c.get("account");
    const instance = deps.instances.getOwned(c.req.param("id"), account.id);
    if (!instance) return c.json({ error: "not-found" }, 404);
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId) || messageId <= 0) return c.json({ error: "not-found" }, 404);
    const message = deps.messages.getById(account.id, instance.id, c.req.param("alias"), Math.floor(messageId));
    if (!message) return c.json({ error: "not-found" }, 404);
    return c.json({ message });
  });

  app.get("/api/instances/:id/sessions/:alias/messages", (c) => {
    const account = c.get("account");
    const instance = deps.instances.getOwned(c.req.param("id"), account.id);
    if (!instance) return c.json({ error: "not-found" }, 404);
    // Cursor pagination: `before` = oldest id the client already has (load older);
    // `limit` is clamped to [1, 200]. Both optional — omitted = most recent page.
    // `view=compact` strips bulky tool details (diffs/output) for first-paint; the
    // full row is available from GET .../messages/:messageId. Omitted = full rows
    // so older web clients keep expanding tool cards without a hydrate round-trip.
    const limitRaw = Number(c.req.query("limit"));
    const beforeRaw = Number(c.req.query("before"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : undefined;
    const page = deps.messages.listBySession(account.id, instance.id, c.req.param("alias"), {
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    if (c.req.query("view") === "compact") {
      return c.json({ ...page, messages: page.messages.map(compactHistoryMessage) });
    }
    return c.json(page);
  });

  app.post("/api/instances/:id/rpc", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const account = c.get("account");
    const instance = deps.instances.getOwned(c.req.param("id"), account.id);
    if (!instance) return c.json({ error: "not-found" }, 404);
    // Coarse pre-buffer guard for ALL rpc types: reject by Content-Length before we
    // read+JSON-parse the whole body into memory. Ceiling accommodates a 10MB upload
    // encoded as base64 inside a JSON envelope (10MB → ~13.33MB base64 + overhead).
    // Missing/unparseable Content-Length falls through — the precise MSG.upload
    // decoded-size check below still bounds uploads.
    const contentLength = Number(c.req.header("content-length"));
    if (Number.isFinite(contentLength) && contentLength > RPC_MAX_BODY_BYTES) {
      return c.json({ error: "payload-too-large" }, 413);
    }
    const body = (await c.req.json().catch(() => ({}))) as { type?: string; payload?: unknown };
    if (!body.type || !body.type.startsWith("control.")) return c.json({ error: "invalid-rpc-type" }, 400);
    let payload = body.payload ?? {};
    if (CHAT_SCOPED_TYPES.has(body.type)) {
      payload = {
        ...(payload as Record<string, unknown>),
        chatKey: `relay:${account.id}`,
        senderId: account.id,
        isOwner: true,
      };
    }
    const releaseSessionRpcLocks: Array<() => void> = [];
    let persistedPromptId: number | undefined;
    try {
      // Shape-validate the RPCs the hub persists BEFORE forwarding, so a malformed frame
      // can't poison history ahead of the connector's own boundary check. Error body carries
      // no payload contents (privacy). Other control.* types are validated at the connector.
      if (body.type === MSG.prompt && !parseControlPayload(MSG.prompt, payload)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      if (body.type === MSG.commandExecute && !parseControlPayload(MSG.commandExecute, payload)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      if (body.type === MSG.upload && !parseControlPayload(MSG.upload, payload)) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      const removeInput = body.type === MSG.sessionsRemove
        ? parseControlPayload(MSG.sessionsRemove, payload)
        : undefined;
      if (body.type === MSG.sessionsRemove && !removeInput) {
        return c.json({ error: "invalid-payload" }, 400);
      }
      if (body.type === MSG.upload) {
        const up = payload as { content?: string };
        const approxBytes = up.content ? Math.floor((up.content.length * 3) / 4) : 0;
        if (approxBytes > 10 * 1024 * 1024) return c.json({ error: "file-too-large" }, 413);
      }
      const sessionLocks = rpcSessionLocks(body.type, payload);
      if (sessionLocks) {
        const key = `${instance.id}\0${sessionLocks.alias}`;
        // Lifecycle first: if a destructive operation is queued behind a running
        // turn, later renames queue behind that operation instead of overtaking it.
        if (sessionLocks.lifecycle) {
          releaseSessionRpcLocks.push(await acquireSessionLifecycleRpcLock(key));
        }
        if (sessionLocks.turn === "shared") {
          releaseSessionRpcLocks.push(await sessionTurnRpcLock.acquireShared(key));
        } else if (sessionLocks.turn === "exclusive") {
          releaseSessionRpcLocks.push(await sessionTurnRpcLock.acquireExclusive(key));
        }
      }
      // Persist the inbound user message BEFORE awaiting the turn: sendRequest
      // resolves only after the agent's turn-finished event has already
      // persisted the "out" message, so appending "in" afterwards would give it
      // a higher autoincrement id and flip the history order.
      if (body.type === MSG.prompt || body.type === MSG.commandExecute) {
        const p = payload as { sessionAlias?: string; text?: string; media?: import("@ganglion/xacpx-relay-protocol").PromptAttachmentRef[] };
        if (p.sessionAlias && p.text !== undefined) {
          // Cap count (≤5 per spec) and bound string fields so a malicious client
          // can't bloat storage. Only affects what's persisted; the forwarded turn
          // payload (sendRequest below) keeps the original media untouched.
          const attachments = (p.media ?? []).slice(0, MAX_PERSISTED_ATTACHMENTS).map((m) => {
            const previewUrl = safePreviewUrl(m.previewUrl);
            return {
              id: m.id,
              filename: boundField(m.fileName),
              mimeType: boundField(m.mimeType),
              size: m.size,
              kind: m.kind,
              ...(previewUrl ? { previewUrl } : {}),
            };
          });
          // The request id is generated HERE, before the RPC, and stored on the row:
          // if the queued response is lost (restart / dropped frame), the connector's
          // queue item still correlates back to this exact row via promptRequestId —
          // text matching cannot distinguish a redelivery from a duplicate prompt.
          const promptRequestId = randomUUID();
          persistedPromptId = deps.messages.append(instance.id, p.sessionAlias, "in", p.text, undefined, attachments, promptRequestId);
          if (body.type === MSG.prompt && typeof payload === "object" && payload !== null) {
            (payload as Record<string, unknown>).promptRequestId = promptRequestId;
          }
        }
      }
      const result = await deps.gateway.sendRequest(instance.id, body.type, payload);
      if (body.type === MSG.prompt && persistedPromptId !== undefined
        && typeof result === "object" && result !== null
        && (result as { queued?: unknown }).queued === true
        && typeof (result as { queueItemId?: unknown }).queueItemId === "string") {
        const p = payload as { sessionAlias: string };
        deps.messages.markQueued(persistedPromptId, {
          instanceId: instance.id,
          sessionAlias: p.sessionAlias,
          queueItemId: (result as { queueItemId: string }).queueItemId,
        });
      }
      // A real delete has two histories: the connector-owned acpx record and the
      // Hub-owned Web transcript. Purge the latter only after the connector confirms
      // success; archive intentionally keeps both histories.
      if (removeInput && !isErrorPayload(result)) {
        deps.messages.deleteBySession(instance.id, removeInput.alias);
      }
      if (body.type === MSG.commandExecute) {
        const p = payload as { sessionAlias?: string; text?: string };
        const output = (result as { output?: string } | undefined)?.output;
        if (p.sessionAlias && typeof output === "string") deps.messages.append(instance.id, p.sessionAlias, "out", output);
      }
      return c.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 503: transient availability — the instance is offline, or the connection was
      // superseded by a reconnect before the RPC could be answered (the caller may
      // retry). 504: the request budget expired. Anything else is a server error.
      if (message === "instance-offline" || message === "instance-reconnected") return c.json({ error: message }, 503);
      if (message === "timeout") return c.json({ error: message }, 504);
      return c.json({ error: message }, 500);
    } finally {
      for (let i = releaseSessionRpcLocks.length - 1; i >= 0; i--) {
        releaseSessionRpcLocks[i]?.();
      }
    }
  });

  if (deps.webRoot) {
    const root = deps.webRoot;
    // Cache policy for the bundled dashboard: content-hashed build assets under
    // /assets/ are immutable and cached for a year, while the app shell (index.html,
    // the service worker, the manifest) must always be revalidated so a deploy is
    // picked up immediately instead of being served stale from the browser's HTTP
    // cache. Without this, `serveStatic` sets no Cache-Control and the browser
    // heuristically caches the shell + sw.js, delaying PWA updates.
    app.use("/*", async (c, next) => {
      await next();
      const path = c.req.path;
      if (path.startsWith("/api") || path.startsWith("/ws")) return;
      if (!c.res.ok) return;
      // Only fingerprinted build assets are immutable. Gate on content-type, not
      // just the path: a request for a missing /assets/<hash> falls through to the
      // SPA fallback and returns the index.html shell (text/html) with 200 — that
      // must stay no-cache, never get stamped immutable under an asset URL.
      const isHtml = (c.res.headers.get("content-type") ?? "").includes("text/html");
      c.header(
        "Cache-Control",
        !isHtml && path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    });
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ path: "index.html", root })); // SPA fallback
  }

  return app;
}
