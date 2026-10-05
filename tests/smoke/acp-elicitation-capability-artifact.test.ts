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
 * package, the file the plugin loader consumes) and resolves the channel the way
 * `loadConfiguredPlugins()` does:
 *
 *   import(module) → validateWeacpxPlugin() → plugin.channels[] → factory()
 *
 * NOT by scanning exports for a `*Channel` class and `new`-ing it. That shortcut
 * skips the default export, the channel definition, and the factory wiring — the
 * three layers whose breakage leaves a bundle that imports cleanly but registers
 * nothing at install time. The mutation that proves it matters: setting the built
 * Feishu bundle's `default.channels` to `[]` while keeping the named class export
 * passes every test under the shortcut and fails four of them here.
 *
 * It then asserts what the resolved runtime declares:
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
 * The shape a built channel's runtime must expose for this probe.
 */
interface ChannelRuntimeLike {
  readonly id: string;
  readonly elicitationModes: readonly string[];
}

/**
 * The production plugin entry a built bundle must expose: `default` carrying a
 * `channels` array whose entries each carry a `factory`.
 *
 * This mirrors `loadConfiguredPlugins()` (src/plugins/plugin-loader.ts):
 *
 *   import(module) → validateWeacpxPlugin() → plugin.channels[] → registerChannelPlugin()
 *   → channel.factory(options, deps)
 *
 * Reaching a channel through its exported CLASS NAME instead would skip the
 * default export, the channel definition, and the factory wiring — the three
 * layers whose breakage makes a bundle that imports cleanly unable to register
 * anything in production. See `channelFrom()` for why that matters.
 */
interface ChannelPluginDefinitionLike {
  type: string;
  factory: (options: unknown, deps: unknown) => ChannelRuntimeLike;
}

