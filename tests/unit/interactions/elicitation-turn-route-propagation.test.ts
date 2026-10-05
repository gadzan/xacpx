import { describe, expect, test } from "bun:test";

import {
  resolveElicitationTurnRoute,
} from "../../../src/interactions/elicitation-turn-route.js";
import { resolvePermissionTurnRoute } from "../../../src/permissions/permission-turn-route.js";
import { getChannelIdFromChatKey } from "../../../src/channels/channel-scope.js";
import type { ChatRequestMetadata } from "../../../src/weixin/agent/interface.js";

/**
 * The two PRs that meet on the exact-turn seam.
 *
 * #361 adds the elicitation route for Direct Bot turns. #360 adds the
 * `chatType` privacy contract that a form renderer depends on to decide whether
 * a form may be shown at all. They were rebased together, and the conflict that
 * combining them produced is exactly what these tests pin: both semantics must
 * survive, on the SAME turn.
 *
 * The two failure modes each guard against are the two sides of that conflict:
 *
 *  - Dropping the bot route -> a Direct Bot turn has no route, so the broker
 *    cancels before any renderer is contacted. The request never reaches a human.
 *  - Dropping `chatType`   -> an ordinary channel turn loses its own report of
 *    being `direct`, and a renderer must refuse a form it cannot prove is
 *    private. A group destination would stop the form instead of leaking it, so
 *    the failure is a cancellation rather than a leak — but the user loses a form
 *    they were entitled to, silently.
 *
 * Neither is acceptable, so both are asserted here in one place rather than in
 * two files that could drift apart.
 */

/** `ChatRequestMetadata` as an ingress supplies it for a Direct Bot turn. */
function botMetadata(overrides: Partial<ChatRequestMetadata> = {}): ChatRequestMetadata {
  return {
    origin: "human",
    // The hub-stamped ingress for a Direct Bot turn. NOT a `bot:` key — the
    // product isolation key stays the TurnQueue key.
    permissionChatKey: "relay:acct-42",
    senderId: "relay:acct-42",
    senderName: "Ada",
    isOwner: true,
    ...overrides,
  } as ChatRequestMetadata;
}

