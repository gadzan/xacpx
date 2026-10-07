import { expect, test } from "bun:test";
import { bodyFromItemList, extractWeixinMediaDescriptors, hasWeixinInboundMedia } from "../../../../src/weixin/messaging/inbound";
import { MessageItemType, type MessageItem } from "../../../../src/weixin/api/types";
import { getLocale, setLocale } from "../../../../src/i18n";

for (const [type, kind] of [[2, "image"], [3, "audio"], [4, "file"], [5, "video"]] as const) {
  test(`media extraction and admission retain ${kind} through a deep quote chain`, () => {
    const media: MessageItem = { type, file_item: { file_name: "quoted.txt" } };
    let quoted = media;
    for (let i = 0; i < 4096; i++) quoted = { type: MessageItemType.TEXT, text_item: { text: "context" }, ref_msg: { message_item: quoted } };
    expect(extractWeixinMediaDescriptors([quoted])).toEqual([{ item: media, kind, ...(type === 4 ? { fileName: "quoted.txt" } : {}) }]);
    expect(hasWeixinInboundMedia([quoted])).toBe(true);
    const rendered = bodyFromItemList([quoted], true);
    expect(rendered).toStartWith("context\n\n[Quote: context");
    expect(rendered.match(/\[Quote: /g)).toHaveLength(4095);
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
  const first: MessageItem = { type: MessageItemType.TEXT, text_item: { text: "first" } };
  const second: MessageItem = { type: MessageItemType.TEXT, text_item: { text: "second" }, ref_msg: { message_item: first } };
  first.ref_msg = { message_item: second };
  const video = { type: MessageItemType.VIDEO };
  expect(extractWeixinMediaDescriptors([first, video])).toEqual([{ item: video, kind: "video" }]);
  expect(hasWeixinInboundMedia([first, video])).toBe(true);
  expect(hasWeixinInboundMedia([first])).toBe(false);
  expect(bodyFromItemList([first], true)).toBe("first\n\n[Quote: second]");
});

test("quote rendering preserves canonical and localized title/empty/media/fallback semantics", () => {
  const prior = getLocale();
  const text = (value?: string, title?: string, quoted?: MessageItem): MessageItem => ({ type: 1, text_item: { text: value },
    ...(title !== undefined || quoted ? { ref_msg: { title, message_item: quoted } } : {}) });
  const cases: Array<{ items: MessageItem[]; canonical: string; ordinary: (prefix: string) => string }> = [
    { items: [], canonical: "", ordinary: () => "" },
    { items: [text("authored")], canonical: "authored", ordinary: () => "authored" },
    { items: [text("authored", "title")], canonical: "authored\n\n[Quote: title]", ordinary: (p) => `${p}title]\nauthored` },
    { items: [text("authored", "title", text(""))], canonical: "authored\n\n[Quote: title]", ordinary: (p) => `${p}title]\nauthored` },
    { items: [text("authored", "", text(""))], canonical: "authored", ordinary: () => "authored" },
    { items: [text("authored", "title", text(undefined, "ignored", text("ignored")))], canonical: "authored\n\n[Quote: title]", ordinary: (p) => `${p}title]\nauthored` },
    { items: [text("authored", "", text("prior"))], canonical: "authored\n\n[Quote: prior]", ordinary: (p) => `${p}prior]\nauthored` },
    { items: [text("", "", text("prior"))], canonical: "\n\n[Quote: prior]", ordinary: (p) => `${p}prior]\n` },
    { items: [text(undefined, "ignored", text("ignored")), text("fallback")], canonical: "fallback", ordinary: () => "fallback" },
    { items: [{ type: 3, voice_item: { text: "transcript" } }], canonical: "transcript", ordinary: () => "transcript" },
    { items: [text("authored", "outer", text("", "inner", text("prior")))], canonical: "authored\n\n[Quote: outer | \n\n[Quote: inner | prior]]",
      ordinary: (p) => `${p}outer | ${p}inner | prior]\n]\nauthored` },
  ];
  for (const type of [2, 3, 4, 5]) cases.push({ items: [text("authored", "ignored media title", { type, voice_item: { text: "ignored transcript" } })],
    canonical: "authored", ordinary: () => "authored" });
  try {
    for (const locale of ["en", "zh"] as const) {
      setLocale(locale);
      for (const c of cases) {
        expect(bodyFromItemList(c.items, true)).toBe(c.canonical);
        expect(bodyFromItemList(c.items)).toBe(c.ordinary(locale === "en" ? "[Quote: " : "[引用: "));
      }
    }
  } finally { setLocale(prior); }
});

test("deep localized text and cyclic quotes render without recursive calls", () => {
  const prior = getLocale();
  let item: MessageItem = { type: 1, text_item: { text: "leaf" } };
  for (let i = 0; i < 32768; i++) item = { type: 1, text_item: { text: "context" }, ref_msg: { message_item: item } };
  const cycle: MessageItem = { type: 1, text_item: { text: "cycle" }, ref_msg: { title: "loop" } };
  cycle.ref_msg!.message_item = cycle;
  try {
    for (const locale of ["en", "zh"] as const) {
      setLocale(locale);
      const rendered = bodyFromItemList([item]);
      expect(rendered).toContain("leaf");
      expect(rendered.match(locale === "en" ? /\[Quote: /g : /\[引用: /g)).toHaveLength(32768);
      expect(rendered).toEndWith("\ncontext");
      expect(bodyFromItemList([cycle])).toBe(`${locale === "en" ? "[Quote: " : "[引用: "}loop]\ncycle`);
      expect(bodyFromItemList([cycle], true)).toBe("cycle\n\n[Quote: loop]");
    }
  } finally { setLocale(prior); }
});
