import { beforeEach, afterEach, expect, test } from "bun:test";
import { handlePromptWithSession } from "../../../src/commands/handlers/session-handler";
import type { SessionHandlerContext } from "../../../src/commands/handlers/session-handler";
import {
  resetGlobalElicitationBrokerForTests,
  setGlobalElicitationBroker,
} from "../../../src/interactions/elicitation-interaction-broker";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import type { TurnInteractionContext } from "../../../src/interactions/turn-interaction-registry";
import type { ResolvedSession } from "../../../src/transport/types";

/**
 * The JOIN between a Relay session turn and the form its renderer places.
 *
 * The resolvers have their own tests, and so does the channel. What kept
 * regressing silently is the wiring in `session-handler`: a route that resolves
 * but is never given the metadata it needs, or an alias stamped in a namespace
 * the dashboard does not use. Both failures left every unit test green while
 * `ask` was answered with `missing interaction route` in production, so this
 * test drives the real handler dispatch and asserts on the turn context the
 * broker is actually handed.
 */

// Production gets this from the relay plugin's channel manifest at daemon
// startup (`registerChannelPlugin` → `registerChannelFactory` →
// `registerKnownChannelId`), which is what makes `relay:demo` display as `demo`.
// Registering it here mirrors that ordering instead of depending on test order.
registerKnownChannelId("relay");

const SESSION = {
  alias: "relay:demo",
  agent: "codex",
  workspace: "/tmp/ws",
  transportSession: "demo-t1",
} as unknown as ResolvedSession;

let captured: TurnInteractionContext | undefined;
let promptedWithInteractionId: string | undefined;

function makeContext(): SessionHandlerContext {
  return {
    sessions: {
      getLogicalSessionRecord: () => undefined,
      getCurrentSession: async () => SESSION,
      getResolvedSessionByInternalAlias: () => SESSION,
    },
    interaction: {
      promptTransportSession: async (...args: unknown[]) => {
        promptedWithInteractionId = args[12] as string | undefined;
        return { text: "ok" };
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    transport: undefined,
    orchestration: undefined,
    config: undefined,
    configStore: undefined,
    replaceConfig: () => {},
    quota: undefined,
    lifecycle: undefined,
    recovery: undefined,
  } as unknown as SessionHandlerContext;
}

function promptOn(chatKey: string, metadata: Record<string, unknown> | undefined) {
  return handlePromptWithSession(
    makeContext(),
    SESSION,
    chatKey,
    "hi",
    undefined,
    undefined,
    "acct-1",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    metadata as never,
  );
}

beforeEach(() => {
  captured = undefined;
  promptedWithInteractionId = undefined;
  setGlobalElicitationBroker({
    bindTurn: (context: TurnInteractionContext) => {
      captured = context;
      return () => {};
    },
  } as never);
});

afterEach(() => {
  resetGlobalElicitationBrokerForTests();
});

test("a relay session turn binds an elicitation route and stamps the DISPLAY alias", async () => {
  const result = await promptOn("relay:acct-1", {
    channel: "control",
    chatType: "direct",
    origin: "human",
    senderId: "acct-1",
    isOwner: true,
  });

  expect(result.text).toBe("ok");
  expect(promptedWithInteractionId).toBeString();
  expect(captured?.sessionAlias).toBe("demo");
  expect(captured?.chatType).toBe("direct");
  expect(captured?.senderId).toBe("acct-1");
});

test("an unreported chatType stays unrouted", async () => {
  await promptOn("relay:acct-1", { channel: "control", origin: "human", senderId: "acct-1" });

  // No elicitation route, hence no form. An interaction id may still exist: a
  // relay turn resolves a PERMISSION route from its trusted ingress, which is
  // independent of `chatType` and predates this feature.
  expect(captured).toBeUndefined();
});

test("a group destination stays unrouted", async () => {
  await promptOn("relay:acct-1", {
    channel: "control",
    chatType: "group",
    origin: "human",
    senderId: "acct-1",
  });

  expect(captured).toBeUndefined();
});

test("a non-human origin stays unrouted", async () => {
  await promptOn("relay:acct-1", {
    channel: "control",
    chatType: "direct",
    origin: "scheduled",
    senderId: "acct-1",
  });

  expect(captured).toBeUndefined();
});
