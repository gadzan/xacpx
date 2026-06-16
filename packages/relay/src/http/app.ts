import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";

import { MSG, type LiveTurnSnapshotDto } from "@ganglion/xacpx-relay-protocol";

import type { AccountRow, AccountStore } from "../stores/accounts.js";
import type { InstanceStore } from "../stores/instances.js";
import type { MessageStore } from "../stores/messages.js";

export interface GatewayForApp {
  isOnline(instanceId: string): boolean;
  sendRequest(instanceId: string, type: string, payload: unknown): Promise<unknown>;
}

export interface AppDeps {
  accounts: AccountStore;
  instances: InstanceStore;
  gateway: GatewayForApp;
  messages: MessageStore;
  /** Snapshot the in-flight turns for an instance (for the active-turns endpoint). */
  activeTurns?: (instanceId: string) => LiveTurnSnapshotDto[];
  webRoot?: string;
  sessionTtlMs?: number;
  inviteTtlMs?: number;
  pairingTtlMs?: number;
  historyRetentionDays?: number;
  maxMessagesPerSession?: number;
  now?: () => Date;
}

const SESSION_COOKIE = "xrelay_session";
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_FAILURES_SWEEP_AT = 1024;
const LOGIN_FAILURES_MAX = 4096;

/** Chat-scoped control RPCs get chatKey/senderId/isOwner stamped server-side. */
const CHAT_SCOPED_TYPES = new Set<string>([
  MSG.prompt, MSG.promptCancel, MSG.commandExecute,
  MSG.scheduledList, MSG.scheduledCreate, MSG.scheduledCancel,
  // Session ops are chat-scoped too: created sessions must land in the same
  // `relay:<accountId>` channel scope that prompt/list resolve against, else a
  // freshly created session is unreachable by a subsequent prompt.
  MSG.sessionsList, MSG.sessionsCreate, MSG.sessionsNativeList, MSG.sessionsRemove,
  // Model get/set resolve the session within the caller's chat scope.
  MSG.sessionModelGet, MSG.sessionModelSet,
]);

function requireJson(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("application/json");
}

type Vars = { Variables: { account: AccountRow } };

