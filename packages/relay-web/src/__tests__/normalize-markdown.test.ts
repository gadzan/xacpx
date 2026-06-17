import { describe, it, expect } from "vitest";
import { normalizeMarkdownTables } from "../lib/normalize-markdown";

describe("normalizeMarkdownTables", () => {
  it("inserts a blank line before a table that directly follows a paragraph", () => {
    const src = "打开 snake.html 即可体验：\n| # | 功能 |\n| --- | --- |\n| 1 | a |";
    const out = normalizeMarkdownTables(src);
    expect(out).toBe("打开 snake.html 即可体验：\n\n| # | 功能 |\n| --- | --- |\n| 1 | a |");
  });

  it("inserts a missing delimiter row after a header (header + data, no separator)", () => {
    const src = "| # | 功能 | 说明 |\n| 1 | a | b |\n| 2 | c | d |";
    const out = normalizeMarkdownTables(src);
    // a 3-column delimiter row is inserted right after the header
    expect(out).toBe("| # | 功能 | 说明 |\n| --- | --- | --- |\n| 1 | a | b |\n| 2 | c | d |");
  });

  it("does both: blank line before AND inserts a delimiter row", () => {
    const src = "text:\n| a | b |\n| 1 | 2 |";
    expect(normalizeMarkdownTables(src)).toBe("text:\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("leaves an already-valid table unchanged (has blank line + delimiter)", () => {
    const src = "intro\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("leaves a valid table at the very start unchanged", () => {
    const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("does not touch pipes inside a fenced code block", () => {
    const src = "```\n| not | a | table |\n| because | in | code |\n```";
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("does not touch a tilde-fenced code block", () => {
    const src = "~~~\n| a | b |\n| 1 | 2 |\n~~~";
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("ignores a lone pipe line that is not followed by another pipe row", () => {
    // A single `| x |` line in prose is not a table; leave it alone.
    const src = "see | this | thing\n| just one |\nnext paragraph";
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("ignores lines without a leading pipe (conservative: only leading-| rows count)", () => {
    const src = "a | b | c\n1 | 2 | 3"; // no leading pipe → not treated as a table
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("preserves an existing tolerant delimiter (e.g. alignment colons, loose dashes)", () => {
    const src = "| a | b |\n|:--|--:|\n| 1 | 2 |";
    expect(normalizeMarkdownTables(src)).toBe(src);
  });

  it("returns empty string unchanged", () => {
    expect(normalizeMarkdownTables("")).toBe("");
  });
});
