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
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n", 0, "latin1");
    if (end === -1) return;
    socket.off("data", onData);
    const statusLine = buffer.subarray(0, buffer.indexOf("\r\n", 0, "latin1")).toString("latin1");
    settled = true;
    socket.setTimeout(0);
    if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
      socket.destroy();
      reject(new Error(`proxy CONNECT failed: ${statusLine}`));
      return;
    }
    // Bytes after the CONNECT response belong to the tunnelled stream (e.g. a
    // TLS ServerHello in the same chunk): hand them back, never drop them.
    const rest = buffer.subarray(end + 4);
    if (rest.length > 0) socket.unshift(rest);
    socket.pause();
    resolve(socket);
  };
  socket.on("data", onData);
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
  // openTunnel leaves the socket paused (so no tunnelled byte is emitted to a
  // missing listener); resume now that the reader is attached.
  socket.resume();
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
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    // Never echo the raw value: it may carry `user:pass@` credentials.
    throw new Error("the proxy URL is not a valid URL");
  }
  if (proxy.protocol === "https:") {
    // A TLS connection to the proxy itself is not implemented; refusing is
    // safer than speaking plaintext CONNECT to port 80 of an https proxy.
    throw new Error("https:// proxy URLs are not supported; use an http:// proxy URL");
  }
  if (proxy.protocol !== "http:") {
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
  // Every failure text (network error, proxy CONNECT status line, upstream
  // response excerpt) is scrubbed of proxy credentials and the API key before
  // it reaches a caller: the connection test returns it over RPC and the
  // router folds causes into a user-visible reason.
  const env = input.env ?? process.env;
  const redact = (text: string): string => redactJevSecrets(text, {
    proxyUrls: [input.proxyUrl, env.HTTPS_PROXY, env.https_proxy],
    apiKey: input.apiKey,
  });
  const result = await askJevChoiceUnredacted(input, redact);
  return result.ok ? result : { ...result, message: redact(result.message) };
}

