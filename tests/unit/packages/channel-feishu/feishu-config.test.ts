import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../../../../src/config/load-config";
import { parseFeishuChannelConfig } from "../../../../packages/channel-feishu/src/config";

async function writeConfig(raw: unknown): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-feishu-config-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(raw));
  return { dir, path };
}

const baseConfig = {
  transport: { type: "acpx-bridge" },
  agents: { codex: { driver: "codex" } },
  workspaces: {},
};

test("loads feishu channel config options", async () => {
  const { dir, path } = await writeConfig({
    ...baseConfig,
    channel: {
      type: "feishu",
      replyMode: "final",
      options: {
        appId: "cli_test",
        appSecret: "secret_test",
      },
    },
  });

  try {
    const config = await loadConfig(path);
    expect(config.channel.options).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps legacy feishu to options", async () => {
  const { dir, path } = await writeConfig({
    ...baseConfig,
    channel: {
      type: "feishu",
      replyMode: "final",
      feishu: {
        appId: "cli_test",
        appSecret: "secret_test",
      },
    },
  });

  try {
    const config = await loadConfig(path);
    expect(config.channel.options).toEqual({
      appId: "cli_test",
      appSecret: "secret_test",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseFeishuChannelConfig promotes legacy single-bot config to default account", () => {
  const raw = {
    appId: "cli_test",
    appSecret: "secret_test",
  };
  const config = parseFeishuChannelConfig(raw);

  expect(config.defaultAccount).toBe("default");
  expect(config.textMessageFormat).toBe("text");
  expect(config.dedupTtlMs).toBe(43_200_000);
  expect(config.dedupMaxEntries).toBe(5000);
  expect(config.accounts).toEqual([
    {
      accountId: "default",
      enabled: true,
      configured: true,
      appId: "cli_test",
      appSecret: "secret_test",
      domain: "feishu",
      requireMention: true,
      dmPolicy: "open",
      groupPolicy: "open",
      allowFrom: [],
    replyMode: "auto",
    trustGroupOwner: false,
    },
  ]);
});

test("parseFeishuChannelConfig parses multi-bot accounts with per-account overrides", () => {
  const raw = {
    defaultAccount: "main",
    requireMention: true,
    domain: "feishu",
    accounts: {
      main: { appId: "main_app", appSecret: "main_secret" },
      review: {
        name: "Review Bot",
        appId: "review_app",
        appSecret: "review_secret",
        requireMention: false,
        domain: "lark",
      },
    },
  };
  const config = parseFeishuChannelConfig(raw);

  expect(config.defaultAccount).toBe("main");
  expect(config.accounts).toHaveLength(2);
  const byId = new Map(config.accounts.map((account) => [account.accountId, account]));
  expect(byId.get("main")).toEqual({
    accountId: "main",
    enabled: true,
    configured: true,
    appId: "main_app",
    appSecret: "main_secret",
    domain: "feishu",
    requireMention: true,
    dmPolicy: "open",
    groupPolicy: "open",
    allowFrom: [],
    replyMode: "auto",
    trustGroupOwner: false,
  });
  expect(byId.get("review")).toEqual({
    accountId: "review",
    name: "Review Bot",
    enabled: true,
    configured: true,
    appId: "review_app",
    appSecret: "review_secret",
    domain: "lark",
    requireMention: false,
    dmPolicy: "open",
    groupPolicy: "open",
    allowFrom: [],
    replyMode: "auto",
    trustGroupOwner: false,
  });
});

test("parseFeishuChannelConfig accepts replyMode 'streaming' and per-account override", () => {
  const config = parseFeishuChannelConfig({
    defaultAccount: "main",
    replyMode: "streaming",
    accounts: {
      main: { appId: "a", appSecret: "b" },
      legacy: { appId: "c", appSecret: "d", replyMode: "static" },
    },
  });
  const byId = new Map(config.accounts.map((account) => [account.accountId, account]));
  expect(byId.get("main")?.replyMode).toBe("streaming");
  expect(byId.get("legacy")?.replyMode).toBe("static");
});

test("parseFeishuChannelConfig rejects unknown replyMode", () => {
  expect(() => parseFeishuChannelConfig({ appId: "x", appSecret: "y", replyMode: "verbose" }))
    .toThrow("replyMode must be one of");
});

test("parseFeishuChannelConfig accepts replyMode 'auto'", () => {
  const config = parseFeishuChannelConfig({ appId: "x", appSecret: "y", replyMode: "auto" });
  expect(config.accounts[0]!.replyMode).toBe("auto");
});

test("parseFeishuChannelConfig rejects when defaultAccount is not in accounts", () => {
  expect(() => parseFeishuChannelConfig({
    defaultAccount: "missing",
    accounts: { main: { appId: "x", appSecret: "y" } },
  })).toThrow("defaultAccount \"missing\" does not match");
});

test("parseFeishuChannelConfig rejects when no enabled+configured account exists", () => {
  expect(() => parseFeishuChannelConfig({})).toThrow("appId and channel.options.appSecret are required");
  expect(() => parseFeishuChannelConfig({ appId: "cli_test" })).toThrow("appId and channel.options.appSecret are required");
  expect(() => parseFeishuChannelConfig({
    accounts: {
      main: { appId: "x", appSecret: "y", enabled: false },
    },
  })).toThrow("appId and channel.options.appSecret are required");
});

test("parseFeishuChannelConfig defaults dmPolicy/groupPolicy to open and allowFrom to empty", () => {
  const config = parseFeishuChannelConfig({ appId: "x", appSecret: "y" });
  expect(config.accounts[0]!.dmPolicy).toBe("open");
  expect(config.accounts[0]!.groupPolicy).toBe("open");
  expect(config.accounts[0]!.allowFrom).toEqual([]);
});

test("parseFeishuChannelConfig accepts allowlist with allowFrom open_ids", () => {
  const config = parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    dmPolicy: "allowlist",
    allowFrom: ["ou_admin", "ou_ops"],
  });
  expect(config.accounts[0]!.dmPolicy).toBe("allowlist");
  expect(config.accounts[0]!.allowFrom).toEqual(["ou_admin", "ou_ops"]);
});

test("parseFeishuChannelConfig rejects allowlist without allowFrom", () => {
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    dmPolicy: "allowlist",
  })).toThrow("allowFrom must list at least one open_id");
});

