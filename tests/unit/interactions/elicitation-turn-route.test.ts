import { expect, test } from "bun:test";

import {
  resolveElicitationTurnRoute,
  resolveSessionElicitationTurnRoute,
} from "../../../src/interactions/elicitation-turn-route";
import { parseDirectConversationChatKey } from "../../../src/domain/ids";
import { resolvePermissionTurnRoute } from "../../../src/permissions/permission-turn-route";

/**
 * Direct Bot turn interaction routing.
 *
 * Before this, a Direct Bot turn had no interactive route at all, so the
 * elicitation broker cancelled before a renderer could ever be reached. These
 * tests pin both halves of the fix and, more importantly, that the permission
 * path kept its stricter policy.
 */
test("an elicitation route resolves for a human Direct Bot turn", () => {
  const route = resolveElicitationTurnRoute({
    isolationChatKey: "bot:conv_1:topic_1",
    origin: "human",
    senderId: "acct_42",
    ingressChatKey: "relay:acct_42",
  });
  expect(route).not.toBeUndefined();
  // The route addresses the PRODUCT isolation key, which is what TurnQueue and
  // the conversation kernel use — not the ingress chat key.
  expect(route!.chatKey).toBe("bot:conv_1:topic_1");
  expect(route!.origin).toBe("human");
  expect(route!.senderId).toBe("acct_42");
  // The trusted ingress address rides as the reply context so a renderer can
  // reach the human without guessing.
  expect(route!.replyContextToken).toBe("relay:acct_42");
});

test("an elicitation route refuses a non-human origin", () => {
  // A scheduled or orchestrated turn must never mint a UI.
  for (const origin of ["scheduled", "peer", "orchestration", undefined]) {
    expect(resolveElicitationTurnRoute({
      isolationChatKey: "bot:conv_1:topic_1",
      ...(origin !== undefined ? { origin } : {}),
      senderId: "acct_42",
    })).toBeUndefined();
  }
});

test("an elicitation route refuses a turn with no trusted initiator", () => {
  // No senderId means no exact-turn ownership: the broker would cancel anyway,
  // so failing here gives the clearer reason.
  expect(resolveElicitationTurnRoute({
    isolationChatKey: "bot:conv_1:topic_1",
    origin: "human",
  })).toBeUndefined();
});

test("an elicitation route refuses a non-Direct-Conversation key", () => {
  // Ordinary channel turns keep using their own channel's route; this resolver
  // must not claim keys it does not own.
  for (const key of ["weixin:default:alice", "feishu:default:oc_x", "alice", "bot-hyphen:c:t"]) {
    expect(resolveElicitationTurnRoute({
      isolationChatKey: key,
      origin: "human",
      senderId: "acct_42",
    })).toBeUndefined();
  }
});

test("the permission path still refuses Direct Conversation keys", () => {
  // The whole point of extracting the shared resolver: permission keeps its
  // stricter policy while elicitation widens. If this regresses, a product
  // isolation key would mint a human permission interaction.
  expect(resolvePermissionTurnRoute({
    isolationChatKey: "bot:conv_1:topic_1",
    origin: "human",
    senderId: "acct_42",
  })).toBeUndefined();
  // And it still works for an ordinary channel turn.
  expect(resolvePermissionTurnRoute({
    isolationChatKey: "weixin:default:alice",
    origin: "human",
    senderId: "wxid_alice",
  })).not.toBeUndefined();
});

test("parseDirectConversationChatKey parses rather than prefix-matching", () => {
  expect(parseDirectConversationChatKey("bot:conv_1:topic_1")).toEqual({
    conversationId: "conv_1",
    topicId: "topic_1",
  });
  // A route built from a prefix-only key could be satisfied by ANY turn in ANY
  // topic, so a malformed key must yield nothing.
  for (const key of ["bot:", "bot:conv_1", "bot:conv_1:", "bot::topic", "bot:c:t:extra", "notabot:c:t"]) {
    expect(parseDirectConversationChatKey(key)).toBeUndefined();
  }
});

/**
 * Session turns: a provably 1:1 chat that is not a Direct Conversation.
 *
 * These are the turns an agent uses to talk to its operator through a session
 * chat (a Relay session, a channel DM). They had NO elicitation route, so every
 * structured question was answered by the broker with `missing interaction route`
 * before a renderer could be consulted — `ask` simply could not work there.
 *
 * The widening is deliberately narrow: `chatType` must be exactly `"direct"`, the
 * identity must be trusted, and `bot:` keys stay with the resolver above. The
 * renderer still decides whether it can place the form.
 */
test("a DIRECT session turn resolves an elicitation route on its own address", () => {
  const route = resolveSessionElicitationTurnRoute({
    isolationChatKey: "relay:acct-9",
    origin: "human",
    metadata: { origin: "human", chatType: "direct", senderId: "relay:acct-9" } as never,
  });
  expect(route).not.toBeUndefined();
  // A session turn has one address: the ingress key the answer travels back on.
  expect(route!.chatKey).toBe("relay:acct-9");
  expect(route!.origin).toBe("human");
  expect(route!.senderId).toBe("relay:acct-9");
});

test("a session route is refused without a provable direct destination", () => {
  // `undefined` means the channel never reported the destination, which is NOT
  // the same as "direct": a form publishes the question AND the answer into the
  // chat, so an unproven destination must not render one.
  for (const chatType of [undefined, "group"] as const) {
    expect(resolveSessionElicitationTurnRoute({
      isolationChatKey: "relay:acct-9",
      origin: "human",
      metadata: { origin: "human", ...(chatType !== undefined ? { chatType } : {}), senderId: "relay:acct-9" } as never,
    })).toBeUndefined();
  }
});

test("a session route refuses a bot: key, which the other resolver owns", () => {
  // Two resolvers claiming one turn could place the same form on two surfaces.
  expect(resolveSessionElicitationTurnRoute({
    isolationChatKey: "bot:conv_1:topic_1",
    origin: "human",
    metadata: { origin: "human", chatType: "direct", senderId: "relay:acct-9" } as never,
  })).toBeUndefined();
});

test("a session route refuses an untrusted or non-human turn", () => {
  for (const origin of ["scheduled", "peer", "orchestration", undefined] as const) {
    expect(resolveSessionElicitationTurnRoute({
      isolationChatKey: "relay:acct-9",
      ...(origin !== undefined ? { origin } : {}),
      metadata: { origin: "human", chatType: "direct", senderId: "relay:acct-9" } as never,
    })).toBeUndefined();
  }
  expect(resolveSessionElicitationTurnRoute({
    isolationChatKey: "relay:acct-9",
    origin: "human",
    metadata: { origin: "human", chatType: "direct" } as never,
  })).toBeUndefined();
});

test("a session route keeps the trusted ingress address as its reply context", () => {
  // A renderer that needs a user-facing address must not have to guess one.
  const route = resolveSessionElicitationTurnRoute({
    isolationChatKey: "weixin:default:alice",
    origin: "human",
    metadata: {
      origin: "human",
      chatType: "direct",
      senderId: "alice",
      permissionChatKey: "relay:acct-9",
    } as never,
  });
  expect(route).not.toBeUndefined();
  // The shared resolver prefers the trusted ingress key, which for a session turn
  // is the same kind of address the turn was dispatched from.
  expect(route!.chatKey).toBe("relay:acct-9");
  expect(route!.replyContextToken).toBe("relay:acct-9");
});
