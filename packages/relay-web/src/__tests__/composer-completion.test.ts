import { describe, expect, it } from "vitest";
import {
  completionKey,
  mentionQueryAt,
  replaceRange,
  slashQuery,
} from "../lib/composer-completion";

const base = {
  shiftKey: false,
  isComposing: false,
  composing: false,
  menu: "closed" as const,
  itemCount: 0,
  activeIndex: 0,
  holdKeys: false,
  collapsedCaret: true,
  busy: false,
  caretAtStart: false,
  historyArmed: false,
};

describe("composer completion", () => {
  it("Enter and Tab inside an open menu commit the active row and do not send", () => {
    expect(completionKey({ ...base, menu: "slash", itemCount: 3, activeIndex: 1, key: "Enter" })).toEqual({ type: "commit", index: 1 });
    expect(completionKey({ ...base, menu: "mention", itemCount: 2, activeIndex: 0, key: "Tab" })).toEqual({ type: "commit", index: 0 });
  });

  it("Escape dismisses the menu and a non-collapsed selection does not commit", () => {
    expect(completionKey({ ...base, menu: "slash", itemCount: 2, key: "Escape" })).toEqual({ type: "dismiss" });
    expect(completionKey({
      ...base,
      menu: "mention",
      itemCount: 2,
      collapsedCaret: false,
      key: "Enter",
    })).toEqual({ type: "blocked" });
  });

  it("an IME composition does not send or commit", () => {
    expect(completionKey({ ...base, key: "Enter", isComposing: true })).toEqual({ type: "ignore" });
    expect(completionKey({
      ...base,
      menu: "slash",
      itemCount: 1,
      key: "Enter",
      composing: true,
    })).toEqual({ type: "ignore" });
  });

  it("a hint with no rows swallows Enter and Tab", () => {
    expect(completionKey({ ...base, menu: "slash", itemCount: 0, holdKeys: true, key: "Enter" })).toEqual({ type: "blocked" });
    expect(completionKey({ ...base, menu: "slash", itemCount: 0, holdKeys: true, key: "Tab" })).toEqual({ type: "blocked" });
    expect(completionKey({ ...base, menu: "slash", itemCount: 0, holdKeys: true, key: "Escape" })).toEqual({ type: "dismiss" });
  });

  it("moves the active index inside the row count", () => {
    expect(completionKey({ ...base, menu: "slash", itemCount: 2, activeIndex: 1, key: "ArrowDown" })).toEqual({ type: "move", index: 0 });
    expect(completionKey({ ...base, menu: "slash", itemCount: 2, activeIndex: 0, key: "ArrowUp" })).toEqual({ type: "move", index: 1 });
  });

  it("replaces only the completion range", () => {
    expect(replaceRange("ask @Ann now", { start: 4, end: 8 }, "@Anna ")).toEqual({
      text: "ask @Anna  now",
      cursor: 10,
    });
    expect(slashQuery("/co")).toEqual({ query: "co", range: { start: 0, end: 3 } });
    expect(slashQuery("/compact now")).toBeNull();
    expect(mentionQueryAt("hi @张", 5)).toEqual({ query: "张", range: { start: 3, end: 5 } });
  });

  it("sends Enter only when no menu owns the key", () => {
    expect(completionKey({ ...base, key: "Enter" })).toEqual({ type: "send" });
    expect(completionKey({ ...base, key: "Enter", shiftKey: true })).toEqual({ type: "passthrough" });
  });
});
