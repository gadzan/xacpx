import { expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";

import {
  askJevChoice,
  maskJevKey,
  maskProxyUrl,
  noProxyMatches,
  redactJevSecrets,
  resolveJevProxyUrl,
  type JevAskInput,
} from "../../../src/conversations/jev-client";

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
      // Isolate from an ambient NO_PROXY (often lists 127.0.0.1), which an
      // explicit proxy now honors too.
      env: {},
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
      env: {},
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

test("NO_PROXY skips both the env proxy and an explicit proxy for matching hosts", () => {
  const url = "https://api.typesafe.ai/v1/systemone";
  const env = { HTTPS_PROXY: "http://env:2", NO_PROXY: "localhost,.typesafe.ai" };
  expect(resolveJevProxyUrl(undefined, env, url)).toBeUndefined();
  expect(resolveJevProxyUrl(undefined, { ...env, NO_PROXY: undefined, no_proxy: "typesafe.ai" }, url)).toBeUndefined();
  expect(resolveJevProxyUrl(undefined, { ...env, NO_PROXY: "*" }, url)).toBeUndefined();
  expect(resolveJevProxyUrl(undefined, { ...env, NO_PROXY: "example.com" }, url)).toBe("http://env:2");
  // An explicit Jev proxy honors NO_PROXY for the target host as well.
  expect(resolveJevProxyUrl("http://explicit:1", env, url)).toBeUndefined();
  expect(resolveJevProxyUrl("http://explicit:1", { ...env, NO_PROXY: "example.com" }, url)).toBe("http://explicit:1");
  expect(resolveJevProxyUrl("http://explicit:1", {}, url)).toBe("http://explicit:1");
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

test("NO_PROXY host names match exactly or on a dot-suffix label boundary", () => {
  const url = "https://api.example.com/v1";
  expect(noProxyMatches(url, "api.example.com")).toBe(true);
  expect(noProxyMatches(url, "example.com")).toBe(true);
  expect(noProxyMatches(url, ".example.com")).toBe(true);
  expect(noProxyMatches(url, "*.example.com")).toBe(true);
  expect(noProxyMatches("https://example.com/", ".example.com")).toBe(true);
  // Never a raw string suffix.
  expect(noProxyMatches("https://badexample.com/", "example.com")).toBe(false);
  expect(noProxyMatches("https://badexample.com/", ".example.com")).toBe(false);
  expect(noProxyMatches(url, "other.example.com")).toBe(false);
  expect(noProxyMatches(url, "API.Example.COM")).toBe(true);
  expect(noProxyMatches(url, "example.com.")).toBe(true);
  // `*` only counts as a whole entry; an inner wildcard is ignored, not widened.
  expect(noProxyMatches(url, "*")).toBe(true);
  expect(noProxyMatches(url, " foo.test , * ")).toBe(true);
  expect(noProxyMatches(url, "a*.example.com")).toBe(false);
  expect(noProxyMatches(url, "")).toBe(false);
  expect(noProxyMatches(url, ",, ,")).toBe(false);
  // Comma and whitespace separators.
  expect(noProxyMatches(url, "foo.test example.com")).toBe(true);
});

test("NO_PROXY port restrictions use the target's effective port", () => {
  expect(noProxyMatches("https://api.example.com/", "example.com:443")).toBe(true);
  expect(noProxyMatches("https://api.example.com/", "example.com:80")).toBe(false);
  expect(noProxyMatches("http://api.example.com/", "example.com:80")).toBe(true);
  expect(noProxyMatches("https://api.example.com:8443/", "example.com:8443")).toBe(true);
  expect(noProxyMatches("https://api.example.com:8443/", "example.com")).toBe(true);
  expect(noProxyMatches("https://api.example.com:8443/", "example.com:443")).toBe(false);
  expect(noProxyMatches("https://api.example.com/", "example.com:notaport")).toBe(false);
});

test("NO_PROXY IP literals match the address only, never as a suffix", () => {
  expect(noProxyMatches("http://10.0.0.1/", "10.0.0.1")).toBe(true);
  expect(noProxyMatches("http://10.0.0.1/", "0.0.1")).toBe(false);
  expect(noProxyMatches("http://110.0.0.1/", "10.0.0.1")).toBe(false);
  expect(noProxyMatches("http://10.0.0.1:8080/", "10.0.0.1:8080")).toBe(true);
  expect(noProxyMatches("http://10.0.0.1:8080/", "10.0.0.1:9090")).toBe(false);
  // A host name never matches an IP entry and vice versa.
  expect(noProxyMatches("http://10.0.0.1/", "localhost")).toBe(false);
  expect(noProxyMatches("http://localhost/", "127.0.0.1")).toBe(false);
});

test("NO_PROXY IPv6 literals parse with and without brackets and ports", () => {
  expect(noProxyMatches("http://[::1]/", "::1")).toBe(true);
  expect(noProxyMatches("http://[::1]/", "[::1]")).toBe(true);
  expect(noProxyMatches("http://[::1]:8080/", "[::1]:8080")).toBe(true);
  expect(noProxyMatches("http://[::1]:8080/", "[::1]:9090")).toBe(false);
  expect(noProxyMatches("http://[::1]:8080/", "[::1]")).toBe(true);
  // Equivalent spellings of one address match.
  expect(noProxyMatches("http://[0:0:0:0:0:0:0:1]/", "::1")).toBe(true);
  expect(noProxyMatches("http://[2001:db8::1]/", "2001:DB8:0::1")).toBe(true);
  // `::1` used to parse as host ":" port "1"; it must not match anything else.
  expect(noProxyMatches("http://[::2]/", "::1")).toBe(false);
  expect(noProxyMatches("http://[::1]/", "[::1")).toBe(false);
  expect(noProxyMatches("http://127.0.0.1/", "::1")).toBe(false);
});

test("NO_PROXY CIDR ranges match IP literals inside them", () => {
  expect(noProxyMatches("http://10.1.2.3/", "10.0.0.0/8")).toBe(true);
  expect(noProxyMatches("http://11.1.2.3/", "10.0.0.0/8")).toBe(false);
  expect(noProxyMatches("http://192.168.1.77/", "192.168.1.0/24")).toBe(true);
  expect(noProxyMatches("http://192.168.2.77/", "192.168.1.0/24")).toBe(false);
  expect(noProxyMatches("http://1.2.3.4/", "0.0.0.0/0")).toBe(true);
  expect(noProxyMatches("http://[fd00::abcd]/", "fd00::/8")).toBe(true);
  expect(noProxyMatches("http://[fe80::1]/", "fd00::/8")).toBe(false);
  // A CIDR never matches a host name; an out-of-range prefix is ignored.
  expect(noProxyMatches("https://api.example.com/", "10.0.0.0/8")).toBe(false);
  expect(noProxyMatches("http://10.1.2.3/", "10.0.0.0/33")).toBe(false);
});

const PROXY_SECRET = "s3cretpass";
const PROXY_WITH_CREDS = `http://proxyuser:${PROXY_SECRET}@127.0.0.1:7890`;

function expectNoSecret(text: string): void {
  expect(text).not.toContain(PROXY_SECRET);
  expect(text).not.toContain("proxyuser");
  expect(text).not.toContain("sk-test-key");
}

test("redactJevSecrets scrubs URL userinfo, the proxy credentials, and the key", () => {
  const out = redactJevSecrets(
    `connect to ${PROXY_WITH_CREDS} failed; user proxyuser pass ${PROXY_SECRET}; Bearer sk-test-key; other https://a:b@x.test/p`,
    { proxyUrls: [PROXY_WITH_CREDS], apiKey: "sk-test-key" },
  );
  expectNoSecret(out);
  expect(out).toContain("http://***@127.0.0.1:7890");
  expect(out).toContain("https://***@x.test/p");
  // Percent-encoded credentials are scrubbed in both forms.
  const encoded = redactJevSecrets("auth p@ss:word and p%40ss%3Aword", {
    proxyUrls: ["http://bob:p%40ss%3Aword@proxy.test:1"],
  });
  expect(encoded).not.toContain("p@ss:word");
  expect(encoded).not.toContain("p%40ss%3Aword");
  // Plain text without secrets is unchanged.
  expect(redactJevSecrets("Jev answered HTTP 500.", { proxyUrls: ["http://127.0.0.1:1"] })).toBe("Jev answered HTTP 500.");
});

test("an http-error body that echoes the proxy URL or key is redacted", async () => {
  const { fetchImpl } = recordingFetch(() => new Response(
    `bad gateway via ${PROXY_WITH_CREDS} (proxyuser/${PROXY_SECRET}) auth=Bearer sk-test-key`,
    { status: 502 },
  ));
  const result = await askJevChoice(input({ fetchImpl, proxyUrl: PROXY_WITH_CREDS }));
  expect(result).toMatchObject({ ok: false, code: "http-error" });
  if (result.ok) return;
  expectNoSecret(result.message);
  expect(result.message).toContain("***");
});

test("a secret straddling the http-error excerpt bound is not left half-visible", async () => {
  const { fetchImpl } = recordingFetch(() => new Response(`${"x".repeat(195)}${PROXY_SECRET} tail`, { status: 500 }));
  const result = await askJevChoice(input({ fetchImpl, proxyUrl: PROXY_WITH_CREDS }));
  expect(result).toMatchObject({ ok: false, code: "http-error" });
  if (result.ok) return;
  expect(result.message).not.toContain(PROXY_SECRET.slice(0, 5));
});

test("a network error that names the proxy URL is redacted", async () => {
  const fetchImpl = (async () => {
    throw new Error(`connect ECONNREFUSED via ${PROXY_WITH_CREDS}`);
  }) as unknown as typeof fetch;
  const result = await askJevChoice(input({ fetchImpl, proxyUrl: PROXY_WITH_CREDS }));
  expect(result).toMatchObject({ ok: false, code: "network" });
  if (result.ok) return;
  expectNoSecret(result.message);
  expect(result.message).toContain("http://***@127.0.0.1:7890");
});

test("credentials from an HTTPS_PROXY fallback are redacted too", async () => {
  const fetchImpl = (async () => {
    throw new Error(`proxy ${PROXY_WITH_CREDS} refused`);
  }) as unknown as typeof fetch;
  const result = await askJevChoice(input({ fetchImpl, env: { HTTPS_PROXY: PROXY_WITH_CREDS } }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expectNoSecret(result.message);
});

test("an unparseable proxy URL with credentials is never echoed", async () => {
  const result = await askJevChoice(input({
    endpoint: "http://127.0.0.1:9/v1/systemone",
    proxyUrl: `http://proxyuser:${PROXY_SECRET}@[not-a-host`,
    env: {},
    timeoutMs: 2_000,
  }));
  expect(result).toMatchObject({ ok: false, code: "network" });
  if (result.ok) return;
  expectNoSecret(result.message);
  expect(result.message).toContain("not a valid URL");
});

test("a proxy that echoes its credentials in the CONNECT refusal is redacted", async () => {
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    // A hostile/buggy proxy reflecting the Proxy-Authorization it received.
    const auth = String(req.headers["proxy-authorization"] ?? "");
    const decoded = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8");
    socket.write(`HTTP/1.1 407 denied ${decoded}\r\n\r\n`);
    socket.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const result = await askJevChoice(input({
      endpoint: "http://127.0.0.1:9/v1/systemone",
      proxyUrl: `http://proxyuser:${PROXY_SECRET}@127.0.0.1:${proxyPort}`,
      env: {},
      timeoutMs: 5_000,
    }));
    expect(result).toMatchObject({ ok: false, code: "network" });
    if (result.ok) return;
    expect(result.message).toContain("407");
    expectNoSecret(result.message);
  } finally {
    proxy.close();
  }
});

test("an unencoded @ in a proxy password is redacted whole, not left as a fragment", () => {
  const raw = "http://bob:p@ssword123@proxy.test:8080";
  // The userinfo regex alone (no configured proxy) runs to the last `@`.
  expect(redactJevSecrets(`connect ${raw} failed`)).toBe("connect http://***@proxy.test:8080 failed");
  // With the configured proxy the verbatim password (raw `@`) goes too.
  const out = redactJevSecrets(`connect ${raw} failed; pass p@ssword123; enc p%40ssword123`, { proxyUrls: [raw] });
  expect(out).toContain("http://***@proxy.test:8080");
  expect(out).not.toContain("ssword123");
});

test("two credentialed URLs in one message are redacted separately, never merged", () => {
  const spaced = redactJevSecrets("a http://u1:p@w1@h1.test:1/x then https://u2:p@w2@h2.test:2 end");
  expect(spaced).toBe("a http://***@h1.test:1/x then https://***@h2.test:2 end");
  const adjacent = redactJevSecrets("http://u1:p@w1@h1.test,http://u2:pw2@h2.test");
  expect(adjacent).toBe("http://***@h1.test,http://***@h2.test");
  const quoted = redactJevSecrets(`"http://u1:pw1@h1.test" and "mail@example.test"`);
  expect(quoted).toBe(`"http://***@h1.test" and "mail@example.test"`);
});

test("the Basic proxy credential and Authorization header values are redacted", () => {
  const proxyUrl = "http://proxyuser:p%40ss%3Aw0rd@127.0.0.1:7890";
  const b64Decoded = Buffer.from("proxyuser:p@ss:w0rd").toString("base64");
  const b64Raw = Buffer.from("proxyuser:p%40ss%3Aw0rd").toString("base64");
  const body = [
    "407 echoed request headers:",
    `Proxy-Authorization: Basic ${b64Decoded}`,
    "Authorization: Bearer some-other-bearer-token",
    `x-seen-auth ${b64Decoded} / ${b64Raw}`,
  ].join("\n");
  const out = redactJevSecrets(body, { proxyUrls: [proxyUrl] });
  expect(out).not.toContain(b64Decoded);
  expect(out).not.toContain(b64Raw);
  expect(out).not.toContain("some-other-bearer-token");
  expect(out).toContain("Proxy-Authorization: Basic ***");
  expect(out).toContain("Authorization: Bearer ***");
  // A Basic header for credentials we were never told about is still scrubbed.
  const foreign = Buffer.from("someone:else").toString("base64");
  expect(redactJevSecrets(`proxy-authorization: basic ${foreign}`)).toBe("proxy-authorization: basic ***");
  // Prose mentioning authorization is left alone.
  expect(redactJevSecrets("authorization: required by proxy")).toBe("authorization: required by proxy");
});

test("an http-error body echoing the HTTPS_PROXY Basic credential is redacted", async () => {
  const b64 = Buffer.from(`proxyuser:${PROXY_SECRET}`).toString("base64");
  const { fetchImpl } = recordingFetch(() => new Response(
    `bad gateway; saw credential ${b64}\nProxy-Authorization: Basic ${b64}`,
    { status: 502 },
  ));
  const result = await askJevChoice(input({ fetchImpl, env: { HTTPS_PROXY: PROXY_WITH_CREDS } }));
  expect(result).toMatchObject({ ok: false, code: "http-error" });
  if (result.ok) return;
  expect(result.message).not.toContain(b64);
  expect(result.message).not.toContain(b64.slice(0, 12));
});

test("a proxy reflecting the raw Proxy-Authorization of a password with @ is redacted", async () => {
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    const auth = String(req.headers["proxy-authorization"] ?? "");
    socket.write(`HTTP/1.1 407 denied ${auth.replace(/^Basic /, "")}\r\n\r\n`);
    socket.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const result = await askJevChoice(input({
      endpoint: "http://127.0.0.1:9/v1/systemone",
      proxyUrl: `http://proxyuser:s3cret@pass@127.0.0.1:${proxyPort}`,
      env: {},
      timeoutMs: 5_000,
    }));
    expect(result).toMatchObject({ ok: false, code: "network" });
    if (result.ok) return;
    expect(result.message).toContain("407");
    expect(result.message).not.toContain(Buffer.from("proxyuser:s3cret@pass").toString("base64"));
    expect(result.message).not.toContain("s3cret");
  } finally {
    proxy.close();
  }
});
