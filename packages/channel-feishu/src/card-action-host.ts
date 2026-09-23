/**
 * Feishu card-action callback channel.
 *
 * WHY THIS EXISTS
 *
 * Feishu delivers interactive-card events (button clicks, form submits) as
 * *callbacks*, and the plugin's existing inbound channel is a WebSocket long
 * connection that subscribes to *events* only. Per the SDK README
 * (node_modules/@larksuiteoapi/node-sdk/README.md:550):
 *
 *   "Currently, the long connection mode only supports event subscriptions and
 *    does not support callback subscriptions"
 *
 * So there is no way to receive card interactions over the existing transport.
 * They arrive as HTTP POSTs to a webhook URL, which this module hosts.
 *
 * WHAT MAKES IT AUTHENTICATED
 *
 * A webhook endpoint is inert unless the request really came from Feishu. The
 * SDK's `CardActionHandler` performs the verification itself: with `encryptKey`
 * set it rejects bodies it cannot decrypt (proving the sender holds the key
 * agreed during app configuration), and with `verificationToken` set it rejects
 * bodies whose `token` field does not match. Both are app-secret material
 * configured out-of-band in the Feishu open platform console — never something
 * a client can choose.
 *
 * A signature/encrypt check proves *Feishu sent this*. It does NOT by itself
 * prove *which user acted*: the acting user is `operator.open_id` in the
 * decrypted body, which is payload text. The trust model is therefore layered,
 * and the identity consumer must know which layer it is standing on:
 *
 *   1. authenticity of the request      — CardActionHandler (encryptKey/token)
 *   2. authenticity of the operator id  — derived: Feishu's platform is the
 *                                        only party that can both pass (1) and
 *                                        know the real acting user, so an
 *                                        operator id inside a verified payload
 *                                        is platform-asserted
 *
 * Layer 2 is what M4's renderer uses as `responderId`. It is materially
 * different from reading an id out of an unauthenticated body, but it is weaker
 * than Discord, where the framework parses identity out of the Gateway
 * interaction object itself.
 *
 * BINDING POLICY
 *
 * Defaults to 127.0.0.1. A non-loopback bind is an explicit operator decision
 * (needed to receive Feishu's cloud POST) and must be set deliberately; this
 * module refuses to guess it, because silently listening on a public interface
 * is the failure mode that makes such endpoints dangerous.
 */

import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDecipheriv, createHash } from "node:crypto";

import type { FeishuCardActionConfig } from "./config.js";

/** What the renderer needs from a card interaction: who acted, and on which card. */
export interface FeishuCardActionCallback {
  /** Platform-asserted acting user, from the verified body's `operator`. */
  openId: string;
  /** The action name from the card's button config, used for routing. */
  action: string;
  /** Opaque per-card correlation value the renderer chose; never an answer. */
  value: Record<string, unknown>;
  /** Raw form values, when the interaction was a form submit. */
  formValues: Record<string, string>;
}

export type FeishuCardActionOutcome =
  | { ok: true; card?: unknown }
  | { ok: false; reason: "unauthorized" | "malformed" | "unsupported" | "internal" };

export interface FeishuCardActionRuntime {
  /** Stop serving. Idempotent. */
  stop(): Promise<void>;
  /** The bound port, resolved after `start()` — 0 means "not listening". */
  port(): number;
}

export interface FeishuCardActionHostOptions {
  config: FeishuCardActionConfig;
  /**
   * Invoked for a verified card action. Returns the card to render, or a
   * non-ok outcome for logging. Never throws: a throwing handler must not take
   * the server down.
   */
  onAction(callback: FeishuCardActionCallback): Promise<FeishuCardActionOutcome>;
  log?: (event: string, message: string, fields?: Record<string, string | number | boolean | undefined>) => void;
  /** Test seam: replaces the real HTTP server so no socket is opened. */
  injectedServer?: InjectedHttpServer;
}

/**
 * Minimal HTTP surface this module needs, so the webhook can be exercised
 * without binding a real port. Mirrors how the channel already injects
 * `injectedStartWS`/`injectedSdkClient` for the WS path.
 */
