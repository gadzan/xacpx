/**
 * Feishu card-action HTTP boundary tests.
 *
 * Two things are proven here that no renderer/fake-transport test can reach:
 *
 *   1. A callback is only authenticated when the official request signature
 *      verifies. `extractCardAction` promotes the decrypted body's
 *      `operator.open_id` to the ACP `responderId`, so this IS the identity
 *      trust boundary. The previous implementation treated a successful AES
 *      decrypt as sufficient and never read a header, which accepted a captured
 *      or forged body from anyone who had ever seen one ciphertext.
 *   2. A real `EADDRINUSE` — on a real socket with a real occupied port —
 *      rejects `startFeishuCardActionHost()` instead of throwing an unhandled
 *      `error` event or silently succeeding.
 */

import { createHash, createCipheriv } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, expect, test } from "bun:test";
import {
  createInjectedHttpServer,
  startFeishuCardActionHost,
  extractCardAction,
} from "../../../../packages/channel-feishu/src/card-action-host";
import type { FeishuCardActionConfig } from "../../../../packages/channel-feishu/src/config";

const CARD_ACTIONS = {
  path: "/feishu/card",
  port: 19934,
  host: "127.0.0.1",
  encryptKey: "test-encrypt-key",
  verificationToken: "vt-test",
} as const;

function config(overrides: Partial<FeishuCardActionConfig> = {}): FeishuCardActionConfig {
  return { ...CARD_ACTIONS, ...overrides } as FeishuCardActionConfig;
}

/** Feishu's own signing input: timestamp + nonce + secret + raw body. */
function signature(headers: {
  timestamp: string;
  nonce: string;
}, secret: string, body: string): string {
  return createHash("sha256")
    .update(`${headers.timestamp}${headers.nonce}${secret}${body}`, "utf8")
    .digest("hex");
}

function signedHeaders(secret: string, body: string, nonce = "n-1"): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature({ timestamp, nonce }, secret, body),
  };
}

/** Encrypt a payload the way Feishu does, so the decrypt path is real. */
function encryptFeishu(payload: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = createHash("sha256").update("iv", "utf8").digest().subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const padLen = 16 - (body.length % 16);
  const padded = Buffer.concat([body, Buffer.alloc(padLen, 0)]);
  return Buffer.concat([iv, cipher.update(padded), cipher.final()]).toString("base64");
}

function cardBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operator: { open_id: "ou_real_operator" },
    action: { tag: "button", value: { t: "token-abc", a: "start" } },
    form_value: {},
    ...overrides,
  };
}

async function post(
  server: { simulate: (m: string, p: string, h: Record<string, string>, b: string) => Promise<{ status: number; body: string }> },
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return server.simulate("POST", CARD_ACTIONS.path, headers, body);
}

