import { expect, test } from "bun:test";

import { resolveElicitationTurnRoute } from "../../../src/interactions/elicitation-turn-route";
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