export interface InjectedHttpServer {
  listen(port: number, host: string, callback: () => void): void;
  close(callback?: () => void): void;
  /**
   * Mount a listener for a non-request server event.
   *
   * `"error"` in particular: port contention arrives asynchronously as an
   * `"error"` event rather than a `listen()` throw, so the teardown path that
   * rejects startup depends on this being subscribable. `once` installs it for
   * one delivery, which is the pattern the real `http.Server` documents.
   */
  once?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
  /**
   * Test seam: emit a server event to the mounted listeners, so a test can
   * reproduce an asynchronous bind failure without occupying a real port.
   */
  emitError?(error: Error): void;
  /**
   * Mount the request listener. Returns whatever the listener returns, so a
   * caller can await request completion (Node's real `http.Server` ignores it,
   * which is exactly why an awaitable seam is needed for tests).
   */
  on(event: "request", listener: (req: IncomingMessage, res: ServerResponse) => unknown): void;
  address(): { port: number } | string | null;
}

export function createInjectedHttpServer(): InjectedHttpServer & {
  /** Simulate one request against the mounted request listener. */
  simulate(method: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }>;
} {
  let listener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const errorListeners = new Set<(error: Error) => void>();
  const server = {
    listen: (_port: number, _host: string, callback: () => void): void => {
      callback();
    },
    close: (callback?: () => void): void => {
      callback?.();
    },
    once: (_event: "error", fn: (error: Error) => void): void => {
      errorListeners.add(fn);
    },
    removeListener: (_event: "error", fn: (error: Error) => void): void => {
      errorListeners.delete(fn);
    },
    /**
     * Reproduce what Node's `http.Server` actually does on a failed bind: emit
     * an `"error"` event AFTER `listen()` has returned. A synchronous
     * `listen()` throw cannot express this, which is why the previous fake
     * (and the code it covered) treated a taken port as a non-event.
     */
    emitError: (error: Error): void => {
      for (const fn of [...errorListeners]) {
        errorListeners.delete(fn);
        fn(error);
      }
    },
    on: (event: "request", fn: (req: IncomingMessage, res: ServerResponse) => void): void => {
      if (event === "request") listener = fn;
    },
    address: (): { port: number } | null => ({ port: 0 }),
    simulate: async (
      method: string,
      path: string,
      headers: Record<string, string>,
      body: string,
    ): Promise<{ status: number; body: string }> => {
      if (!listener) throw new Error("no request listener mounted");
      let status = 0;
      let responseBody = "";
      const res = {
        writeHead(code: number): void {
          status = code;
        },
        end(payload?: string): void {
          if (payload) responseBody = payload;
        },
      } as unknown as ServerResponse;
      const req = {
        method,
        url: path,
        headers,
        async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
          yield Buffer.from(body, "utf8");
        },
      } as unknown as IncomingMessage;
      // The listener is awaited, so the returned status is the one this request
      // actually produced rather than a snapshot taken before it finished.
      await listener(req, res);
      return { status, body: responseBody };
    },
  };
  return server;
}

const MAX_BODY_BYTES = 512 * 1024;

