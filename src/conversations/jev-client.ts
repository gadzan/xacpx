import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

import type { JevTestFailureCode } from "@ganglion/xacpx-relay-protocol";

/**
 * The TypeSafe "Jev" (SystemOne) choice client.
 *
 * One question, one answer: Jev picks exactly one choice from a bounded set.
 * The xacpx Router uses it to choose which Group member handles a request; the
 * daemon's connection test uses it to prove the configured key/endpoint work.
 *
 * Verified live facts this module encodes:
 * - `POST <endpoint>` with `Authorization: Bearer <key>` and JSON body
 *   `{ model, state: { message }, questions: { bot: { type: "choice",
 *   question, criteria: { <key>: <description> } } } }`. The criteria field is
 *   `criteria` (NOT `options`); a missing one answers HTTP 422.
 * - The answer is `{ model, answers: { bot: { type: "choice", choice,
 *   confidence, probabilities } }, usage }`.
 * - Mainland-China direct access answers HTTP 451 with a region title; an HTTP
 *   proxy works (~1s).
 *
 * Error mapping lives here so the connection test and the Router share one
 * vocabulary. The key is never logged and never returned in a failure.
 */

/** Pinned default model. Operators do not choose a model; xacpx pins one. */
export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** Default TypeSafe SystemOne endpoint. */
export const DEFAULT_JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Jev accepts at most 255 choices per question. */
export const MAX_JEV_CHOICES = 255;

/** The question the Router asks. Stable text: the criteria carry the meaning. */
export const JEV_ROUTER_QUESTION = "Which bot should handle this message?";

/** Default bound for one Jev call (connect + response). */
export const DEFAULT_JEV_TIMEOUT_MS = 10_000;

/** One choice offered to Jev. */
export interface JevChoice {
  /** Opaque key echoed back in `answers.bot.choice` (the bot id). */
  key: string;
  /** Human-facing description shown to Jev as the choice's meaning. */
  description: string;
}

export interface JevAskInput {
  endpoint: string;
  apiKey: string;
  /** HTTP proxy URL. Empty/absent falls back to the daemon process env
   *  (`HTTPS_PROXY` / `https_proxy`), resolved by resolveJevProxyUrl. */
  proxyUrl?: string;
  model?: string;
  /** The state message: the user's request, optionally with bounded context. */
  message: string;
  /** The choice question. Defaults to {@link JEV_ROUTER_QUESTION}. */
  question?: string;
  choices: readonly JevChoice[];
  timeoutMs?: number;
  /** Environment for the proxy fallback; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable transport for tests. Must be a `fetch`-compatible function. */
  fetchImpl?: typeof fetch;
}

export type JevAskResult =
  | { ok: true; choice: string; confidence: number; latencyMs: number }
  | { ok: false; code: JevTestFailureCode; message: string };

/** The response surface the module reads; both the platform fetch and undici's
 *  fetch satisfy it without forcing their Response types to unify. */
interface JevHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface JevAnswer {
  choice: string;
  confidence: number;
}

function failure(code: JevTestFailureCode, message: string): JevAskResult {
  return { ok: false, code, message };
}

/** Map one HTTP status onto the shared failure vocabulary. */
function statusFailure(status: number, body: string): JevAskResult {
  if (status === 451) {
    return failure(
      "region-blocked",
      "TypeSafe is not available in this region. Configure an HTTP proxy for Jev.",
    );
  }
  if (status === 401 || status === 403) {
    return failure("bad-key", `The Jev API key was rejected (HTTP ${status}).`);
  }
  const detail = body.trim().slice(0, 200);
  return failure(
    "http-error",
    detail ? `Jev answered HTTP ${status}: ${detail}` : `Jev answered HTTP ${status}.`,
  );
}