export function createApp(deps: AppDeps): Hono<Vars> {
  const sessionTtlMs = deps.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const inviteTtlMs = deps.inviteTtlMs ?? 24 * 60 * 60 * 1000;
  const pairingTtlMs = deps.pairingTtlMs ?? 10 * 60 * 1000;
  const now = deps.now ?? (() => new Date());
  const loginFailures = new Map<string, { count: number; windowStart: number }>();

  const app = new Hono<Vars>();

  app.post("/api/login", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
    const username = body.username ?? "";
    const nowMs = now().getTime();
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
    const failures = loginFailures.get(username);
    if (failures && nowMs - failures.windowStart < LOGIN_WINDOW_MS && failures.count >= LOGIN_MAX_FAILURES) {
      return c.json({ error: "too-many-attempts" }, 429);
    }
    const account = deps.accounts.verifyLogin(username, body.password ?? "");
    if (!account) {
      const entry = failures && nowMs - failures.windowStart < LOGIN_WINDOW_MS
        ? { count: failures.count + 1, windowStart: failures.windowStart }
        : { count: 1, windowStart: nowMs };
      loginFailures.set(username, entry);
      return c.json({ error: "invalid-credentials" }, 401);
    }
    loginFailures.delete(username);
    const token = deps.accounts.createWebSession(account.id, sessionTtlMs);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "Lax", path: "/", maxAge: Math.floor(sessionTtlMs / 1000),
    });
    return c.json({ username: account.username, role: account.role });
  });

  app.post("/api/register", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const body = (await c.req.json().catch(() => ({}))) as { invite?: string; username?: string; password?: string };
    if (!body.invite || !body.username || !body.password) return c.json({ error: "missing-fields" }, 400);
    if (!deps.accounts.validateInvite(body.invite)) return c.json({ error: "invalid-invite" }, 403);
    if (deps.accounts.findByUsername(body.username)) return c.json({ error: "username-taken" }, 409);
    const account = deps.accounts.createAccount(body.username, body.password, "member");
    deps.accounts.markInviteUsed(body.invite, account.id);
    return c.json({ username: account.username, role: account.role });
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login" || c.req.path === "/api/register") return next();
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
    return c.json({ username: account.username, role: account.role });
  });

  app.get("/api/config", (c) => {
    return c.json({
      historyRetention: {
        days: deps.historyRetentionDays ?? 30,
        maxPerSession: deps.maxMessagesPerSession ?? 2000,
      },
    });
  });

  app.post("/api/invites", (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const account = c.get("account");
    if (account.role !== "admin") return c.json({ error: "admin-only" }, 403);
    const invite = deps.accounts.createInvite(account.id, inviteTtlMs);
    return c.json({ invite: invite.token, expiresAt: invite.expiresAt });
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

  app.delete("/api/instances/:id", (c) => {
    const account = c.get("account");
    const removed = deps.instances.remove(c.req.param("id"), account.id);
    return removed ? c.json({ ok: true }) : c.json({ error: "not-found" }, 404);
  });

  // In-flight turns across all of the account's instances, so a refreshed web client
  // restores live HUDs / streaming bubbles / "working" dots without waiting for finish.
  app.get("/api/active-turns", (c) => {
    const account = c.get("account");
    const turns: LiveTurnSnapshotDto[] = [];
    for (const inst of deps.instances.listByAccount(account.id)) {
      for (const t of deps.activeTurns?.(inst.id) ?? []) turns.push(t);
    }
    return c.json({ turns });
  });

  app.get("/api/instances/:id/sessions/:alias/messages", (c) => {
    const account = c.get("account");
    const instance = deps.instances.getOwned(c.req.param("id"), account.id);
    if (!instance) return c.json({ error: "not-found" }, 404);
    // Cursor pagination: `before` = oldest id the client already has (load older);
    // `limit` is clamped to [1, 200]. Both optional — omitted = most recent page.
    const limitRaw = Number(c.req.query("limit"));
    const beforeRaw = Number(c.req.query("before"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 100;
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : undefined;
    const page = deps.messages.listBySession(account.id, instance.id, c.req.param("alias"), {
      limit,
      ...(before !== undefined ? { before } : {}),
    });
    return c.json(page);
  });

  app.post("/api/instances/:id/rpc", async (c) => {
    if (!requireJson(c.req.header("content-type"))) return c.json({ error: "unsupported-media-type" }, 415);
    const account = c.get("account");
    const instance = deps.instances.getOwned(c.req.param("id"), account.id);
    if (!instance) return c.json({ error: "not-found" }, 404);
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
    try {
      // Persist the inbound user message BEFORE awaiting the turn: sendRequest
      // resolves only after the agent's turn-finished event has already
      // persisted the "out" message, so appending "in" afterwards would give it
      // a higher autoincrement id and flip the history order.
      if (body.type === MSG.prompt || body.type === MSG.commandExecute) {
        const p = payload as { sessionAlias?: string; text?: string };
        if (p.sessionAlias && p.text) deps.messages.append(instance.id, p.sessionAlias, "in", p.text);
      }
      const result = await deps.gateway.sendRequest(instance.id, body.type, payload);
      if (body.type === MSG.commandExecute) {
        const p = payload as { sessionAlias?: string; text?: string };
        const output = (result as { output?: string } | undefined)?.output;
        if (p.sessionAlias && typeof output === "string") deps.messages.append(instance.id, p.sessionAlias, "out", output);
      }
      return c.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "instance-offline") return c.json({ error: message }, 503);
      if (message === "timeout") return c.json({ error: message }, 504);
      return c.json({ error: message }, 500);
    }
  });

  if (deps.webRoot) {
    const root = deps.webRoot;
    app.use("/*", serveStatic({ root }));
    app.get("/*", serveStatic({ path: "index.html", root })); // SPA fallback
  }

  return app;
}