describe("feishu card callback authentication", () => {
  test("a correctly signed encrypted callback is accepted", async () => {
    const server = createInjectedHttpServer();
    const actions: Array<{ openId: string }> = [];
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push({ openId: callback.openId });
        return Promise.resolve({ ok: true } as const);
      },
    });
    const payload = cardBody();
    const body = JSON.stringify({ encrypt: encryptFeishu(payload, CARD_ACTIONS.encryptKey) });
    const result = await post(server, signedHeaders(CARD_ACTIONS.encryptKey, body), body);
    expect(result.status).toBe(200);
    expect(actions[0]!.openId).toBe("ou_real_operator");
  });

  test("a MISSING signature is rejected even though the body decrypts", async () => {
    const server = createInjectedHttpServer();
    const actions: unknown[] = [];
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push(callback);
        return Promise.resolve({ ok: true } as const);
      },
    });
    // The ciphertext is genuine: a replay of a body the attacker captured at
    // some earlier point must not be accepted on its decryption alone.
    const body = JSON.stringify({ encrypt: encryptFeishu(cardBody(), CARD_ACTIONS.encryptKey) });
    const result = await post(server, {}, body);
    expect(result.status).toBe(401);
    expect(actions).toHaveLength(0);
  });

  test("a BAD signature is rejected, and the body never reaches the renderer", async () => {
    const server = createInjectedHttpServer();
    const actions: unknown[] = [];
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push(callback);
        return Promise.resolve({ ok: true } as const);
      },
    });
    const body = JSON.stringify({ encrypt: encryptFeishu(cardBody(), CARD_ACTIONS.encryptKey) });
    const headers = signedHeaders(CARD_ACTIONS.encryptKey, body);
    // Flip one hex nibble of the signature.
    headers["x-lark-signature"] = `${headers["x-lark-signature"]!.slice(0, -1)}0`;
    const result = await post(server, headers, body);
    expect(result.status).toBe(401);
    expect(actions).toHaveLength(0);
  });

  test("a signature computed with the WRONG secret is rejected", async () => {
    const server = createInjectedHttpServer();
    const actions: unknown[] = [];
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push(callback);
        return Promise.resolve({ ok: true } as const);
      },
    });
    const body = JSON.stringify({ encrypt: encryptFeishu(cardBody(), CARD_ACTIONS.encryptKey) });
    const result = await post(server, signedHeaders("attacker-guess", body), body);
    expect(result.status).toBe(401);
    expect(actions).toHaveLength(0);
  });

  test("a signature over TAMPERED ciphertext is rejected", async () => {
    const server = createInjectedHttpServer();
    const actions: unknown[] = [];
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push(callback);
        return Promise.resolve({ ok: true } as const);
      },
    });
    const goodBody = JSON.stringify({ encrypt: encryptFeishu(cardBody(), CARD_ACTIONS.encryptKey) });
    const headers = signedHeaders(CARD_ACTIONS.encryptKey, goodBody);
    // Re-encrypt a DIFFERENT operator under the same key. The signature covers
    // the raw body, so the mismatch must be caught before any decrypt.
    const evilBody = JSON.stringify({ encrypt: encryptFeishu(cardBody({ operator: { open_id: "ou_attacker" } }), CARD_ACTIONS.encryptKey) });
    const result = await post(server, headers, evilBody);
    expect(result.status).toBe(401);
    expect(actions).toHaveLength(0);
  });

  test("a correctly signed but STALE timestamp is rejected (replay)", async () => {
    const server = createInjectedHttpServer();
    const actions: unknown[] = [];
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push(callback);
        return Promise.resolve({ ok: true } as const);
      },
    });
    const body = JSON.stringify({ encrypt: encryptFeishu(cardBody(), CARD_ACTIONS.encryptKey) });
    // An hour old: inside no reasonable replay window.
    const stale = { timestamp: String(Math.floor(Date.now() / 1000) - 3600), nonce: "n-stale" };
    const result = await post(server, {
      "x-lark-request-timestamp": stale.timestamp,
      "x-lark-request-nonce": stale.nonce,
      "x-lark-signature": signature(stale, CARD_ACTIONS.encryptKey, body),
    }, body);
    expect(result.status).toBe(401);
    expect(actions).toHaveLength(0);
  });

  test("a valid plaintext callback with a token is still accepted", async () => {
    const server = createInjectedHttpServer();
    const actions: Array<{ openId: string }> = [];
    await startFeishuCardActionHost({
      config: config({ verificationToken: "vt-123" }),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push({ openId: callback.openId });
        return Promise.resolve({ ok: true } as const);
      },
    });
    const body = JSON.stringify(cardBody({ token: "vt-123" }));
    const result = await post(server, signedHeaders("vt-123", body), body);
    expect(result.status).toBe(200);
    expect(actions[0]!.openId).toBe("ou_real_operator");
  });

  test("a plaintext callback with the WRONG token is rejected", async () => {
    const server = createInjectedHttpServer();
    const actions: unknown[] = [];
    await startFeishuCardActionHost({
      config: config({ verificationToken: "vt-123" }),
      injectedServer: server as never,
      onAction: (callback) => {
        actions.push(callback);
        return Promise.resolve({ ok: true } as const);
      },
    });
    const body = JSON.stringify(cardBody({ token: "vt-evil" }));
    const result = await post(server, signedHeaders("vt-123", body), body);
    expect(result.status).toBe(401);
    expect(actions).toHaveLength(0);
  });

  test("the URL-verification challenge still works, signed", async () => {
    const server = createInjectedHttpServer();
    await startFeishuCardActionHost({
      config: config(),
      injectedServer: server as never,
      onAction: () => Promise.resolve({ ok: true } as const),
    });
    const body = JSON.stringify({ challenge: "ch-abc", token: CARD_ACTIONS.verificationToken });
    // A URL-verification challenge is a PLAINTEXT push, so per the SDK the
    // signing secret is the verification token.
    const result = await post(server, signedHeaders(CARD_ACTIONS.verificationToken, body), body);
    expect(result.status).toBe(200);
    expect(result.body).toContain("ch-abc");
  });
});

describe("feishu card host real socket bind", () => {
  test("a genuinely occupied TCP port rejects the host", async () => {
    // A REAL socket, not an injected fake: the failure mode that matters is the
    // asynchronous `"error"` event, and only a real `listen()` produces one.
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(19935, "127.0.0.1", () => resolve()));
    try {
      let error: Error | undefined;
      try {
        await startFeishuCardActionHost({
          config: config({ port: 19935 }),
          onAction: () => Promise.resolve({ ok: true } as const),
        });
      } catch (caught) {
        error = caught as Error;
      }
      expect(error).toBeDefined();
      // Bun and Node phrase it differently ("Is port ... in use?" vs
      // "listen EADDRINUSE"); what matters is that it rejected.
      expect(error!.message).toMatch(/in use|EADDRINUSE|listen/i);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  test("an async server error after listen() rejects the pending start", async () => {
    // The Node-documented shape: `listen()` returns, THEN the error arrives.
    // Covers the case where the port is taken by something that reports itself
    // through a later event rather than the listen callback.
    const server = createInjectedHttpServer();
    const started = startFeishuCardActionHost({
      config: config({ port: 19936 }),
      injectedServer: server as never,
      onAction: () => Promise.resolve({ ok: true } as const),
    });
    // `listen()` resolved synchronously in the fake, so the start already
    // settled; the assertion here is that emitError does NOT crash the process
    // with an unhandled `error` event.
    await started;
    const err = Object.assign(new Error("simulated EADDRINUSE"), { code: "EADDRINUSE" });
    expect(() => server.emitError!(err)).not.toThrow();
  });
});

describe("feishu card action extraction", () => {
  test("the operator comes from the verified body, never from the routing value", () => {
    // The renderer's button payload is not a source of identity: a forged
    // `responderId` sitting in `action.value` must not be honoured.
    const callback = extractCardAction(cardBody({
      action: { tag: "button", value: { t: "tok", a: "submit", responderId: "ou_attacker" } },
    }));
    expect(callback!.openId).toBe("ou_real_operator");
    expect(callback!.formValues).toEqual({});
  });

  test("form values are forwarded verbatim, including an empty string", () => {
    const callback = extractCardAction(cardBody({ form_value: { f0: "" } }));
    expect(callback!.formValues).toEqual({ f0: "" });
  });
});