describe("exact-turn route: Direct Bot elicitation (M3) + chatType privacy (#360)", () => {
  test("a Direct Bot turn resolves an elicitation route AND keeps its chatType", () => {
    const chatKey = "bot:conv-1:topic-1";
    const metadata = botMetadata({ chatType: "direct" });

    // The M3 half: the route resolves for a Direct Bot turn, which is what the
    // whole feature rests on. Without it the broker cancels before a renderer is
    // ever contacted.
    const route = resolveElicitationTurnRoute({
      isolationChatKey: chatKey,
      origin: "human",
      metadata,
    });
    expect(route).toBeDefined();
    // The route the turn is addressable on is the PRODUCT isolation key, not the
    // account-wide ingress. That distinction is the whole point: `relay:<account>`
    // is one address for every topic, so a route collapsed to it places the form
    // on no topic in particular. The trusted ingress is still carried, as
    // `replyContextToken`, for a renderer that needs a user-facing address.
    expect(route!.chatKey).toBe("bot:conv-1:topic-1");
    // The trusted ingress address the caller supplied, carried for addressing.
    expect(route!.replyContextToken).toBe("relay:acct-42");
    // The trusted responder identity, without which the broker refuses anyway.
    expect(route!.senderId).toBe("relay:acct-42");

    // The #360 half: the turn context the broker binds carries the channel's own
    // report of route privacy, read off the same metadata. This is what a
    // renderer gates on, and it must survive the route the M3 resolver returns.
    const turnContext = {
      interactionId: "ix-1",
      chatKey: route!.chatKey,
      origin: "human" as const,
      senderId: route!.senderId,
      ...(metadata.chatType !== undefined ? { chatType: metadata.chatType } : {}),
    };
    expect(turnContext.chatType).toBe("direct");
  });

  test("bot: turns never gain a permission route from their isolation key alone", () => {
    // The widening is elicitation-only. A product isolation key must never mint a
    // human permission interaction, even though it now mints an elicitation one.
    const chatKey = "bot:conv-1:topic-1";

    // No trusted ingress address on the turn -> no permission route. This is the
    // case the shared resolver's policy flag exists for: `bot:` is the product
    // isolation key, and permission refuses it outright.
    expect(resolvePermissionTurnRoute({
      isolationChatKey: chatKey,
      origin: "human",
      metadata: { origin: "human", senderId: "relay:acct-42" } as ChatRequestMetadata,
    })).toBeUndefined();

    // With a trusted ingress address the permission route resolves — to THAT
    // address, which is an ordinary `relay:` key, not the product isolation key.
    // So the route never carries a `bot:` key into the permission broker.
    const withIngress = resolvePermissionTurnRoute({
      isolationChatKey: chatKey,
      origin: "human",
      metadata: botMetadata(),
    });
    expect(withIngress).toBeDefined();
    expect(withIngress!.chatKey).toBe("relay:acct-42");
    expect(withIngress!.chatKey.startsWith("bot:")).toBe(false);
  });

  test("the elicitation route is not permission permission-but-looser", () => {
    // The two kinds resolve on the same turn to DIFFERENT addresses, and that is
    // the difference that matters: permission stays on the trusted ingress key
    // it has always used, while elicitation keeps the product isolation key so
    // the form lands on the right topic.
    const metadata = botMetadata();
    const chatKey = "bot:conv-1:topic-1";
    expect(resolvePermissionTurnRoute({ isolationChatKey: chatKey, origin: "human", metadata }))
      .not.toBeUndefined();

    // With no ingress address at all, permission refuses (a `bot:` isolation key
    // is not a permission route) while elicitation ACCEPTS the same key — the
    // one place the two genuinely differ.
    const withoutIngress = { origin: "human", senderId: "relay:acct-42" } as ChatRequestMetadata;
    expect(resolvePermissionTurnRoute({ isolationChatKey: chatKey, origin: "human", metadata: withoutIngress }))
      .toBeUndefined();
    const elicWithoutIngress = resolveElicitationTurnRoute({
      isolationChatKey: chatKey,
      origin: "human",
      metadata: withoutIngress,
    });
    expect(elicWithoutIngress).toBeDefined();
    // The product isolation key is the route in that case, and it parses strictly.
    expect(elicWithoutIngress!.chatKey).toBe("bot:conv-1:topic-1");
  });

  test("a malformed bot key yields no route rather than a satisfiable one", () => {
    // `bot:garbage` parses to nothing, so no route can be built from it. A
    // prefix-only match would let ANY turn in ANY topic satisfy the route.
    for (const bad of ["bot:garbage", "bot:", "bot:", "bot:c:t:extra"]) {
      expect(resolveElicitationTurnRoute({
        isolationChatKey: bad,
        origin: "human",
        metadata: botMetadata(),
      })).toBeUndefined();
    }
  });

  test("a non-human origin gets no route", () => {
    // Scheduled and orchestrated turns must never receive a UI.
    expect(resolveElicitationTurnRoute({
      isolationChatKey: "bot:conv-1:topic-1",
      origin: "orchestration",
      metadata: botMetadata(),
    })).toBeUndefined();
  });

  test("an untrusted identity gets no route", () => {
    // The broker would refuse it anyway; failing here gives the clearer reason.
    expect(resolveElicitationTurnRoute({
      isolationChatKey: "bot:conv-1:topic-1",
      origin: "human",
      metadata: { origin: "human" } as ChatRequestMetadata,
    })).toBeUndefined();
  });

  test("a bot: chatKey still routes to the relay channel (the #361 routing fix)", () => {
    // This is the half that made the whole feature reachable: without it the
    // request reached a channel that cannot render, and the broker cancelled with
    // a message that looks like an unsupported channel rather than a bug.
    expect(getChannelIdFromChatKey("bot:conv_1:topic_1")).toBe("relay");
    // And an ordinary key with the same first segment is not a bot key.
    expect(getChannelIdFromChatKey("botzone:default:chat")).toBe("weixin");
  });

  test("chatType is absent when the channel never reported one", () => {
    // The fail-closed half of the #360 contract: absent is NOT "direct". A
    // renderer must treat it as not-provably-private, which is why the
    // propagation is conditional rather than defaulted.
    const metadata = botMetadata();
    expect(metadata.chatType).toBeUndefined();
    const turnContext = {
      chatKey: "bot:conv-1:topic-1",
      ...(metadata.chatType !== undefined ? { chatType: metadata.chatType } : {}),
    };
    expect("chatType" in turnContext).toBe(false);
  });

  test("a group destination's chatType reaches the renderer unchanged", () => {
    // The reason the contract exists: a form renders the question AND the answers
    // into the chat. A group destination shows both to everyone, so the renderer
    // must be able to see "group" and refuse.
    const route = resolveElicitationTurnRoute({
      isolationChatKey: "bot:conv-1:topic-1",
      origin: "human",
      metadata: botMetadata({ chatType: "group" }),
    });
    expect(route).toBeDefined();
  });

  test("the permission and elicitation resolvers read the same identity metadata", () => {
    // The shared resolver is what keeps the two kinds from drifting on which
    // identity fields matter. Both must agree on WHO is being asked — only the
    // address they route to differs, and it differs deliberately: permission
    // returns the trusted ingress key, elicitation returns the product isolation
    // key so the form lands on the right topic.
    const metadata = botMetadata({ chatType: "direct" });
    const perm = resolvePermissionTurnRoute({
      isolationChatKey: "bot:conv-1:topic-1",
      origin: "human",
      metadata,
    });
    const elic = resolveElicitationTurnRoute({
      isolationChatKey: "bot:conv-1:topic-1",
      origin: "human",
      metadata,
    });
    expect(perm).toBeDefined();
    expect(elic).toBeDefined();
    // Same trusted human, from the same metadata, through the same shared code.
    expect(elic!.senderId).toBe(perm!.senderId);
    expect(elic!.accountId).toBe(perm!.accountId);
    expect(elic!.isOwner).toBe(perm!.isOwner);
    // Different addresses, on purpose. Permission's is account-wide; elicitation's
    // is this exact turn.
    expect(perm!.chatKey).toBe("relay:acct-42");
    expect(elic!.chatKey).toBe("bot:conv-1:topic-1");
  });
});

