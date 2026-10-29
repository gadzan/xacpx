import { expect, test } from "bun:test";
import { isSilenceReply, parseMentions, SILENCE_REPLY } from "../../../src/conversations/group-chat-wake";

const members = [
  { botId: "bot_a", name: "幕僚长 · 执行,管理" },
  { botId: "bot_b", name: "Bob Reviewer" },
  { botId: "bot_c", name: "Bob" },
];

test("whole-name match resolves a name containing spaces, a middle dot and a comma", () => {
  expect(parseMentions('@"幕僚长 · 执行,管理" 请看一下', members)).toEqual({ mode: "members", botIds: ["bot_a"] });
  expect(parseMentions("@幕僚长 · 执行,管理 请看一下", members)).toEqual({ mode: "members", botIds: ["bot_a"] });
});

test("a name that is a prefix of another name does not swallow the longer one", () => {
  expect(parseMentions("@Bob Reviewer 看这个", members)).toEqual({ mode: "members", botIds: ["bot_b"] });
  expect(parseMentions("@Bob 看这个", members)).toEqual({ mode: "members", botIds: ["bot_c"] });
});

test("distinct mentions in one message wake each named bot once", () => {
  expect(parseMentions("@Bob 和 @幕僚长 · 执行,管理 都要看", members)).toEqual({
    mode: "members",
    botIds: ["bot_c", "bot_a"],
  });
});

test("no mention wakes everyone, including an unmatched @ token", () => {
  expect(parseMentions("大家怎么看", members)).toEqual({ mode: "everyone" });
  expect(parseMentions("@nobody 在吗", members)).toEqual({ mode: "everyone" });
  expect(parseMentions("@", members)).toEqual({ mode: "everyone" });
  expect(parseMentions("", members)).toEqual({ mode: "everyone" });
});

test("a mention immediately followed by another mention still resolves both", () => {
  expect(parseMentions("@Bob@幕僚长 · 执行,管理", members)).toEqual({ mode: "members", botIds: ["bot_c", "bot_a"] });
});

test("silence is an exact trimmed token, never a substring", () => {
  expect(isSilenceReply("")).toBe(true);
  expect(isSilenceReply("   \n ")).toBe(true);
  expect(isSilenceReply(SILENCE_REPLY)).toBe(true);
  expect(isSilenceReply(`  ${SILENCE_REPLY}  `)).toBe(true);
  expect(isSilenceReply(`先说结论 ${SILENCE_REPLY} 再说细节`)).toBe(false);
});
