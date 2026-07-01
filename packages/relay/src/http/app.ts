import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";

import { MSG, type LiveTurnSnapshotDto, type SessionCommandsSnapshotDto, type SessionUsageSnapshotDto } from "@ganglion/xacpx-relay-protocol";

import type { AccountRow, AccountStore } from "../stores/accounts.js";
import type { InstanceStore } from "../stores/instances.js";
import type { MessageStore } from "../stores/messages.js";
import { clientIp } from "./client-ip.js";
import { readRelayVersion, type UpdateCheck } from "../version.js";

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
  MSG.scheduledList, MSG.scheduledCreate, MSG.scheduledCancel,
  // Session ops are chat-scoped too: created sessions must land in the same
  // `relay:<accountId>` channel scope that prompt/list resolve against, else a
  // freshly created session is unreachable by a subsequent prompt.
  MSG.sessionsList, MSG.sessionsCreate, MSG.sessionsNativeList, MSG.sessionsRemove,
  // Archive/unarchive resolve the alias within the caller's chat scope too; without
  // the stamp the connector calls getChannelIdFromChatKey(undefined) and throws.
  MSG.sessionsArchive, MSG.sessionsUnarchive,
  // Model get/set resolve the session within the caller's chat scope.
  MSG.sessionModelGet, MSG.sessionModelSet,
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

type Vars = { Variables: { account: AccountRow } };

export function createApp(deps: AppDeps): Hono<Vars> {
  const sessionTtlMs = deps.sessionTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const pairingTtlMs = deps.pairingTtlMs ?? 10 * 60 * 1000;
  const trustProxy = deps.trustProxy ?? false;
  const now = deps.now ?? (() => new Date());

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
      return c.json({ error: "too-many-attempts" }, 429);
    }

    const r = deps.accounts.resolveLoginToken(body.token ?? "");
    if (!r) {
      recordFailure(ip, nowMs);
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

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login") return next();
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
    try {
      if (body.type === MSG.upload) {
        const up = payload as { content?: string };
        const approxBytes = up.content ? Math.floor((up.content.length * 3) / 4) : 0;
        if (approxBytes > 10 * 1024 * 1024) return c.json({ error: "file-too-large" }, 413);
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
          deps.messages.append(instance.id, p.sessionAlias, "in", p.text, undefined, attachments);
        }
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
