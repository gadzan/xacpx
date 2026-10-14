import { expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";

import { askJevChoice, maskJevKey, maskProxyUrl, noProxyMatches, resolveJevProxyUrl, type JevAskInput } from "../../../src/conversations/jev-client";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function input(overrides: Partial<JevAskInput> = {}): JevAskInput {
  return {
    endpoint: ENDPOINT,
    apiKey: "sk-test-key",
    model: "jev-1.13.0",
    message: "review the auth patch",
    choices: [
      { key: "coder", description: "写代码" },
      { key: "reviewer", description: "审查 PR" },
    ],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function answerBody(choice: string, confidence: number): unknown {
  return {
    model: "jev-1.13.0",
    answers: { bot: { type: "choice", choice, confidence, probabilities: {} } },
    usage: { total_tokens: 12 },
  };
}

/** A fetch stand-in that records the call and answers with `response`. */
function recordingFetch(response: () => Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("a 2xx answer maps to the chosen key and confidence", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, answerBody("reviewer", 0.87)));
  const result = await askJevChoice(input({ fetchImpl }));
  expect(result).toMatchObject({ ok: true, choice: "reviewer", confidence: 0.87 });
  expect(typeof (result as { latencyMs: number }).latencyMs).toBe("number");
  const [call] = calls;
  expect(call?.url).toBe(ENDPOINT);
  const headers = call?.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-test-key");
  expect(headers["content-type"]).toBe("application/json");
  const body = JSON.parse(String(call?.init.body));
  expect(body.model).toBe("jev-1.13.0");
  expect(body.state).toEqual({ message: "review the auth patch" });
  // `criteria`, not `options`: a missing criteria field answers HTTP 422.
  expect(body.questions.bot.criteria).toEqual({ coder: "写代码", reviewer: "审查 PR" });
  expect(body.questions.bot.type).toBe("choice");
  expect(body.questions.bot.question).toBe("Which bot should handle this message?");
});

test("HTTP 451 maps to region-blocked", async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse(451, { title: "Typesafe is not available in your region.", status: 451 }));
  const result = await askJevChoice(input({ fetchImpl }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("region-blocked");
  expect(result.message).toContain("proxy");
});

test("HTTP 401 and 403 map to bad-key", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = recordingFetch(() => jsonResponse(status, { message: "nope" }));
    const result = await askJevChoice(input({ fetchImpl }));
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.code).toBe("bad-key");
    expect(result.message).toContain(String(status));
  }
});

test("another non-2xx maps to http-error with the body detail", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(500, { detail: "boom" }));
  const result = await askJevChoice(input({ fetchImpl }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("http-error");
  expect(result.message).toContain("500");
  expect(result.message).toContain("boom");
});

test("a transport failure maps to network", async () => {
  const fetchImpl = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:443");
  }) as unknown as typeof fetch;
  const result = await askJevChoice(input({ fetchImpl }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("network");
  expect(result.message).toContain("ECONNREFUSED");
});

test("a non-JSON body maps to malformed-response", async () => {
  const fetchImpl = (async () => new Response("<html>nope", { status: 200 })) as unknown as typeof fetch;
  const result = await askJevChoice(input({ fetchImpl }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("malformed-response");
});

test("a JSON body without the expected answer shape maps to malformed-response", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse(200, { model: "jev-1.13.0", answers: {} }));
  const result = await askJevChoice(input({ fetchImpl }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("malformed-response");
});

test("a missing key answers no-key without any HTTP call", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, answerBody("coder", 1)));
  const result = await askJevChoice(input({ apiKey: "  ", fetchImpl }));
  expect(calls).toHaveLength(0);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("no-key");
});

test("no choices maps to malformed-response without any HTTP call", async () => {
  const { fetchImpl, calls } = recordingFetch(() => jsonResponse(200, answerBody("coder", 1)));
  const result = await askJevChoice(input({ choices: [], fetchImpl }));
  expect(calls).toHaveLength(0);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe("malformed-response");
});

test("maskJevKey keeps a prefix and the last 4, and hides short keys", () => {
  expect(maskJevKey("sk-1234567890abcd")).toBe("sk-…abcd");
  expect(maskJevKey("abcd")).toBeNull();
  expect(maskJevKey("")).toBeNull();
  expect(maskJevKey(undefined)).toBeNull();
});

