import { expect, test } from "bun:test";

import { buildFeishuRouteMetadata } from "../../../../packages/channel-feishu/src/inbound";

test("buildFeishuRouteMetadata maps p2p chat_type to direct", () => {
  expect(
    buildFeishuRouteMetadata({ chatType: "p2p", senderOpenId: "ou_sender", chatId: "oc_chat" }),
  ).toEqual({ channel: "feishu", chatType: "direct", senderId: "ou_sender" });
});

test("buildFeishuRouteMetadata maps group chat_type to group and carries groupId", () => {
  expect(
    buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_sender", chatId: "oc_chat" }),
  ).toEqual({ channel: "feishu", chatType: "group", senderId: "ou_sender", groupId: "oc_chat", isOwner: false });
});

test("buildFeishuRouteMetadata defaults unknown/undefined chat_type to direct", () => {
  expect(buildFeishuRouteMetadata({ chatType: undefined, chatId: "oc_chat" })).toEqual({
    channel: "feishu",
    chatType: "direct",
  });
});

test("buildFeishuRouteMetadata asserts isOwner true only for a positive owner resolution", () => {
  expect(
    buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_owner", chatId: "oc_chat", senderIsOwner: true }),
  ).toEqual({ channel: "feishu", chatType: "group", senderId: "ou_owner", groupId: "oc_chat", isOwner: true });
});

test("buildFeishuRouteMetadata writes explicit isOwner false on group turns (stale-owner overwrite)", () => {
  // Group turns always carry an explicit boolean: the persistent coordinator
  // route merges with `input.isOwner ?? existing.isOwner`, so omitting the
  // field on a non-owner turn would let it inherit a previous owner turn's
  // true and slip past the scheduled_* owner gates.
  expect(
    buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_member", chatId: "oc_chat", senderIsOwner: false }),
  ).toEqual({ channel: "feishu", chatType: "group", senderId: "ou_member", groupId: "oc_chat", isOwner: false });
  // Feature off / lookup failure (senderIsOwner unresolved) fails closed too.
  expect(
    buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_member", chatId: "oc_chat" }),
  ).toEqual({ channel: "feishu", chatType: "group", senderId: "ou_member", groupId: "oc_chat", isOwner: false });
});

test("buildFeishuRouteMetadata omits isOwner on direct turns", () => {
  expect(
    buildFeishuRouteMetadata({ chatType: "p2p", senderOpenId: "ou_sender", chatId: "oc_chat", senderIsOwner: true }),
  ).toEqual({ channel: "feishu", chatType: "direct", senderId: "ou_sender" });
});
test("buildFeishuRouteMetadata omits senderId when sender open_id is absent", () => {
  expect(buildFeishuRouteMetadata({ chatType: "p2p", chatId: "oc_chat" })).toEqual({
    channel: "feishu",
    chatType: "direct",
  });
});