/** Narrow one answer body to the chosen key and confidence, or explain why not. */
function readAnswer(body: unknown): JevAnswer | string {
  if (typeof body !== "object" || body === null) return "Jev answer was not a JSON object";
  const answers = "answers" in body ? body.answers : undefined;
  if (typeof answers !== "object" || answers === null) return "Jev answer has no answers object";
  const bot = "bot" in answers ? answers.bot : undefined;
  if (typeof bot !== "object" || bot === null) return "Jev answer has no bot answer";
  const choice = "choice" in bot ? bot.choice : undefined;
  if (typeof choice !== "string" || choice.trim().length === 0) {
    return "Jev answer did not name a choice";
  }
  const confidence = "confidence" in bot ? bot.confidence : undefined;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence))) {
    return "Jev answer confidence is not a number";
  }
  return { choice, confidence: typeof confidence === "number" ? confidence : 0 };
}

/** The request this module sends, in the shape both transports need. */
interface JevRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** Build the request for one call. */
function buildRequest(input: JevAskInput): JevRequest {
  const choices = input.choices.slice(0, MAX_JEV_CHOICES);
  const payload = {
    model: input.model ?? DEFAULT_JEV_MODEL,
    state: { message: input.message },
    questions: {
      bot: {
        type: "choice",
        question: input.question ?? JEV_ROUTER_QUESTION,
        criteria: Object.fromEntries(choices.map((choice) => [choice.key, choice.description])),
      },
    },
  };
  return {
    url: input.endpoint,
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

/** Open a TCP tunnel to `target` through an HTTP proxy with CONNECT. */
function openTunnel(proxy: URL, target: URL, timeoutMs: number): Promise<Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port || 80) });
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(error);
  };
  socket.setTimeout(timeoutMs, () => fail(new Error(`proxy CONNECT to ${proxy.hostname} timed out`)));
  socket.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("latin1");
    const end = buffer.indexOf("\r\n\r\n");
    if (end === -1) return;
    const statusLine = buffer.slice(0, buffer.indexOf("\r\n"));
    settled = true;
    socket.setTimeout(0);
    if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
      socket.destroy();
      reject(new Error(`proxy CONNECT failed: ${statusLine}`));
      return;
    }
    resolve(socket);
  });
  const auth = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
    : "";
  socket.write(`CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n${auth}\r\n`);
  return promise;
}

/** Decode a `Transfer-Encoding: chunked` body. */
function dechunk(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) break;
    const size = Number.parseInt(raw.subarray(offset, lineEnd).toString("latin1").split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** Bound on a proxied response; Jev answers are a few hundred bytes. */
const MAX_PROXIED_RESPONSE_BYTES = 1024 * 1024;

/**
 * Send the request over an already-established tunnel socket as raw HTTP/1.1.
 *
 * Written by hand on purpose: Bun's `http.request` ignores `createConnection`
 * and silently dials the target directly (verified: a proxied call came back
 * 451 from a blocked region), so the node client cannot be trusted to use the
 * tunnel under both runtimes. `Connection: close` lets the body end at EOF.
 */
async function sendOverSocket(
  socket: Socket,
  target: URL,
  request: JevRequest,
  timeoutMs: number,
): Promise<JevHttpResponse> {
  const path = `${target.pathname}${target.search}` || "/";
  const body = Buffer.from(request.body, "utf8");
  const head = [
    `${request.method} ${path} HTTP/1.1`,
    `Host: ${target.host}`,
    ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${body.length}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  const { promise, resolve, reject } = Promise.withResolvers<JevHttpResponse>();
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(error);
  };
  socket.setTimeout(timeoutMs, () => fail(new Error(`Jev request through the proxy timed out after ${timeoutMs}ms`)));
  socket.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_PROXIED_RESPONSE_BYTES) return fail(new Error("Jev response exceeded its size limit"));
    chunks.push(chunk);
  });
  socket.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  socket.on("end", () => {
    if (settled) return;
    const raw = Buffer.concat(chunks);
    const split = raw.indexOf("\r\n\r\n", 0, "latin1");
    if (split === -1) return fail(new Error("Jev response through the proxy had no header terminator"));
    const headerText = raw.subarray(0, split).toString("latin1");
    const match = /^HTTP\/1\.[01] (\d{3})/.exec(headerText);
    if (!match) return fail(new Error("Jev response through the proxy had no status line"));
    const status = Number(match[1]);
    const chunked = /\r\ntransfer-encoding:\s*chunked/i.test(headerText);
    const payload = raw.subarray(split + 4);
    const text = (chunked ? dechunk(payload) : payload).toString("utf8");
    settled = true;
    socket.setTimeout(0);
    socket.destroy();
    resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) });
  });
  socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
  return await promise;
}

