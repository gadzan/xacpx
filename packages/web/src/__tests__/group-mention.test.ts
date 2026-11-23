import { describe, expect, it } from "vitest";
import {
  filterMentionMembers,
  groupMentionQuery,
  mentionDisplayToken,
  reconcileMentions,
  type GroupMentionMember,
  type MentionBinding,
} from "../lib/group-mention";

const members: GroupMentionMember[] = [
  { botId: "bot_a", name: "张三", role: "reviewer", enabled: true, lead: true },
  { botId: "bot_b", name: "Code Reviewer", role: "tester", enabled: true, lead: false },
  { botId: "bot_c", name: "Same", role: "writer", enabled: true, lead: false },
  { botId: "bot_d", name: "Same", role: "writer", enabled: true, lead: false },
  { botId: "bot_off", name: "Sleeper", enabled: false, lead: false },
];

describe("group mentions", () => {
  it("resolves a Chinese name and a quoted name with spaces to bot ids", () => {
    expect(reconcileMentions("@张三 ", [], members)).toEqual({
      kind: "resolved",
      target: { mode: "members", botIds: ["bot_a"] },
      bindings: [{ botId: "bot_a", displayToken: "@张三" }],
    });
    expect(reconcileMentions('@"Code Reviewer" ', [], members)).toEqual({
      kind: "resolved",
      target: { mode: "members", botIds: ["bot_b"] },
      bindings: [{ botId: "bot_b", displayToken: '@"Code Reviewer"' }],
    });
    expect(mentionDisplayToken("Code Reviewer")).toBe('@"Code Reviewer"');
  });

  it("does not pick one of two members who share a name", () => {
    expect(reconcileMentions("@Same ", [], members)).toEqual({
      kind: "unresolved",
      displayToken: "@Same",
      reason: "ambiguous",
      bindings: [],
    });
  });

  it("keeps the bot id chosen from the menu when the display token is shared", () => {
    const prior: MentionBinding[] = [{ botId: "bot_d", displayToken: "@Same" }];
    expect(reconcileMentions("@Same ", prior, members)).toEqual({
      kind: "resolved",
      target: { mode: "members", botIds: ["bot_d"] },
      bindings: [{ botId: "bot_d", displayToken: "@Same" }],
    });
  });

  it("reports a disabled member and a removed binding instead of keeping another target", () => {
    expect(reconcileMentions("@Sleeper ", [], members).kind).toBe("unresolved");
    expect(reconcileMentions("@Sleeper ", [], members)).toMatchObject({ reason: "disabled" });
    const removed: MentionBinding[] = [{ botId: "gone", displayToken: "@张三" }];
    expect(reconcileMentions("@张三 ", removed, members)).toMatchObject({ reason: "removed" });
  });

  it("drops a structured binding when the token is undone", () => {
    const prior: MentionBinding[] = [{ botId: "bot_a", displayToken: "@张三" }];
    expect(reconcileMentions("hello", prior, members)).toEqual({ kind: "pending" });
  });

  it("filters the menu by Chinese text and still lists a disabled member", () => {
    const typed = "ping @张";
    expect(groupMentionQuery(typed, typed.length)).toEqual({
      query: "张",
      range: { start: typed.lastIndexOf("@"), end: typed.length },
    });
    const rows = filterMentionMembers(members, "张");
    expect(rows.map((row) => row.botId)).toEqual(["bot_a"]);
    expect(filterMentionMembers(members, "sleeper").map((row) => row.botId)).toEqual(["bot_off"]);
  });
});
