import { beforeAll, expect, test } from "bun:test";
import { createCipheriv, createHash } from "node:crypto";

import {
  createInjectedHttpServer,
  extractCardAction,
  startFeishuCardActionHost,
  type FeishuCardActionCallback,
} from "../../../../packages/channel-feishu/src/card-action-host";
import { parseFeishuChannelConfig } from "../../../../packages/channel-feishu/src/config";

/**
 * The Feishu card-callback channel's security contract.
 *
 * These tests exist because this endpoint is the trust anchor for M4: the
 * operator identity it hands to the renderer becomes an ACP `responderId`, so
 * every rejection path here is a path where a forged answer would otherwise be
 * accepted.
 */
const CONFIG = {
  encryptKey: "enc-key-1",
  verificationToken: "v-token-1",
  host: "127.0.0.1",
  port: 9871,
  path: "/webhook/card",
};

function actionBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "2.0",
    token: CONFIG.verificationToken,
    operator: { open_id: "ou_real_operator" },
    // Feishu echoes the button's tag at `action.tag`; the renderer's opaque
    // routing payload is `action.value`.
    action: { tag: "button", value: { token: "abc" } },
    ...overrides,
  });
}

/**
 * Build a Feishu-shaped encrypted envelope, using the exact scheme the host
 * decrypts (AES-256-CBC, key = SHA-256(encryptKey), IV prepended to the
 * ciphertext, NUL padding after the JSON). Round-tripping through the real
 * cipher is what makes the decrypt tests meaningful: a hand-written base64
 * blob would only prove the host rejects it.
 */
function encryptForTest(plaintext: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = Buffer.alloc(16, 0x11);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([iv, body]).toString("base64");
}

/**
 * Feishu's own signing rule, transcribed from the pinned SDK's `RequestHandle`:
 *
 *   new protocol (`encrypt` OR `schema` in the body) → encryptKey + SHA-256
 *   legacy (neither)                                 → verificationToken + SHA-1
 *
 * over `timestamp + nonce + secret + JSON.stringify(body)`. The harness bodies
 * carry `schema: "2.0"`, so they are all the NEW protocol.
 */
function signedHeaders(body: string, secret: string, algorithm: "sha256" | "sha1" = "sha256", nonce = "nonce-1"): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  // Feishu signs `JSON.stringify(body)`. A body that does not round-trip is
  // never one Feishu produced, and this harness must not throw on it: the point
  // of the malformed-body test is the host's rejection, not this helper.
  let signedContent: string;
  try {
    signedContent = JSON.stringify(JSON.parse(body));
  } catch {
    signedContent = body;
  }
  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": createHash(algorithm)
      .update(`${timestamp}${nonce}${secret}${signedContent}`, "utf8")
      .digest("hex"),
  };
}

async function harness(
  config = CONFIG,
): Promise<{
  post: (body: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>;
  get: (path: string) => Promise<{ status: number; body: string }>;
  seen: FeishuCardActionCallback[];
  outcomes: number[];
}> {
  const seen: FeishuCardActionCallback[] = [];
  const outcomes: number[] = [];
  const server = createInjectedHttpServer();
  await startFeishuCardActionHost({
    config,
    injectedServer: server,
    onAction: (callback) => {
      seen.push(callback);
      outcomes.push(1);
      return Promise.resolve({ ok: true });
    },
  });
  return {
    post: (body, headers) => {
      if (headers) return server.simulate("POST", config.path, headers, body);
      // The signing secret and algorithm depend on the push SHAPE, mirroring the
      // SDK: a body carrying `encrypt` or `schema` is the new protocol
      // (encryptKey + SHA-256); anything else is legacy (verificationToken +
      // SHA-1).
      //
      // An unparseable body is never signed: Feishu could not have produced one,
      // so the point of that test is that the host rejects it, and signing it
      // would only assert a digest over bytes that carry no meaning.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return server.simulate("POST", config.path, signedHeaders(body, config.verificationToken, "sha1"), body);
      }
      const isNewProtocol = typeof parsed.encrypt === "string" || typeof parsed.schema === "string";
      const secret = isNewProtocol ? config.encryptKey : config.verificationToken;
      const algorithm = isNewProtocol ? "sha256" : "sha1";
      return server.simulate("POST", config.path, signedHeaders(body, secret, algorithm), body);
    },
    get: (path) => server.simulate("GET", path, {}, ""),
    seen,
    outcomes,
  };
}

test("a verified card callback reaches the handler with the acting operator", async () => {
  const h = await harness();
  const response = await h.post(actionBody());
  expect(response.status).toBe(200);
  expect(h.seen).toHaveLength(1);
  expect(h.seen[0]!.openId).toBe("ou_real_operator");
  // Routing comes from the action tag, and the renderer's own payload travels
  // in `value`.
  expect(h.seen[0]!.action).toBe("button");
  expect(h.seen[0]!.value).toEqual({ token: "abc" });
});