/**
 * POST through an HTTP proxy. The tunnel is built from node primitives rather
 * than undici's ProxyAgent: Bun's fetch shim silently ignores the dispatcher
 * option (verified), so a dispatcher-based path would bypass the proxy in a
 * Bun-run daemon while working under node. CONNECT behaves identically under
 * both runtimes.
 */
async function postThroughProxy(
  proxyUrl: string,
  request: JevRequest,
  timeoutMs: number,
): Promise<JevHttpResponse> {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`unsupported proxy protocol: ${proxy.protocol}`);
  }
  const target = new URL(request.url);
  const tunnel = await openTunnel(proxy, target, timeoutMs);
  if (target.protocol !== "https:") {
    return await sendOverSocket(tunnel, target, request, timeoutMs);
  }
  const socket = tlsConnect({ socket: tunnel, servername: target.hostname });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.once("secureConnect", () => resolve());
  socket.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
  await promise;
  return await sendOverSocket(socket, target, request, timeoutMs);
}

/**
 * Ask Jev one choice question. Never throws: every failure is a classified
 * {@link JevAskResult}, so callers (connection test, Router) render one
 * vocabulary of causes.
 */
export async function askJevChoice(input: JevAskInput): Promise<JevAskResult> {
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return failure("no-key", "No Jev API key is configured for this instance.");
  }
  if (input.choices.length === 0) {
    return failure("malformed-response", "A Jev choice question requires at least one choice.");
  }
  const startedAt = Date.now();
  const request = buildRequest(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  // An explicit proxy wins; empty falls back to the daemon process env. The
  // platform fetch does not honor HTTPS_PROXY on its own, so the fallback is
  // resolved here and routed through the same CONNECT tunnel.
  const proxyUrl = resolveJevProxyUrl(input.proxyUrl, input.env ?? process.env);
  let response: JevHttpResponse;
  try {
    // `fetchImpl` wins (tests). Otherwise the platform fetch already honors the
    // process proxy env; an explicit proxy URL goes through the CONNECT tunnel.
    response = input.fetchImpl
      ? await input.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      : proxyUrl
        ? await postThroughProxy(proxyUrl, request, timeoutMs)
        : await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(timeoutMs),
        });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("network", `Jev request failed: ${message}`);
  }
  const latencyMs = Date.now() - startedAt;
  const text = await response.text().catch(() => "");
  if (!response.ok) return statusFailure(response.status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure("malformed-response", "Jev answer was not valid JSON.");
  }
  const answer = readAnswer(parsed);
  if (typeof answer === "string") return failure("malformed-response", answer);
  return { ok: true, choice: answer.choice, confidence: answer.confidence, latencyMs };
}

/** The proxy a Jev call uses: the explicit setting, else `HTTPS_PROXY` /
 *  `https_proxy` from the environment, else none. */
export function resolveJevProxyUrl(explicit: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const candidate = explicit?.trim() || env.HTTPS_PROXY?.trim() || env.https_proxy?.trim();
  return candidate ? candidate : undefined;
}

/** Mask a stored key for display: at most a 3-character prefix plus the last 4.
 *  Short keys mask to nothing — a partial short key is not a useful preview and
 *  only leaks entropy. */
export function maskJevKey(key: string | undefined): string | null {
  if (typeof key !== "string" || key.length <= 4) return null;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