interface BuiltPluginLike {
  channels?: readonly ChannelPluginDefinitionLike[];
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

/**
 * Resolve a built channel the way production does — through the plugin entry,
 * the channel definition, and its factory.
 *
 * A previous revision of this gate located the runtime by scanning bundle exports
 * for a function named `*Channel` and `new`-ing it directly. That bypassed every
 * layer production actually walks, so a bundle whose `default.channels` was empty
 * (or whose factory was wired wrong) stayed fully green while being unable to
 * register anything at install time.
 *
 * The specific tool call is `options`, the first factory argument: the same config
 * object `ChannelFactory` receives when a plugin account is constructed.
 */
async function channelFrom(
  rel: string,
  type: string,
  options: unknown,
  deps: unknown = {},
): Promise<ChannelRuntimeLike> {
  const pack = requirePack(rel);
  const plugin = (pack as { default?: BuiltPluginLike }).default;
  if (plugin === undefined || typeof plugin !== "object") {
    throw new Error(`${rel} has no default export — a bundle that cannot be imported as a plugin`);
  }
  const definition = (plugin.channels ?? []).find((entry) => entry.type === type);
  if (definition === undefined) {
    throw new Error(
      `${rel} default export registers no channel of type "${type}" ` +
        `(found: ${(plugin.channels ?? []).map((c) => c.type).join(", ") || "none"})`,
    );
  }
  if (typeof definition.factory !== "function") {
    throw new Error(`${rel} channel "${type}" has a non-callable factory`);
  }
  return definition.factory(options, deps);
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

test("feishu bundle: an account set with NO cardActions declares no form capability", async () => {
  // Without `cardActions` the card-callback listener never starts, so there is no
  // path for a human's answer to arrive. The WS client still starts and the channel
  // still receives messages, which is exactly why the old unconditional declaration
  // was a lie rather than a harmless default.
  const noCardActions = await channelFrom(
    "packages/channel-feishu/dist/index.js",
    "feishu",
    {
      type: "feishu",
      accounts: {
        a1: { appId: "cli_x", appSecret: "s", enabled: true, configured: true },
        a2: { appId: "cli_y", appSecret: "s", enabled: true, configured: true },
      },
    },
  );
  expect(noCardActions.elicitationModes).toEqual([]);
});

test("feishu bundle: a MIXED account set declares no channel-wide form capability", async () => {
  // The dangerous configuration. One account can deliver a form, another cannot,
  // and the plugin contract has no route-scoped capability — `elicitationModes` is
  // one answer for the whole channel. Declaring form here means every request routed
  // to the listener-less account fails closed at "no card-callback channel".
  const mixed = await channelFrom(
    "packages/channel-feishu/dist/index.js",
    "feishu",
    {
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
    },
  );
  expect(mixed.elicitationModes).toEqual([]);
});

test("feishu bundle: an account set where EVERY inbound account has cardActions declares form", async () => {
  const allCapable = await channelFrom(
    "packages/channel-feishu/dist/index.js",
    "feishu",
    {
      type: "feishu",
      accounts: {
        a1: { appId: "cli_x", appSecret: "s", enabled: true, configured: true, cardActions: CARD_ACTIONS },
        a2: { appId: "cli_y", appSecret: "s", enabled: true, configured: true, cardActions: CARD_ACTIONS },
      },
    },
  );
  expect(allCapable.elicitationModes).toEqual(["form"]);
});

test("feishu bundle never declares URL mode", async () => {
  // The plugin-facing union is `"form"` only. URL mode would advertise a capability
  // core cannot deliver: there is no URL dispatch, no `elicitationId`, no
  // `elicitation/complete`, and no consent-before-navigation step.
  const withForm = await channelFrom(
    "packages/channel-feishu/dist/index.js",
    "feishu",
    {
      type: "feishu",
      accounts: {
        a1: { appId: "cli_x", appSecret: "s", enabled: true, configured: true, cardActions: CARD_ACTIONS },
      },
    },
  );
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
  //
  // That wait has its own deadline because both branches of the race are
  // permanent-pending promises when registration never happens. Without a branch
  // of our own, that regressor fails at Bun's generic test-level timeout — a wall
  // clock, not a diagnostic. The deadline below is bounded comfortably under the
  // test-level timeout (5000ms) so OUR message is the one that fires, and it is
  // cleared as soon as registration resolves, so it costs nothing on the passing
  // path and never keeps the event loop alive.
  const REGISTRATION_DEADLINE_MS = 2000;
  const registration = Promise.withResolvers<readonly string[]>();
  const fakeClient = { start: () => {}, stop: () => {}, sendEvent: () => {} };
  // Through the plugin entry, not the exported class: `start()` is the production
  // path and the factory is what production calls to obtain the channel at all.
  // The deps are the second factory argument — exactly what `ChannelFactory`
  // receives from `registerChannelPlugin`'s registry in a real install.
  const channel = await channelFrom(
    "packages/channel-relay/dist/index.js",
    "relay",
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
  // Owned by the caller rather than by the assertions, so the distinguishing
  // message survives even though the value it guards is undefined either way.
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `connector registration never happened within ${REGISTRATION_DEADLINE_MS}ms`,
        ),
      );
    }, REGISTRATION_DEADLINE_MS);
    // Clear on the path we actually want to settle on; an uncleaned timer would
    // both keep the runtime alive and, in a shared runner, fire into another
    // test's window.
    registration.promise.finally(() => clearTimeout(timer), () => clearTimeout(timer));
  });
  try {
    caps = await Promise.race([
      registration.promise,
      // A bare rejection of the start path is not the assertion: the channel may
      // legitimately stop before it ever registers, which is a different failure.
      started.then(() => registration.promise),
      deadline,
    ]);
  } catch (error) {
    if (!timedOut) throw error;
    // An unresolved-start and a never-registered channel are the same observable
    // outcome but different defects, so the message names which one we hit.
    throw new Error(
      `the built relay channel never reached connector registration; ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

test("discord bundle: form capability is declared, not merely not-wrong", async () => {
  // Discord renders in an existing authenticated DM surface, so its bundle must
  // declare form. The previous version asserted only "every declared mode is in
  // the allowed set" and "url is absent" — both of which pass on
  // `elicitationModes = []`. An empty array is exactly what a bundle that was
  // tree-shaken, or built from a stale tracked dist, would produce, so that shape
  // of assertion could not detect the failure it was written for. `toEqual` can.
  //
  // Resolved through the plugin entry and factory, so an empty `channels` array or
  // a wrong `type` in the bundle fails here instead of silently passing.
  const channel = await channelFrom(
    "packages/channel-discord/dist/index.js",
    "discord",
    { type: "discord", token: "t" },
  );
  expect(channel.elicitationModes).toEqual(["form"]);
});