test("a wrong verification token is rejected before any handler runs", async () => {
  const h = await harness();
  const response = await h.post(actionBody({ token: "v-token-WRONG" }));
  expect(response.status).toBe(401);
  // The identity is never produced, so a forged callback cannot reach a renderer.
  expect(h.seen).toHaveLength(0);
});

test("a missing verification token is rejected", async () => {
  const h = await harness();
  const body = actionBody();
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.token;
  const response = await h.post(JSON.stringify(parsed));
  expect(response.status).toBe(401);
  expect(h.seen).toHaveLength(0);
});

test("a callback with no secrets configured is rejected outright", async () => {
  const h = await harness({ ...CONFIG, encryptKey: "", verificationToken: "" });
  const response = await h.post(actionBody());
  // Fail closed: an endpoint that cannot prove the request came from Feishu
  // must not hand out an identity.
  expect(response.status).toBe(401);
  expect(h.seen).toHaveLength(0);
});

test("a token that merely differs in length is rejected", async () => {
  const h = await harness();
  const response = await h.post(actionBody({ token: "v-token-1-extended" }));
  expect(response.status).toBe(401);
  expect(h.seen).toHaveLength(0);
});

test("a callback carrying no operator is refused rather than answered", async () => {
  const h = await harness();
  const body = actionBody();
  const parsed = JSON.parse(body) as Record<string, unknown>;
  delete parsed.operator;
  const response = await h.post(JSON.stringify(parsed));
  // A verified request the plugin does not understand must not guess an
  // identity — there is no safe default for "who acted".
  expect(response.status).toBe(400);
  expect(h.seen).toHaveLength(0);
});

test("a callback with a non-string operator open_id is refused", async () => {
  const h = await harness();
  const response = await h.post(actionBody({ operator: { open_id: 12345 } }));
  expect(response.status).toBe(400);
  expect(h.seen).toHaveLength(0);
});

test("malformed JSON never reaches the handler", async () => {
  const h = await harness();
  const response = await h.post("{not json at all");
  expect(response.status).toBe(400);
  expect(h.seen).toHaveLength(0);
});

test("a GET probe is refused and leaks nothing about the route", async () => {
  const h = await harness();
  const response = await h.get(CONFIG.path);
  expect(response.status).toBe(405);
  expect(h.seen).toHaveLength(0);
});

test("a POST to a different path is not handled", async () => {
  const server = createInjectedHttpServer();
  const seen: FeishuCardActionCallback[] = [];
  await startFeishuCardActionHost({
    config: CONFIG,
    injectedServer: server,
    onAction: (callback) => {
      seen.push(callback);
      return Promise.resolve({ ok: true });
    },
  });
  // A valid, fully authenticated body delivered to the WRONG route is still
  // not handled: the route is part of the configuration Feishu was given.
  const wrong = await server.simulate("POST", "/webhook/not-this-one", signedHeaders(actionBody(), CONFIG.encryptKey, "sha256"), actionBody());
  expect(wrong.status).toBe(404);
  expect(seen).toHaveLength(0);
  // And the right route still works.
  const right = await server.simulate("POST", CONFIG.path, signedHeaders(actionBody(), CONFIG.encryptKey, "sha256"), actionBody());
  expect(right.status).toBe(200);
  expect(seen).toHaveLength(1);
});

test("Feishu's URL-verification challenge is echoed verbatim", async () => {
  const h = await harness();
  // The real challenge carries the verification token, so it must survive the
  // authenticity check and be recognized as a handshake rather than an action.
  const response = await h.post(JSON.stringify({
    challenge: "random-challenge-abc",
    token: CONFIG.verificationToken,
    type: "url_verification",
  }));
  expect(response.status).toBe(200);
  expect(response.body).toContain("random-challenge-abc");
  expect(h.seen).toHaveLength(0);
});

test("a challenge without the token is refused, not echoed", async () => {
  const h = await harness();
  // An unauthenticated challenge is not a handshake we owe an answer to:
  // echoing it would let anyone probe the endpoint for free.
  const response = await h.post(JSON.stringify({ challenge: "attacker-challenge" }));
  expect(response.status).toBe(401);
  expect(response.body).not.toContain("attacker-challenge");
});

test("form values are forwarded without the host inspecting them", async () => {
  const h = await harness();
  const response = await h.post(actionBody({
    form_value: { secret_note: "do-not-log-me", count: "3" },
  }));
  expect(response.status).toBe(200);
  expect(h.seen[0]!.formValues).toEqual({ secret_note: "do-not-log-me", count: "3" });
});

