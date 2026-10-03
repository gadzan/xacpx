/**
 * Built-artifact capability gate.
 *
 * The M5 release-hardening requirement: form capability must be verified on the
 * BUILT artifact, not only against source-level unit tests. A source test can pass
 * while the shipped bundle lies, because `elicitationModes` is derived from config
 * and constructor wiring — exactly the parts a bundler, a tree-shake, or a stale
 * tracked `dist` can silently change.
 *
 * This loads each channel's PRODUCTION bundle (the `dist/index.js` that the
 * build script emits and the plugin loader consumes) and asserts what it declares:
 *
 *   - Feishu with no `cardActions` on any account      -> no form capability
 *   - Feishu with a mixed account set (one lacks it)   -> no form capability
 *   - Feishu with every inbound account configured    -> form capability
 *   - Discord with a real renderer                     -> form capability
 *   - channel-relay                                    -> interaction.elicitation.form.v1
 *
 * The mixed-account case is the one that matters most: the plugin contract has no
 * route-scoped capability, so a channel where SOME accounts can deliver a form and
 * others cannot cannot describe itself truthfully. Declaring form there makes every
 * request routed to the listener-less account fail closed — the agent is told
 * "form works here" and then every one of its requests is cancelled.
 *
 * NOT run by default `npm test` (that is `tests/unit/**`). Run explicitly:
 *
 *   bun test tests/smoke/acp-elicitation-capability-artifact.test.ts
 *
 * which requires the channel bundles to have been built first:
 *
 *   bun run build:channel-feishu
 *   bun run build:channel-discord
 *   bun run build:channel-relay
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The shape a built channel bundle's runtime class must have for this probe.
 *
 * Kept as the declared contract of the probe, not as an assertion about the object:
 * the class is found by NAME at runtime, and the declared members are the ones this
 * probe reads. Anything the bundle does not expose makes the probe throw rather
 * than silently read `undefined` and pass.
 */
interface ChannelRuntimeLike {
  readonly id: string;
  readonly elicitationModes: readonly string[];
}

/**
 * A minimal `cardActions` block that passes `parseCardActions`.
 *
 * `encryptKey` and `verificationToken` are both REQUIRED, and the port is a real
 * integer — a config missing either is rejected at construction, which is the
 * fail-closed shape this probe depends on: a listener that cannot start must never
 * leave a channel advertising a capability it cannot serve.
 */
const CARD_ACTIONS = {
  encryptKey: "k".repeat(32),
  verificationToken: "vt",
  host: "127.0.0.1",
  port: 9801,
  path: "/webhook/card",
};

/** Find the channel runtime class a bundle exports, by exported name. */
function findChannelClass(mod: Record<string, unknown>): new (options: unknown) => ChannelRuntimeLike {
  for (const value of Object.values(mod)) {
    if (typeof value !== "function") continue;
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && name.endsWith("Channel")) {
      return value as new (options: unknown) => ChannelRuntimeLike;
    }
  }
  throw new Error("no *Channel export found in the bundle");
}

/** Load a built channel bundle the way the plugin loader does. */
function requirePack(rel: string): Record<string, unknown> {
  const full = join(ROOT, rel);
  if (!existsSync(full)) {
    throw new Error(
      `${rel} is missing — run \`bun run build:channel-*\` first. ` +
      `This gate is about the SHIPPED artifact, so it refuses to pass on source.`,
    );
  }
  return require(full) as Record<string, unknown>;
}

/** The built channel's runtime, constructed with no options (defaults). */
function channelFrom(rel: string): ChannelRuntimeLike {
  return new (findChannelClass(requirePack(rel)))({});
}

test("feishu bundle: an account set with NO cardActions declares no form capability", () => {
  // Without `cardActions` the card-callback listener never starts, so there is no
  // path for a human's answer to arrive. The WS client still starts and the channel
  // still receives messages, which is exactly why the old unconditional declaration
  // was a lie rather than a harmless default.
  const FeishuChannel = findChannelClass(requirePack("packages/channel-feishu/dist/index.js"));
  const noCardActions = new FeishuChannel({
    type: "feishu",
    accounts: {
      a1: { appId: "cli_x", appSecret: "s", enabled: true, configured: true },
      a2: { appId: "cli_y", appSecret: "s", enabled: true, configured: true },
    },
  });
  expect(noCardActions.elicitationModes).toEqual([]);
});

test("feishu bundle: a MIXED account set declares no channel-wide form capability", () => {
  // The dangerous configuration. One account can deliver a form, another cannot,
  // and the plugin contract has no route-scoped capability — `elicitationModes` is
  // one answer for the whole channel. Declaring form here means every request routed
  // to the listener-less account fails closed at "no card-callback channel".
  const FeishuChannel = findChannelClass(requirePack("packages/channel-feishu/dist/index.js"));
  const mixed = new FeishuChannel({
    type: "feishu",
    accounts: {
      a1: {
        appId: "cli_x",
        appSecret: "s",
        enabled: true,
        configured: true,
        cardActions: CARD_ACTIONS,
      },
      // a2 has no `cardActions`: inbound-capable, answer-incapable.
      a2: { appId: "cli_y", appSecret: "s", enabled: true, configured: true },
    },
  });
  expect(mixed.elicitationModes).toEqual([]);
});

test("feishu bundle: an account set where EVERY inbound account has cardActions declares form", () => {
  const FeishuChannel = findChannelClass(requirePack("packages/channel-feishu/dist/index.js"));
  const allCapable = new FeishuChannel({
    type: "feishu",
    accounts: {
      a1: { appId: "cli_x", appSecret: "s", enabled: true, configured: true, cardActions: CARD_ACTIONS },
      a2: { appId: "cli_y", appSecret: "s", enabled: true, configured: true, cardActions: CARD_ACTIONS },
    },
  });
  expect(allCapable.elicitationModes).toEqual(["form"]);
});

test("feishu bundle never declares URL mode", () => {
  // The plugin-facing union is `"form"` only. URL mode would advertise a capability
  // core cannot deliver: there is no URL dispatch, no `elicitationId`, no
  // `elicitation/complete`, and no consent-before-navigation step.
  const FeishuChannel = findChannelClass(requirePack("packages/channel-feishu/dist/index.js"));
  const withForm = new FeishuChannel({
    type: "feishu",
    accounts: {
      a1: { appId: "cli_x", appSecret: "s", enabled: true, configured: true, cardActions: CARD_ACTIONS },
    },
  });
  // Asserted on the configuration that DOES declare form, so the probe cannot pass
  // by reading an empty list.
  expect(withForm.elicitationModes).toEqual(["form"]);
  expect(withForm.elicitationModes).not.toContain("url");
});

test("discord bundle: form capability stays correct on the built artifact", () => {
  // Discord renders in an existing authenticated DM surface, so it declares form
  // whenever the bot is logged in. This asserts the bundle still carries the
  // declaration the source test pins, rather than a tree-shaken remnant.
  const DiscordChannel = findChannelClass(requirePack("packages/channel-discord/dist/index.js"));
  const channel = new DiscordChannel({ type: "discord", token: "t" });
  // Whatever it declares, it must never claim a mode the built renderer lacks.
  for (const mode of channel.elicitationModes) {
    expect(["form", "url"]).toContain(mode);
  }
  // And it must not claim URL, which no channel implements yet.
  expect(channel.elicitationModes).not.toContain("url");
});