test("a proxied call routes through the configured HTTP proxy (loopback CONNECT proof)", async () => {
  // A real CONNECT proxy on loopback: the origin must only ever be reached
  // through the tunnel, and the proxy must log the CONNECT target. No external
  // network is involved.
  let originHits = 0;
  const origin = createServer((req, res) => {
    originHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answerBody("coder", 0.9)));
  });
  const connectTargets: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    // A CONNECT proxy tunnels raw bytes; everything else is refused.
    if (req.method !== "CONNECT") {
      socket.destroy();
      return;
    }
    connectTargets.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = netConnect({ host, port: Number(port) }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as { port: number }).port;
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const result = await askJevChoice(input({
      endpoint: `http://127.0.0.1:${originPort}/v1/systemone`,
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
    }));
    expect(result).toMatchObject({ ok: true, choice: "coder", confidence: 0.9 });
    expect(connectTargets).toEqual([`127.0.0.1:${originPort}`]);
    expect(originHits).toBe(1);
  } finally {
    origin.close();
    proxy.close();
  }
});

test("a proxy that refuses CONNECT maps to a network failure", async () => {
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const result = await askJevChoice(input({
      endpoint: "http://127.0.0.1:9/v1/systemone",
      proxyUrl: `http://127.0.0.1:${proxyPort}`,
      timeoutMs: 5_000,
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("network");
  } finally {
    proxy.close();
  }
});

test("without a proxy the request goes straight to the endpoint (loopback proof)", async () => {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answerBody("reviewer", 1)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await askJevChoice(input({ endpoint: `http://127.0.0.1:${port}/v1/systemone`, env: {} }));
    expect(result).toMatchObject({ ok: true, choice: "reviewer", confidence: 1 });
    expect(hits).toBe(1);
  } finally {
    server.close();
  }
});

test("an empty proxy setting falls back to HTTPS_PROXY, then https_proxy", () => {
  expect(resolveJevProxyUrl("http://explicit:1", { HTTPS_PROXY: "http://env:2" })).toBe("http://explicit:1");
  expect(resolveJevProxyUrl("  ", { HTTPS_PROXY: "http://env:2" })).toBe("http://env:2");
  expect(resolveJevProxyUrl(undefined, { https_proxy: "http://lower:3" })).toBe("http://lower:3");
  expect(resolveJevProxyUrl(undefined, {})).toBeUndefined();
});

test("a JSON answer with no confidence maps to confidence 0", async () => {
  const result = await askJevChoice({
    endpoint: "https://jev.test/v1/systemone",
    apiKey: "sk-test-key",
    model: "jev-1.13.0",
    message: "m",
    question: "q",
    choices: [{ key: "a", description: "A" }],
    fetchImpl: (async () => new Response(JSON.stringify({ answers: { bot: { choice: "a" } } }), { status: 200 })) as unknown as typeof fetch,
  });
  expect(result).toMatchObject({ ok: true, choice: "a", confidence: 0 });
});

test("maskProxyUrl hides proxy credentials and leaves plain URLs alone", () => {
  expect(maskProxyUrl("http://user:s3cret@proxy.local:7890")).toBe("http://***@proxy.local:7890");
  expect(maskProxyUrl("http://user:s3cret@proxy.local:7890")).not.toContain("s3cret");
  expect(maskProxyUrl("http://onlyuser@proxy.local:7890")).toBe("http://***@proxy.local:7890");
  expect(maskProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  expect(maskProxyUrl(undefined)).toBeUndefined();
  expect(maskProxyUrl("")).toBeUndefined();
});

test("NO_PROXY skips the env proxy for matching hosts, never an explicit proxy", () => {
  const url = "https://api.typesafe.ai/v1/systemone";
  const env = { HTTPS_PROXY: "http://env:2", NO_PROXY: "localhost,.typesafe.ai" };
  expect(resolveJevProxyUrl(undefined, env, url)).toBeUndefined();
  expect(resolveJevProxyUrl(undefined, { ...env, NO_PROXY: undefined, no_proxy: "typesafe.ai" }, url)).toBeUndefined();
  expect(resolveJevProxyUrl(undefined, { ...env, NO_PROXY: "*" }, url)).toBeUndefined();
  expect(resolveJevProxyUrl(undefined, { ...env, NO_PROXY: "example.com" }, url)).toBe("http://env:2");
  expect(resolveJevProxyUrl("http://explicit:1", env, url)).toBe("http://explicit:1");
  expect(noProxyMatches(url, "api.typesafe.ai:443")).toBe(true);
  expect(noProxyMatches(url, "api.typesafe.ai:8443")).toBe(false);
  expect(noProxyMatches(url, "notypesafe.ai")).toBe(false);
});

test("an https:// proxy URL is rejected clearly instead of spoken to in plaintext", async () => {
  const result = await askJevChoice({
    endpoint: "https://jev.test/v1/systemone",
    apiKey: "sk-test-key",
    proxyUrl: "https://proxy.invalid:8443",
    model: "jev-1.13.0",
    message: "m",
    question: "q",
    choices: [{ key: "a", description: "A" }],
  });
  expect(result).toMatchObject({ ok: false, code: "network" });
  expect(result.ok ? "" : result.message).toContain("https:// proxy URLs are not supported");
});