test("parseFeishuChannelConfig rejects unknown policy values", () => {
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    dmPolicy: "bogus",
  })).toThrow("dmPolicy must be one of: open, allowlist, disabled");
});

test("parseFeishuChannelConfig: per-account policy overrides top-level", () => {
  const config = parseFeishuChannelConfig({
    defaultAccount: "main",
    dmPolicy: "open",
    accounts: {
      main: { appId: "x", appSecret: "y" },
      ops: { appId: "x2", appSecret: "y2", dmPolicy: "allowlist", allowFrom: ["ou_admin"] },
    },
  });
  const byId = new Map(config.accounts.map((a) => [a.accountId, a]));
  expect(byId.get("main")!.dmPolicy).toBe("open");
  expect(byId.get("ops")!.dmPolicy).toBe("allowlist");
  expect(byId.get("ops")!.allowFrom).toEqual(["ou_admin"]);
});

test("parseFeishuChannelConfig rejects malformed inputs", () => {
  expect(() => parseFeishuChannelConfig({ appId: "cli_test", appSecret: "secret", dedupTtlMs: 0 })).toThrow("channel.options.dedupTtlMs must be a positive number");
  expect(() => parseFeishuChannelConfig({ accounts: "nope" })).toThrow("channel.options.accounts must be an object");
  expect(() => parseFeishuChannelConfig({ accounts: { main: "nope" } })).toThrow("channel.options.accounts.main must be an object");
});

test("parseFeishuChannelConfig populates default tuning when not provided", () => {
  const config = parseFeishuChannelConfig({ appId: "x", appSecret: "y" });
  expect(config.tuning.cardFlushIntervalMs).toBe(800);
  expect(config.tuning.cardFailureThreshold).toBe(3);
  expect(config.tuning.imageMaxBytes).toBe(5 * 1024 * 1024);
  expect(config.tuning.permissionNotifyCooldownMs).toBe(5 * 60 * 1000);
});

test("parseFeishuChannelConfig respects user-supplied tuning overrides", () => {
  const config = parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    tuning: {
      cardFlushIntervalMs: 1500,
      imageMaxBytes: 1_000_000,
    },
  });
  expect(config.tuning.cardFlushIntervalMs).toBe(1500);
  expect(config.tuning.imageMaxBytes).toBe(1_000_000);
  // unspecified knobs fall back to defaults
  expect(config.tuning.cardFailureThreshold).toBe(3);
});

test("parseFeishuChannelConfig rejects non-positive tuning values", () => {
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    tuning: { cardFlushIntervalMs: 0 },
  })).toThrow("channel.options.tuning.cardFlushIntervalMs must be a positive number");
});

test("parseFeishuChannelConfig defaults trustGroupOwner to false", () => {
  const config = parseFeishuChannelConfig({ appId: "x", appSecret: "y" });
  expect(config.accounts[0]!.trustGroupOwner).toBe(false);
});