async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) return { ok: false };
    chunks.push(buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/**
 * Verify a card callback's authenticity.
 *
 * Two independent mechanisms, both grounded in app-secret material configured
 * out-of-band, and BOTH must hold when the corresponding headers are present:
 *
 *   1. Request signature (mirrors `CardActionHandler.checkIsEventValidated()` in
 *      the official SDK): Feishu sends `x-lark-request-timestamp`,
 *      `x-lark-request-nonce` and `x-lark-signature`. The signature is
 *      `sha256(timestamp + nonce + <secret> + rawBody)` as a hex digest, where
 *      `<secret>` is `encryptKey` when configured (encrypted/schema callbacks)
 *      and `verificationToken` otherwise. Without it, decrypting the body only
 *      proves the sender held the AesKey — not that the request was not
 *      captured and replayed later, and not that it came from Feishu at all
 *      unless the header is checked.
 *   2. Encrypted push — Feishu sends `{ encrypt: "<base64 AES-CBC ciphertext>" }`.
 *      Only a party holding `encryptKey` can decrypt it, so a successful decrypt
 *      proves possession of the key. The inner plaintext is the payload.
 *   3. Plaintext push + verification token — Feishu echoes the configured
 *      `verificationToken` in the body; a constant-time mismatch is a rejection.
 *
 * A channel configured with NEITHER secret is unauthenticated by construction and
 * every callback is rejected: the plugin fails closed rather than hand out an
 * identity it cannot attribute to Feishu.
 */
function verifyCardRequest(
  config: FeishuCardActionConfig,
  body: string,
  headers: Record<string, string | string[] | undefined>,
): { ok: true; payload: unknown } | { ok: false; reason: "unauthorized" | "malformed" } {
  const envelope = safeJson(body);
  if (envelope === undefined) return { ok: false, reason: "malformed" };
  if (typeof envelope !== "object" || envelope === null) return { ok: false, reason: "malformed" };
  const record = envelope as Record<string, unknown>;

  // The signature is computed over the RAW body, so it must be checked before
  // any parse of the ciphertext. The caller must not have modified it.
  //
  // Absence of the header is a REJECTION, not a skip. Feishu signs every
  // callback; a request without a signature is either not from Feishu or comes
  // from a configuration that disabled signing, and neither is a body this
  // channel may turn into a responderId.
  const timestamp = headerValue(headers, "x-lark-request-timestamp");
  const nonce = headerValue(headers, "x-lark-request-nonce");
  const signature = headerValue(headers, "x-lark-signature");
  if (timestamp === undefined || nonce === undefined || signature === undefined) {
    return { ok: false, reason: "unauthorized" };
  }
  // Per the SDK's `checkIsEventValidated`, an encrypted (or schema) callback is
  // signed with the ENCRYPT key; a plaintext callback is signed with the
  // verification token. Both are configured out-of-band, so a wrong choice
  // means the header cannot be reproduced by anyone who lacks that secret.
  const encrypted = typeof record.encrypt === "string";
  const secret = encrypted
    ? config.encryptKey
    : config.verificationToken.length > 0
      ? config.verificationToken
      : config.encryptKey;
  if (secret.length === 0) {
    // Feishu signed the request, but we have nothing to verify it against.
    return { ok: false, reason: "unauthorized" };
  }
  {
    const expected = createHash("sha256")
      .update(`${timestamp}${nonce}${secret}${body}`, "utf8")
      .digest("hex");
    if (!timingSafeEqual(expected, signature)) {
      return { ok: false, reason: "unauthorized" };
    }
    // A replay is only useful inside its freshness window. Feishu's own
    // guidance is 1800s; a timestamp outside it is a captured request.
    if (!isFreshTimestamp(timestamp)) {
      return { ok: false, reason: "unauthorized" };
    }
  }

  // Path 1: encrypted push. The `encrypt` field is Feishu's envelope marker.
  if (encrypted) {
    if (config.encryptKey.length === 0) {
      // An encrypted body with no key configured cannot be authenticated.
      return { ok: false, reason: "unauthorized" };
    }
    const plaintext = decryptFeishuEnvelope(record.encrypt as string, config.encryptKey);
    if (plaintext === undefined) return { ok: false, reason: "unauthorized" };
    const payload = safeJson(plaintext);
    if (payload === undefined) return { ok: false, reason: "malformed" };
    return { ok: true, payload };
  }

  // Path 2: plaintext push authenticated by the echoed token.
  if (config.verificationToken.length > 0) {
    const sentToken = record.token;
    if (typeof sentToken !== "string" || sentToken.length === 0) return { ok: false, reason: "unauthorized" };
    if (!timingSafeEqual(sentToken, config.verificationToken)) return { ok: false, reason: "unauthorized" };
    return { ok: true, payload: envelope };
  }
  // No verification token configured and no encryption: nothing authenticates
  // this channel, so no callback is accepted.
  return { ok: false, reason: "unauthorized" };
}

/**
 * Decrypt Feishu's AES-256-CBC event envelope.
 *
 * Feishu's scheme: the `encryptKey` is hashed with SHA-256 to produce the 32-byte
 * AES key; the first 16 bytes of the base64-decoded ciphertext are the IV and the
 * remainder is the ciphertext; PKCS#7 padding is stripped. This mirrors the
 * `AESCipher.decrypt` the official SDK ships, reimplemented here because the
 * channel does not instantiate a webhook `CardActionHandler` (see module docs).
 *
 * A wrong key produces either a padding error or garbage, both of which are
 * rejections — never a partial plaintext that could be acted on.
 */
function decryptFeishuEnvelope(encryptBase64: string, encryptKey: string): string | undefined {
  try {
    const ciphertext = Buffer.from(encryptBase64, "base64");
    if (ciphertext.length <= 16) return undefined;
    const iv = ciphertext.subarray(0, 16);
    const payload = ciphertext.subarray(16);
    const key = createHash("sha256").update(encryptKey, "utf8").digest();
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    let plaintext = Buffer.concat([decipher.update(payload), decipher.final()]);
    // Feishu pads the plaintext with trailing NULs after the JSON payload.
    let end = plaintext.length;
    while (end > 0 && plaintext[end - 1] === 0) end -= 1;
    plaintext = plaintext.subarray(0, end);
    const text = plaintext.toString("utf8");
    return text.length > 0 ? text : undefined;
  } catch {
    // Bad key, truncation, or any other crypto failure: indistinguishable from
    // an attacker, so it is one rejection.
    return undefined;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * Read a header Node may deliver as a string or an array, or not deliver at all.
 * A missing header is deliberately indistinguishable from an empty one for the
 * caller: both fail the signature check rather than being guessed at.
 */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Freshness window for the request timestamp, following Feishu's own guidance.
 * A signature is only evidence that Feishu sent THIS request; without a window,
 * a captured signed request can be replayed forever.
 */
const REQUEST_MAX_AGE_MS = 1800 * 1000;

function isFreshTimestamp(timestamp: string): boolean {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  const age = Date.now() - parsed * 1000;
  // A clock skew in the future is tolerated up to the same bound: a request
  // Feishu sent "now" can arrive with a timestamp a few seconds ahead of ours.
  return age <= REQUEST_MAX_AGE_MS && age > -REQUEST_MAX_AGE_MS;
}

/**
 * Extract a renderer callback from a VERIFIED card payload.
 *
 * Feishu's card action body shape (card v2 / interactive card):
 *
 *   { token, operator: { open_id }, action: { tag: "button", value: {...} },
 *     form_value: { key: value, ... } }
 *
 * Note the routing identity lives at `action.value` (the payload the renderer
 * itself put on the button) — not at a `name` field. A payload that is not an
 * object is not guessed at: the renderer's own opaque value is the only
 * correlation handle, so a scalar means the payload was not built by us.
 *
 * The operator id comes from the verified body's `operator`, which is
 * platform-asserted because only Feishu could have produced a body that passes
 * the token/encrypt check. It is NOT read from any client-supplied field.
 */
export function extractCardAction(payload: unknown): FeishuCardActionCallback | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const operator = record.operator;
  if (typeof operator !== "object" || operator === null) return null;
  const openIdRaw = (operator as { open_id?: unknown }).open_id;
  if (typeof openIdRaw !== "string" || openIdRaw.length === 0) return null;
  const actionRaw = record.action;
  if (typeof actionRaw !== "object" || actionRaw === null) return null;
  // `action.value` is the renderer's opaque routing payload. It is NOT an
  // answer: answers live in `form_value`, which this module forwards verbatim
  // and never inspects or logs.
  const valueRaw = (actionRaw as { value?: unknown }).value;
  if (typeof valueRaw !== "object" || valueRaw === null || Array.isArray(valueRaw)) return null;
  const value = valueRaw as Record<string, unknown>;
  const formRaw = record.form_value;
  const formValues: Record<string, string> = {};
  if (typeof formRaw === "object" && formRaw !== null) {
    for (const [key, item] of Object.entries(formRaw as Record<string, unknown>)) {
      formValues[key] = typeof item === "string" ? item : JSON.stringify(item);
    }
  }
  return {
    openId: openIdRaw,
    // The `tag` Feishu echoes from the button config (e.g. "button",
    // "select_static"); renderers use it to route, and it is deliberately not
    // an answer.
    action: typeof (actionRaw as { tag?: unknown }).tag === "string" ? (actionRaw as { tag: string }).tag : "",
    value,
    formValues,
  };
}

/**
 * Mount the card-action channel on an HTTP server.
 *
 * Rejects any request whose path does not match exactly, so the listener does
 * not respond to stray traffic. Responds to Feishu's URL-verification
 * challenge if one is ever delivered on this route (the open platform sends a
 * `challenge` field when a request URL is first configured).
 */
export async function startFeishuCardActionHost(
  options: FeishuCardActionHostOptions,
): Promise<FeishuCardActionRuntime> {
  const server: InjectedHttpServer = options.injectedServer ?? (createServer() as unknown as InjectedHttpServer);
  // The listener RETURNS the async work. Node's own `http.Server` ignores the
  // return value (it keeps the response open until the handler ends it), but
  // returning it lets a caller await request completion, which is what makes
  // the handler's behavior observable and testable rather than timing-based.
  server.on("request", (req, res) => {
    // Returning the async work (rather than `void`-ing it) is what makes the
    // handler awaitable: Node ignores the return value, but a test seam can wait
    // on it, so the response status is the one this request actually produced.
    return (async () => {
      try {
        await handleRequest(options, req, res);
      } catch (error) {
        options.log?.("feishu.card.server_error", "unhandled card callback error", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    // Port contention is ASYNCHRONOUS: `server.listen()` throws only for
    // argument-shape errors, and EADDRINUSE arrives later as an `"error"` event
    // with no listener registered — which Node reports as an unhandled `error`
    // event. Attaching the listener BEFORE listen() is the documented pattern;
    // a try/catch around listen() alone never sees it.
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      if (typeof server.removeListener === "function") {
        server.removeListener("error", onError);
      }
    };
    if (typeof server.once === "function") {
      server.once("error", onError);
    }
    try {
      server.listen(options.config.port, options.config.host, () => {
        cleanup();
        resolve();
      });
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : options.config.port;

  return {
    port: () => bound,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function handleRequest(
  options: FeishuCardActionHostOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const pathOnly = url.split("?")[0] ?? "/";
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  if (pathOnly !== options.config.path) {
    // Do not confirm the existence of the real route to a scanner.
    res.writeHead(404);
    res.end();
    return;
  }
  const body = await readBody(req);
  if (!body.ok) {
    res.writeHead(413);
    res.end();
    return;
  }
  const verified = verifyCardRequest(options.config, body.text, req.headers as Record<string, string | string[] | undefined>);
  if (!verified.ok) {
    // Log the class, never the body: it may contain a partially-decrypted or
    // attacker-supplied payload whose contents are not ours to record.
    options.log?.("feishu.card.rejected", "rejected unverifiable card callback", {
      reason: verified.reason,
    });
    res.writeHead(verified.reason === "malformed" ? 400 : 401);
    res.end();
    return;
  }

  const challenge = typeof verified.payload === "object" && verified.payload !== null
    ? (verified.payload as { challenge?: unknown }).challenge
    : undefined;
  if (typeof challenge === "string") {
    // Feishu's URL-verification handshake: echo the challenge verbatim.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ challenge }));
    return;
  }

  const callback = extractCardAction(verified.payload);
  if (!callback) {
    // A verified request with no usable operator is a protocol change we do
    // not understand; refuse rather than guess at an identity.
    options.log?.("feishu.card.no_operator", "verified card callback carried no operator", {});
    res.writeHead(400);
    res.end();
    return;
  }

  const outcome = await options.onAction(callback);
  if (!outcome.ok) {
    const status = outcome.reason === "unauthorized" ? 403 : outcome.reason === "unsupported" ? 404 : 500;
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(outcome.card !== undefined ? JSON.stringify(outcome.card) : "{}");
}