test("an ENCRYPTED push is decrypted and dispatched", async () => {
  // Feishu's encrypted push is { encrypt: "<base64 aes-256-cbc>" } and the key
  // is SHA-256(encryptKey). A successful decrypt IS the authenticity proof, so
  // the token is not needed on this path.
  const h = await harness({ ...CONFIG, encryptKey: "shared-key", verificationToken: "" });
  const response = await h.post(JSON.stringify({ encrypt: encryptForTest(actionBody(), "shared-key") }));
  expect(response.status).toBe(200);
  expect(h.seen[0]!.openId).toBe("ou_real_operator");
  expect(h.seen[0]!.value).toEqual({ token: "abc" });
});

test("an encrypted push with the WRONG key is rejected before any handler runs", async () => {
  const h = await harness({ ...CONFIG, encryptKey: "right-key", verificationToken: "" });
  const response = await h.post(JSON.stringify({ encrypt: encryptForTest(actionBody(), "WRONG-key") }));
  expect(response.status).toBe(401);
  expect(h.seen).toHaveLength(0);
});

test("an encrypted push with no key configured is rejected", async () => {
  const h = await harness({ ...CONFIG, encryptKey: "", verificationToken: "" });
  const response = await h.post(JSON.stringify({ encrypt: encryptForTest(actionBody(), "some-key") }));
  expect(response.status).toBe(401);
  expect(h.seen).toHaveLength(0);
});

test("a truncated encrypt envelope is rejected, not partially parsed", async () => {
  const h = await harness({ ...CONFIG, encryptKey: "shared-key", verificationToken: "" });
  const response = await h.post(JSON.stringify({ encrypt: Buffer.from("short").toString("base64") }));
  expect(response.status).toBe(401);
  expect(h.seen).toHaveLength(0);
});

test("a legacy callback still authenticates on the verification token alone", async () => {
  // A body with NEITHER `encrypt` NOR `schema`: the legacy branch, where
  // verificationToken + SHA-1 is the whole contract. The payload is shaped
  // deliberately to MISS the new-protocol markers — the encryptKey being set is
  // irrelevant here, so this still exercises the branch it was written for.
  const h = await harness({ ...CONFIG, encryptKey: "", verificationToken: "v-token-1" });
  const legacy = JSON.parse(actionBody()) as Record<string, unknown>;
  delete legacy.schema;
  legacy.token = "v-token-1";
  const response = await h.post(JSON.stringify(legacy));
  expect(response.status).toBe(200);
  expect(h.seen[0]!.openId).toBe("ou_real_operator");
});

test("a legacy push delivered alongside an encryptKey still uses the token branch", async () => {
  // Feishu can deliver either protocol regardless of what is configured, so a
  // fully-configured endpoint must still authenticate a legacy (unmarked) push
  // on the echoed token with SHA-1 — signing it with the encrypt key and
  // SHA-256 here would be rejected, which is what makes this a real branch
  // assertion rather than a mirror of the new-protocol path.
  const h = await harness(CONFIG);
  const legacy = JSON.parse(actionBody()) as Record<string, unknown>;
  delete legacy.schema;
  const response = await h.post(JSON.stringify(legacy));
  expect(response.status).toBe(200);
  expect(h.seen[0]!.openId).toBe("ou_real_operator");
});

test("a rejected callback logs the reason class, not the body", async () => {
  const logged: Array<Record<string, string | number | boolean | undefined>> = [];
  const server = createInjectedHttpServer();
  await startFeishuCardActionHost({
    config: CONFIG,
    injectedServer: server,
    onAction: () => Promise.resolve({ ok: true }),
    log: (_event, _message, fields) => {
      if (fields) logged.push(fields);
    },
  });
  await server.simulate("POST", CONFIG.path, signedHeaders(actionBody({ token: "bad" }), CONFIG.encryptKey, "sha256"), actionBody({ token: "bad" }));
  expect(logged).toHaveLength(1);
  expect(logged[0]!.reason).toBe("unauthorized");
  // No body content is ever captured: the payload may be attacker-supplied.
  const serialized = JSON.stringify(logged);
  expect(serialized).not.toContain("ou_real_operator");
  expect(serialized).not.toContain("elicit:submit");
});

test("a throwing handler does not take the endpoint down", async () => {
  const server = createInjectedHttpServer();
  const logged: string[] = [];
  await startFeishuCardActionHost({
    config: CONFIG,
    injectedServer: server,
    onAction: () => {
      throw new Error("renderer exploded");
    },
    log: (event) => {
      logged.push(event);
    },
  });
  const first = await server.simulate("POST", CONFIG.path, signedHeaders(actionBody(), CONFIG.encryptKey, "sha256"), actionBody());
  expect(first.status).toBe(500);
  // The server still answers afterwards.
  const second = await server.simulate("POST", CONFIG.path, signedHeaders(actionBody(), CONFIG.encryptKey, "sha256"), actionBody());
  expect(second.status).toBe(500);
  expect(logged).toContain("feishu.card.server_error");
});

