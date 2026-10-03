/**
 * Built-artifact capability gate.
 *
 * The M5 release-hardening requirement: form capability must be verified on the
 * BUILT artifact, not only against source-level unit tests. A source test can pass
 * while the shipped bundle lies, because `elicitationModes` is derived from config
 * and constructor wiring — exactly the parts a bundler, a tree-shake, or a stale
 * tracked `dist` can silently change.
 *
 * This loads each channel's PRODUCTION bundle (`dist/index.js` under each
 * package, the file the plugin loader consumes) and asserts what it declares:
 *
 *   - Feishu with no `cardActions` on any account      -> no form capability
 *   - Feishu with a mixed account set (one lacks it)   -> no form capability
 *   - Feishu with every inbound account configured    -> form capability
 *   - Feishu, Discord                                   -> never `url`
 *   - Discord with a real renderer                     -> form capability
 *   - channel-relay's connector registration           -> interaction.elicitation.form.v1
 *                                                        and NOT permission
 *
 * The relay case is not a class-field check. Its real surface is what the built
 * channel hands to `createClient` on its production start path — the capability
 * list the connector sends to the hub on hello — so that is what is captured and
 * asserted. Reading `elicitationModes` there would prove a field exists, not that
 * the shipped artifact registers correctly.
 *
 * The mixed-account case is the one that matters most: the plugin contract has no
 * route-scoped capability, so a channel where SOME accounts can deliver a form and
 * others cannot cannot describe itself truthfully. Declaring form there makes every
 * request routed to the listener-less account fail closed — the agent is told
 * "form works here" and then every one of its requests is cancelled.
 *
 * NOT run by default `npm test` (that is `tests/unit/**`), and NOT left manual
 * either: the Linux CI leg runs this after `Build (all packages)`, which is the
 * step that produces the bundles it consumes. Run locally with:
 *
 *   bun run build:packages
 *   bun test tests/smoke/acp-elicitation-capability-artifact.test.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { RELAY_CAPABILITIES } from "../../packages/relay-protocol/src/index";

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

test("relay bundle: the connector hello advertises the interaction capability it can deliver", async () => {
  // The relay channel's TRUE capability surface is not `elicitationModes` — it is
  // what the built channel hands to `createClient` on its production start path,
  // which is what the connector sends to the hub on hello. Asserting a field on
  // the class would prove the source has a field, not that the shipped artifact
  // executes the production registration with the right capabilities.
  //
  // Mirrors `tests/unit/packages/channel-relay/channel-terminal.test.ts:131-138`,
  // but against the BUILT bundle and with a real start(), so the capability
  // assembly and the registration itself are the shipped ones.
  //
  // Awaited via a promise the code already exposes, not a poll loop: `createClient`
  // resolves a deferred, so the test unblocks on the real signal rather than on a
  // guessed duration. A timing-out wait then points at "registration never
  // happened", which is the failure being tested.
  const RelayChannel = findChannelClass(requirePack("packages/channel-relay/dist/index.js"));

  const registration = Promise.withResolvers<readonly string[]>();
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" },
    {
      credentialStore: { load: () => null, save: () => {}, clear: () => {} },
      createClient: (opts: { capabilities?: readonly string[] }) => {
        registration.resolve(opts.capabilities ?? []);
        return fakeClient as never;
      },
    } as never,
  );

  const controller = new AbortController();
  const started = channel.start({
    agent: { chat: async () => ({ text: "" }) },
    abortSignal: controller.signal,
    quota: {},
    logger: { info: async () => {}, error: async () => {}, debug: async () => {} },
    control: { events: { subscribe: () => () => {} }, listSessions: () => [] },
    coreVersion: "0.0.0",
  } as never);

  let caps: readonly string[] | undefined;
  try {
    caps = await Promise.race([
      registration.promise,
      // A bare rejection of the start path is not the assertion: the channel may
      // legitimately stop before it ever registers, which is a different failure.
      started.then(() => registration.promise),
    ]);
  } finally {
    // Stop the channel whichever way this ended; the assertions below are the gate.
    controller.abort();
    await started.catch(() => {});
  }

  expect(
    caps ?? [],
    "the built relay channel never reached connector registration",
  ).toContain(RELAY_CAPABILITIES.interactionElicitationFormV1);

  // The fail-closed half, and the reason this test exists: the permission renderer
  // does not exist, so no permission capability may be advertised. Declaring it
  // would tell the hub (and every agent behind it) that a permission interaction
  // can be resolved here, and then every one would fail at runtime.
  expect(RELAY_CAPABILITIES.interactionPermissionV1).toBeUndefined();
  expect(caps ?? []).not.toContain("interaction.permission.v1");
});

test("discord bundle: form capability is declared, not merely not-wrong", () => {
  // Discord renders in an existing authenticated DM surface, so its bundle must
  // declare form. The previous version asserted only "every declared mode is in
  // the allowed set" and "url is absent" — both of which pass on
  // `elicitationModes = []`. An empty array is exactly what a bundle that was
  // tree-shaken, or built from a stale tracked dist, would produce, so that shape
  // of assertion could not detect the failure it was written for.
  const DiscordChannel = findChannelClass(requirePack("packages/channel-discord/dist/index.js"));
  const channel = new DiscordChannel({ type: "discord", token: "t" });
  expect(channel.elicitationModes).toEqual(["form"]);
});
