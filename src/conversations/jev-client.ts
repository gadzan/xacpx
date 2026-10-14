import type { JevTestFailureCode } from "@ganglion/xacpx-relay-protocol";
import { ProxyAgent, fetch as undiciFetch } from "undici";

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
   *  (`HTTPS_PROXY` / `https_proxy`), which undici honors natively. */
  proxyUrl?: string;
  model?: string;
  /** The state message: the user's request, optionally with bounded context. */
  message: string;
  /** The choice question. Defaults to {@link JEV_ROUTER_QUESTION}. */
  question?: string;
  choices: readonly JevChoice[];
  timeoutMs?: number;
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

/** Build the request for one call. A proxy routes through undici's fetch (the
 *  only fetch here that honors a dispatcher); without one the platform fetch
 *  already honors the process proxy env. */
function buildRequest(input: JevAskInput): {
  url: string;
  init: RequestInit;
  proxiedInit?: Parameters<typeof undiciFetch>[1];
  proxied: boolean;
} {
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
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
  };
  const body = JSON.stringify(payload);
  const signal = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS);
  const init: RequestInit = { method: "POST", headers, body, signal };
  const proxyUrl = input.proxyUrl?.trim();
  if (!proxyUrl) return { url: input.endpoint, init, proxied: false };
  return {
    url: input.endpoint,
    init,
    // Built from the same primitives rather than spread from `init`: undici's
    // RequestInit rejects a nullable body, and its dispatcher slot is typed by
    // the package itself (the @types/node undici-types surface does not unify).
    proxiedInit: { method: "POST", headers, body, signal, dispatcher: new ProxyAgent(proxyUrl) },
    proxied: true,
  };
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
  const { url, init, proxiedInit, proxied } = buildRequest(input);
  let response: JevHttpResponse;
  try {
    // `fetchImpl` wins (tests); otherwise a proxy routes through undici's
    // fetch (the only one that honors a dispatcher) and the platform fetch
    // already honors the process proxy env by itself.
    response = input.fetchImpl
      ? await input.fetchImpl(url, init)
      : proxied
        ? await undiciFetch(url, proxiedInit)
        : await fetch(url, init);
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

/** Mask a stored key for display: at most a 3-character prefix plus the last 4.
 *  Short keys mask to nothing — a partial short key is not a useful preview and
 *  only leaks entropy. */
export function maskJevKey(key: string | undefined): string | null {
  if (typeof key !== "string" || key.length <= 4) return null;
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