test("extractCardAction refuses payloads the renderer did not shape", async () => {
  // The renderer's own `action.value` object is the only correlation handle, so
  // a payload with a non-object value is refused rather than guessed at.
  expect(extractCardAction({ operator: { open_id: "ou_1" }, action: { tag: "button", value: { token: "t" } } })).toEqual({
    openId: "ou_1",
    action: "button",
    value: { token: "t" },
    formValues: {},
  });
  expect(extractCardAction({ operator: { open_id: "ou_1" }, action: { tag: "button", value: [1, 2] } })).toBeNull();
  expect(extractCardAction({ operator: { open_id: "ou_1" }, action: { tag: "button" } })).toBeNull();
  expect(extractCardAction({ operator: { open_id: "ou_1" } })).toBeNull();
  expect(extractCardAction({ action: { value: {} } })).toBeNull();
  expect(extractCardAction(null)).toBeNull();
  expect(extractCardAction({})).toBeNull();
});

test("config rejects a card endpoint missing either secret", () => {
  // Token-only used to parse here, and it is exactly the broken state: the host
  // signs every new-protocol callback with the encrypt key, so a config
  // carrying only the verification token would start cleanly and then 401
  // every real click. The parse must refuse that config instead of shipping it.
  expect(() => parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: { port: 9871, verificationToken: "t" } } },
  })).toThrow(/encryptKey is required/);

  expect(() => parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: { port: 9871 } } },
  })).toThrow(/encryptKey is required/);

  // And the mirror image, which the encryptKey-only fix left open: the
  // URL-verification challenge arrives with no `schema` and no `encrypt`, so it
  // is verified on the legacy (token + SHA-1) branch. That check runs BEFORE the
  // challenge is read, so a token-less config can never echo it and the endpoint
  // can never finish being configured.
  expect(() => parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: { port: 9871, encryptKey: "k" } } },
  })).toThrow(/verificationToken is required: the URL-verification challenge/);
});

test("config rejects a non-integer or out-of-range port", () => {
  for (const port of ["9871", 0, 70000, 1.5]) {
    expect(() => parseFeishuChannelConfig({
      appId: "a", appSecret: "b",
      accounts: { default: { appId: "a", appSecret: "b", cardActions: { port, encryptKey: "k", verificationToken: "t" } } },
    })).toThrow(/port must be an integer/);
  }
});

test("config defaults the bind host to loopback and the path to /webhook/card", () => {
  const parsed = parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: { port: 9871, encryptKey: "k", verificationToken: "t" } } },
  });
  // Loopback by default: a public interface must be an explicit operator choice.
  expect(parsed.accounts[0]!.cardActions).toEqual({
    encryptKey: "k",
    verificationToken: "t",
    host: "127.0.0.1",
    port: 9871,
    path: "/webhook/card",
  });
});

test("config requires both secrets: each handshake needs its own key", () => {
  // Both directions are dead configurations, and both must be refused at parse
  // time. The encrypt key signs the new-protocol card action; the verification
  // token signs the URL-verification challenge, which Feishu delivers with
  // neither `schema` nor `encrypt` and which is read only AFTER the signature
  // check — so an endpoint holding just one of them either 401s every click or
  // can never complete the handshake that puts it into service.
  expect(() => parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: { port: 9871, encryptKey: "k" } } },
  })).toThrow(/verificationToken is required/);
  expect(() => parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: { port: 9871, verificationToken: "t" } } },
  })).toThrow(/encryptKey is required/);
});

test("config keeps cardActions per account instead of sharing one listener", () => {
  const parsed = parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: {
      alpha: { appId: "a1", appSecret: "s1", cardActions: { port: 9001, encryptKey: "k1", verificationToken: "t1" } },
      beta: { appId: "a2", appSecret: "s2", cardActions: { port: 9002, encryptKey: "k2", verificationToken: "t2" } },
    },
  });
  expect(parsed.accounts[0]!.cardActions!.port).toBe(9001);
  expect(parsed.accounts[1]!.cardActions!.port).toBe(9002);
});

test("absent cardActions means no card channel at all", () => {
  const parsed = parseFeishuChannelConfig({ appId: "a", appSecret: "b" });
  expect(parsed.accounts[0]!.cardActions).toBeUndefined();
});

test("cardActions: false is accepted as an explicit opt-out", () => {
  const parsed = parseFeishuChannelConfig({
    appId: "a", appSecret: "b",
    accounts: { default: { appId: "a", appSecret: "b", cardActions: false } },
  });
  expect(parsed.accounts[0]!.cardActions).toBeUndefined();
});
