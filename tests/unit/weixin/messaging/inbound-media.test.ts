import { expect, test } from "bun:test";
import { extractWeixinMediaDescriptors, hasWeixinInboundMedia } from "../../../../src/weixin/messaging/inbound";
import { MessageItemType, type MessageItem } from "../../../../src/weixin/api/types";

for (const [type, kind] of [[2, "image"], [3, "audio"], [4, "file"], [5, "video"]] as const) {
  test(`media extraction and admission retain ${kind} through a deep quote chain`, () => {
    const media: MessageItem = { type, file_item: { file_name: "quoted.txt" } };
    let quoted = media;
    for (let i = 0; i < 4096; i++) quoted = { type: MessageItemType.TEXT, text_item: { text: "context" }, ref_msg: { message_item: quoted } };
    expect(extractWeixinMediaDescriptors([quoted])).toEqual([{ item: media, kind, ...(type === 4 ? { fileName: "quoted.txt" } : {}) }]);
    expect(hasWeixinInboundMedia([quoted])).toBe(true);
  });
}

test("media traversal preserves item order and separately referenced attachments", () => {
  const image = { type: MessageItemType.IMAGE };
  const file = { type: MessageItemType.FILE, file_item: { file_name: "file.txt" } };
  const quote = { type: MessageItemType.TEXT, ref_msg: { message_item: image } };
  expect(extractWeixinMediaDescriptors([quote, file, quote]).map((entry) => entry.item)).toEqual([image, file, image]);
  expect(hasWeixinInboundMedia([{ type: MessageItemType.TEXT, ref_msg: { message_item: { type: MessageItemType.TEXT } } }])).toBe(false);
});

test("media traversal terminates cyclic quote objects without losing later top-level media", () => {
  const first: MessageItem = { type: MessageItemType.TEXT };
  const second: MessageItem = { type: MessageItemType.TEXT, ref_msg: { message_item: first } };
  first.ref_msg = { message_item: second };
  const video = { type: MessageItemType.VIDEO };
  expect(extractWeixinMediaDescriptors([first, video])).toEqual([{ item: video, kind: "video" }]);
  expect(hasWeixinInboundMedia([first, video])).toBe(true);
  expect(hasWeixinInboundMedia([first])).toBe(false);
});