test("parseFeishuChannelConfig accepts trustGroupOwner and per-account override", () => {
  const config = parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    trustGroupOwner: true,
    accounts: {
      default: {},
      strict: { appId: "x2", appSecret: "y2", trustGroupOwner: false },
    },
  });
  const byId = new Map(config.accounts.map((a) => [a.accountId, a]));
  expect(byId.get("default")!.trustGroupOwner).toBe(true);
  expect(byId.get("strict")!.trustGroupOwner).toBe(false);
  expect(config.trustGroupOwner).toBe(true);
});

test("parseFeishuChannelConfig rejects non-boolean trustGroupOwner", () => {
  expect(() => parseFeishuChannelConfig({ appId: "x", appSecret: "y", trustGroupOwner: "yes" })).toThrow("trustGroupOwner must be a boolean");
});

test("parseFeishuChannelConfig rejects a card endpoint missing either secret", () => {
  // Token-only used to parse here, and it is exactly the broken state: the host
  // signs every new-protocol callback with the encrypt key, so a config
  // carrying only the verification token would start cleanly and then 401
  // every real click. The parse must refuse that config instead of shipping it.
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    accounts: { default: { appId: "x", appSecret: "y", cardActions: { port: 9871, verificationToken: "t" } } },
  })).toThrow(/encryptKey is required/);

  // Blank/whitespace-only keys are the same failure with extra steps.
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    accounts: { default: { appId: "x", appSecret: "y", cardActions: { port: 9871, encryptKey: "  " } } },
  })).toThrow(/encryptKey is required/);

  // The mirror image, and the one the previous fix left open: encryptKey-only
  // serves every click but cannot complete the URL-verification challenge,
  // which Feishu delivers with no `schema` and no `encrypt` — the legacy branch,
  // verified against the token. The challenge is read AFTER the signature
  // check, so a missing token rejects that handshake before the challenge is
  // ever echoed, and the endpoint can never finish being configured.
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    accounts: { default: { appId: "x", appSecret: "y", cardActions: { port: 9871, encryptKey: "k" } } },
  })).toThrow(/verificationToken is required: the URL-verification challenge/);

  // Neither secret is the original refusal.
  expect(() => parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    accounts: { default: { appId: "x", appSecret: "y", cardActions: { port: 9871 } } },
  })).toThrow(/encryptKey is required/);
});

test("parseFeishuChannelConfig accepts a card endpoint carrying both secrets", () => {
  // Both handshakes the endpoint has to complete are covered: new-protocol card
  // actions (encryptKey + SHA-256) and the URL-verification challenge
  // (verificationToken + SHA-1).
  const parsed = parseFeishuChannelConfig({
    appId: "x",
    appSecret: "y",
    accounts: { default: { appId: "x", appSecret: "y", cardActions: { port: 9871, encryptKey: "k", verificationToken: "t" } } },
  });
  expect(parsed.accounts[0]!.cardActions).toEqual({
    encryptKey: "k",
    verificationToken: "t",
    host: "127.0.0.1",
    port: 9871,
    path: "/webhook/card",
  });
});

const cardActionSecrets = {
  encryptKey: "a".repeat(32),
  verificationToken: "token",
  port: 18081,
};

/** The minimal Feishu options block, with `cardActions` on the account. */
function feishuOptions(cardActions: unknown): unknown {
  return {
    appId: "cli_test",
    appSecret: "secret_test",
    accounts: { default: { cardActions: cardActions as object } },
  };
}

test("parseCardActions rejects a relative path the host can never match", () => {
  // The HTTP host compares the request target against this path with STRICT
  // EQUALITY, so a relative path can never match: a request line carries
  // `/webhook/card`, which is a different string. Left unvalidated the listener
  // starts, the channel advertises form capability, and every callback 404s — the
  // shape this parser's own design note says must be a hard startup error.
  expect(() => parseFeishuChannelConfig(
    feishuOptions({ ...cardActionSecrets, path: "webhook/card" }),
  )).toThrow(/absolute path/);
});

test("parseCardActions accepts an absolute custom path", () => {
  // Control case: the same configuration with a leading slash is a route the host
  // can actually match, so it must not be refused.
  const config = parseFeishuChannelConfig(
    feishuOptions({ ...cardActionSecrets, path: "/custom/card" }),
  );
  expect(JSON.stringify(config)).toContain("/custom/card");
});

test("cardActions is parsed per account, so the path check runs on each", () => {
  // A misconfigured path in any account must fail the whole parse rather than
  // binding a listener that cannot ever serve its own callbacks.
  expect(() => parseFeishuChannelConfig({
    appId: "cli_test",
    appSecret: "secret_test",
    accounts: {
      good: { cardActions: { ...cardActionSecrets, path: "/ok" } },
      broken: { cardActions: { ...cardActionSecrets, path: "relative" } },
    },
  })).toThrow(/absolute path/);
});