async function askJevChoiceUnredacted(
  input: JevAskInput,
  redact: (text: string) => string,
): Promise<JevAskResult> {
  if (typeof input.apiKey !== "string" || input.apiKey.trim().length === 0) {
    return failure("no-key", "No Jev API key is configured for this instance.");
  }
  if (input.choices.length === 0) {
    return failure("malformed-response", "A Jev choice question requires at least one choice.");
  }
  const startedAt = Date.now();
  const request = buildRequest(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
  // An explicit proxy wins; empty falls back to the daemon process env. Either
  // is skipped when NO_PROXY matches the endpoint host. The platform fetch
  // does not honor HTTPS_PROXY on its own, so the fallback is resolved here
  // and routed through the same CONNECT tunnel.
  const proxyUrl = resolveJevProxyUrl(input.proxyUrl, input.env ?? process.env, request.url);
  let response: JevHttpResponse;
  try {
    // `fetchImpl` wins (tests). Otherwise any resolved proxy (explicit or from
    // the env, see above) goes through the CONNECT tunnel; with none the
    // request goes direct via the platform fetch.
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
  // Redact the whole body before statusFailure truncates it, so a secret cut
  // in half by the excerpt bound cannot survive as an unmatched fragment.
  if (!response.ok) return statusFailure(response.status, redact(text));
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

/**
 * The proxy a Jev call uses: the explicit per-instance setting, else
 * `HTTPS_PROXY` / `https_proxy` from the environment, else none.
 *
 * `NO_PROXY` / `no_proxy` is honored for BOTH sources: when it matches the
 * target host the call goes direct even with an explicit Jev proxy configured.
 * One rule for every proxy keeps the daemon consistent with the rest of the
 * machine's tooling (an operator who exempts a host in NO_PROXY means it).
 */
export function resolveJevProxyUrl(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  targetUrl?: string,
): string | undefined {
  const candidate = explicit?.trim() || env.HTTPS_PROXY?.trim() || env.https_proxy?.trim();
  if (!candidate) return undefined;
  if (targetUrl && noProxyMatches(targetUrl, env.NO_PROXY ?? env.no_proxy)) return undefined;
  return candidate;
}

/** One parsed NO_PROXY entry. */
type NoProxyEntry =
  | { kind: "all" }
  | { kind: "name"; name: string; port?: string }
  | { kind: "ip"; family: 4 | 6; value: bigint; port?: string }
  | { kind: "cidr"; family: 4 | 6; value: bigint; prefix: number };

/** Parse a dotted-quad IPv4 literal; anything else is undefined. */
function parseIpv4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

/** Parse an IPv6 literal (with `::` compression and an optional embedded
 *  IPv4 tail); anything else is undefined. Zone ids are not accepted. */
function parseIpv6(text: string): bigint | undefined {
  if (!text.includes(":") || text.includes("%")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (half: string): number[] | undefined => {
    if (half.length === 0) return [];
    const groups: number[] = [];
    const pieces = half.split(":");
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (v4 === undefined) return undefined;
        groups.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function parseIp(text: string): { family: 4 | 6; value: bigint } | undefined {
  const v4 = parseIpv4(text);
  if (v4 !== undefined) return { family: 4, value: v4 };
  const v6 = parseIpv6(text);
  if (v6 !== undefined) return { family: 6, value: v6 };
  return undefined;
}

/** Parse one NO_PROXY entry. Unreadable entries are skipped (undefined) rather
 *  than widened into a match. */
function parseNoProxyEntry(raw: string): NoProxyEntry | undefined {
  let entry = raw.trim().toLowerCase();
  if (!entry) return undefined;
  if (entry === "*") return { kind: "all" };
  // `[v6]` or `[v6]:port`.
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close === -1) return undefined;
    const ip = parseIpv6(entry.slice(1, close));
    const rest = entry.slice(close + 1);
    if (ip === undefined) return undefined;
    if (rest.length === 0) return { kind: "ip", family: 6, value: ip };
    const port = /^:(\d{1,5})$/.exec(rest)?.[1];
    return port ? { kind: "ip", family: 6, value: ip, port } : undefined;
  }
  // CIDR on an IP literal: `10.0.0.0/8`, `fd00::/8`.
  const slash = entry.indexOf("/");
  if (slash !== -1) {
    const ip = parseIp(entry.slice(0, slash));
    const prefixText = entry.slice(slash + 1);
    if (!ip || !/^\d{1,3}$/.test(prefixText)) return undefined;
    const prefix = Number(prefixText);
    if (prefix > (ip.family === 4 ? 32 : 128)) return undefined;
    return { kind: "cidr", family: ip.family, value: ip.value, prefix };
  }
  // A bare IPv6 literal has several colons and never carries a port.
  const colons = entry.split(":").length - 1;
  if (colons > 1) {
    const ip = parseIpv6(entry);
    return ip === undefined ? undefined : { kind: "ip", family: 6, value: ip };
  }
  let port: string | undefined;
  if (colons === 1) {
    const match = /^(.*):(\d{1,5})$/.exec(entry);
    if (!match) return undefined;
    entry = match[1]!;
    port = match[2];
  }
  const ip = parseIpv4(entry);
  if (ip !== undefined) return { kind: "ip", family: 4, value: ip, ...(port ? { port } : {}) };
  // `.example.com` and `*.example.com` are the same rule as `example.com`.
  const name = entry.replace(/^\*?\./, "").replace(/\.$/, "");
  if (name.length === 0 || name.includes("*") || name.includes("/")) return undefined;
  return { kind: "name", name, ...(port ? { port } : {}) };
}

/**
 * Standard NO_PROXY matching (the curl/wget convention):
 * - `*` alone exempts every host;
 * - a host name matches itself and its subdomains on label boundaries:
 *   `example.com`, `.example.com` and `*.example.com` all match `example.com`
 *   and `api.example.com`, never `badexample.com`;
 * - an IP literal (`10.0.0.1`, `::1`, `[::1]`) matches only that address —
 *   never a suffix — and an IP CIDR (`10.0.0.0/8`, `fd00::/8`) matches the
 *   addresses inside it; a host name never matches an IP entry or vice versa;
 * - an optional `:port` (`example.com:8443`, `[::1]:8443`) restricts the entry
 *   to that port (the target's default port when it names none).
 * Entries are separated by commas and/or whitespace; unreadable ones are
 * ignored rather than widened into a match.
 */
export function noProxyMatches(targetUrl: string, noProxy: string | undefined): boolean {
  if (!noProxy?.trim()) return false;
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  const rawHost = target.hostname.toLowerCase();
  const bracketed = rawHost.startsWith("[") && rawHost.endsWith("]");
  const host = (bracketed ? rawHost.slice(1, -1) : rawHost).replace(/\.$/, "");
  const port = target.port || (target.protocol === "https:" ? "443" : "80");
  const hostIp = bracketed ? (() => {
    const v6 = parseIpv6(host);
    return v6 === undefined ? undefined : { family: 6 as const, value: v6 };
  })() : (() => {
    const v4 = parseIpv4(host);
    return v4 === undefined ? undefined : { family: 4 as const, value: v4 };
  })();
  for (const raw of noProxy.split(/[\s,]+/)) {
    const entry = parseNoProxyEntry(raw);
    if (!entry) continue;
    switch (entry.kind) {
      case "all":
        return true;
      case "name":
        if (hostIp) continue;
        if (entry.port && entry.port !== port) continue;
        if (host === entry.name || host.endsWith(`.${entry.name}`)) return true;
        continue;
      case "ip":
        if (!hostIp || hostIp.family !== entry.family) continue;
        if (entry.port && entry.port !== port) continue;
        if (hostIp.value === entry.value) return true;
        continue;
      case "cidr": {
        if (!hostIp || hostIp.family !== entry.family) continue;
        const bits = BigInt((entry.family === 4 ? 32 : 128) - entry.prefix);
        if ((hostIp.value >> bits) === (entry.value >> bits)) return true;
        continue;
      }
    }
  }
  return false;
}

/** Replace every occurrence of `needle` in `text`. */
function replaceAll(text: string, needle: string, replacement: string): string {
  return needle.length === 0 ? text : text.split(needle).join(replacement);
}

/**
 * Scrub credentials from text that is about to leave this module (an error
 * message, a log line, an RPC result, an upstream response excerpt):
 * - any `scheme://user[:pass]@` userinfo becomes `scheme://***@`;
 * - the given proxy URLs' username and password (raw and percent-decoded) and
 *   the API key, wherever they appear verbatim, become `***`.
 */
export function redactJevSecrets(
  text: string,
  secrets: { proxyUrls?: ReadonlyArray<string | undefined>; apiKey?: string } = {},
): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, "$1***@");
  const needles = new Set<string>();
  for (const proxyUrl of secrets.proxyUrls ?? []) {
    if (!proxyUrl) continue;
    try {
      const url = new URL(proxyUrl);
      for (const part of [url.username, url.password]) {
        if (!part) continue;
        needles.add(part);
        try {
          needles.add(decodeURIComponent(part));
        } catch {
          // A malformed escape still leaves the raw form redacted.
        }
      }
    } catch {
      // Unparseable: the userinfo regex above already covered `x://u:p@`.
      const at = proxyUrl.lastIndexOf("@");
      if (at > 0) {
        const scheme = proxyUrl.indexOf("://");
        const userinfo = proxyUrl.slice(scheme === -1 ? 0 : scheme + 3, at);
        for (const part of userinfo.split(":")) if (part) needles.add(part);
      }
    }
  }
  if (secrets.apiKey?.trim()) needles.add(secrets.apiKey.trim());
  // Longest first, so a password that contains the username is removed whole.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    // Very short fragments (e.g. a one-letter user) would shred ordinary text;
    // the userinfo regex still removes them from URLs.
    if (needle.length < 3) continue;
    out = replaceAll(out, needle, "***");
  }
  return out;
}

/** A proxy URL safe to log or return over the wire: any userinfo
 *  (`user:pass@`) is replaced with `***@`. Unparseable input is redacted. */
export function maskProxyUrl(proxyUrl: string | undefined | null): string | undefined {
  if (typeof proxyUrl !== "string" || proxyUrl.length === 0) return undefined;
  try {
    const url = new URL(proxyUrl);
    if (!url.username && !url.password) return proxyUrl;
    return `${url.protocol}//***@${url.host}${url.pathname === "/" && !proxyUrl.endsWith("/") ? "" : url.pathname}${url.search}`;
  } catch {
    return proxyUrl.includes("@") ? "***" : proxyUrl;
  }
}

/** Mask a stored key for display: at most a 3-character prefix plus the last 4.
 *  Short keys mask to nothing — a partial short key is not a useful preview and
 *  only leaks entropy. */
export function maskJevKey(key: string | undefined): string | null {
  if (typeof key !== "string" || key.length <= 4) return null;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
