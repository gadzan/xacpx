import { beforeAll, expect, test } from "bun:test";
import { discordCliProvider } from "../../../../packages/channel-discord/src/discord-provider";
import { parseDiscordChannelConfig } from "../../../../packages/channel-discord/src/config";
import { setChannelLocale } from "../../../../packages/channel-discord/src/i18n";
import type { ChannelRuntimeConfig } from "xacpx/plugin-api";

// Round 6 M1: the CLI provider used to hand-roll its own weak checks, so
// `xacpx channel add discord` happily wrote configs that only exploded on the
// next daemon start (two accounts sharing one bot token being the concrete
// case). validateConfig now delegates every semantic rule to the runtime
// parser, which owns them.

beforeAll(() => {
  setChannelLocale("en");
});

function runtimeConfig(options: unknown): ChannelRuntimeConfig {
  return { id: "discord", type: "discord", enabled: true, options } as ChannelRuntimeConfig;
}

function invalidMessages(options: unknown): string[] {
  return discordCliProvider
    .validateConfig(runtimeConfig(options))
    .filter((issue) => issue.kind === "invalid-config")
    .map((issue) => issue.message);
}

test("a well-formed single-account config validates", () => {
  expect(discordCliProvider.validateConfig(runtimeConfig({ token: "tok-X" }))).toEqual([]);
});

test("a well-formed multi-account config validates", () => {
  expect(
    discordCliProvider.validateConfig(
      runtimeConfig({ accounts: { east: { token: "tok-X" }, west: { token: "tok-Y" } } }),
    ),
  ).toEqual([]);
});

test("M1: duplicate token across accounts is rejected at add time", () => {
  const issues = discordCliProvider.validateConfig(
    runtimeConfig({ accounts: { a: { token: "tok-X" }, b: { token: "tok-X" } } }),
  );
  expect(issues.length).toBe(1);
  expect(issues[0]!.kind).toBe("invalid-config");
  expect(issues[0]!.message).toContain("duplicates the bot token");
});

test("M1: base-inherited duplicate token is rejected at add time", () => {
  expect(
    invalidMessages({ token: "tok-X", accounts: { a: {}, b: {} } }),
  ).toEqual([expect.stringContaining("duplicates the bot token")]);
});

test("M1: the rejection names the offending account and never leaks the token", () => {
  const messages = invalidMessages({
    accounts: { a: { token: "tok-1" }, b: { token: "tok-2" }, c: { token: "tok-1" } },
  });
  expect(messages.length).toBe(1);
  expect(messages[0]).toContain("accounts.c");
  expect(messages[0]).toContain('"a"');
  expect(messages[0]).not.toContain("tok-1");
});

// A malformed accounts shape used to reach `acc.token` and throw a TypeError
// out of the CLI, which reads as a crash instead of a config problem.
test("M1: malformed options shapes become invalid-config, never a thrown TypeError", () => {
  const malformed: unknown[] = [
    { token: "tok-X", accounts: null },
    { token: "tok-X", accounts: "east" },
    { token: "tok-X", accounts: { a: null } },
    { accounts: { a: null } },
    "not-an-object",
    null,
  ];
  for (const options of malformed) {
    let issues: ReturnType<typeof discordCliProvider.validateConfig> | null = null;
    expect(() => {
      issues = discordCliProvider.validateConfig(runtimeConfig(options));
    }).not.toThrow();
    if (typeof options === "object" && options !== null) {
      expect(issues!.length).toBeGreaterThan(0);
      expect(issues!.every((issue) => issue.kind === "invalid-config")).toBe(true);
    }
  }
});

test("M1: a config with no credential anywhere still reports the --token flag hint", () => {
  const issues = discordCliProvider.validateConfig(runtimeConfig({}));
  expect(issues.length).toBe(1);
  expect(issues[0]!.kind).toBe("missing-required-field");
  expect(issues[0]!.flag).toBe("--token");
});

test("M1: accounts declared without any credential report the accounts hint", () => {
  const issues = discordCliProvider.validateConfig(
    runtimeConfig({ accounts: { east: { name: "East" }, west: {} } }),
  );
  expect(issues.length).toBe(1);
  expect(issues[0]!.kind).toBe("invalid-config");
  expect(issues[0]!.message).toContain("token");
});

// The anti-drift invariant: whatever the runtime accepts, the CLI must accept,
// and whatever the runtime rejects, the CLI must reject. Without delegation the
// two surfaces disagreed on every rule except the presence of a token.
test("M1: provider verdict equals the runtime parser verdict", () => {
  const cases: Array<{ name: string; options: Record<string, unknown> }> = [
    { name: "single account", options: { token: "tok-X" } },
    { name: "multi account", options: { accounts: { a: { token: "tok-X" }, b: { token: "tok-Y" } } } },
    { name: "disabled account may share a token", options: { accounts: { a: { token: "tok-X" }, b: { token: "tok-X", enabled: false } } } },
    { name: "duplicate token", options: { accounts: { a: { token: "tok-X" }, b: { token: "tok-X" } } } },
    { name: "base-inherited duplicate token", options: { token: "tok-X", accounts: { a: {}, b: {} } } },
    { name: "unknown replyMode", options: { token: "tok-X", replyMode: "streaming-ish" } },
    { name: "non-positive dedupTtlMs", options: { token: "tok-X", dedupTtlMs: 0 } },
    { name: "non-object tuning", options: { token: "tok-X", tuning: 5 } },
    { name: "non-object guilds", options: { token: "tok-X", guilds: "g1" } },
    { name: "defaultAccount without matching account", options: { token: "tok-X", defaultAccount: "nope", accounts: { a: {} } } },
    { name: "account id with the chatKey separator", options: { accounts: { "ops:east": { token: "tok-X" } } } },
    { name: "accounts is not an object", options: { token: "tok-X", accounts: null } },
    { name: "dmPolicy wrong type", options: { token: "tok-X", dmPolicy: 1 } },
  ];

  const drift: string[] = [];
  for (const testCase of cases) {
    let parserRejected = false;
    try {
      parseDiscordChannelConfig(testCase.options);
    } catch {
      parserRejected = true;
    }
    const issues = discordCliProvider.validateConfig(runtimeConfig(testCase.options));
    const providerRejected = issues.length > 0;
    if (parserRejected !== providerRejected) {
      drift.push(`${testCase.name}: parser=${parserRejected ? "reject" : "accept"} provider=${providerRejected ? "reject" : "accept"} (${issues[0]?.message ?? "clean"})`);
    }
  }
  expect(drift).toEqual([]);
});