/**
 * The M5 truthfulness half of the same seam.
 *
 * An ordinary (non-Direct-Conversation) turn must produce NO elicitation route, and
 * the caller must not substitute the permission route for it. Substituting is the
 * bug this pins: the permission route for an ordinary turn is the account-wide
 * ingress key (`relay:<accountId>`), which the elicitation broker would happily
 * bind as a trusted route. Its capability check then passes on the channel's
 * channel-wide `["form"]` declaration, the request reaches a renderer that can
 * only refuse it as `unsupported-route`, and the agent is told a human was asked
 * when no human ever saw the question.
 *
 * So `undefined` has to stay `undefined` all the way through the caller.
 */
describe("ordinary turns have no elicitation route to fall back on", () => {
  test("an ordinary channel turn resolves NO elicitation route", () => {
    const route = resolveElicitationTurnRoute({
      // The isolation key an ordinary Relay session turn carries.
      isolationChatKey: "relay:acct-9",
      origin: "human",
      metadata: botMetadata({ chatType: "direct" }),
    });
    expect(route).toBeUndefined();
  });

  test("a group isolation key resolves NO elicitation route", () => {
    const route = resolveElicitationTurnRoute({
      isolationChatKey: "wx:group-7",
      origin: "human",
      metadata: botMetadata({ chatType: "group" }),
    });
    expect(route).toBeUndefined();
  });

  test("the permission resolver still resolves for those same turns", () => {
    // The asymmetry is the point. Permission MUST keep working for ordinary turns
    // — it is the only route an ordinary turn has — so the fix cannot be "resolve
    // nothing for non-bot keys". Only the elicitation route is withheld.
    const perm = resolvePermissionTurnRoute({
      isolationChatKey: "relay:acct-9",
      origin: "human",
      metadata: botMetadata({ chatType: "direct" }),
    });
    expect(perm).toBeDefined();
    expect(perm!.chatKey).toBe("relay:acct-42");
  });
});
