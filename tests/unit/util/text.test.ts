import { expect, test } from "bun:test";
import { truncateText, escapeForDoubleQuotes, quoteIfNeeded } from "../../../src/util/text";

test("truncateText returns unchanged text when within limit", () => {
  expect(truncateText("hello", 10)).toBe("hello");
});

test("truncateText truncates and adds ellipsis when over limit", () => {
  // slices to maxLength - ellipsis.length, then appends the ellipsis
  expect(truncateText("hello world", 8)).toBe("hello w…");
});

test("truncateText handles empty string", () => {
  expect(truncateText("", 10)).toBe("");
});

test("truncateText uses custom ellipsis", () => {
  expect(truncateText("hello world", 8, "---")).toBe("hello---");
});

test("truncateText handles exact limit", () => {
  expect(truncateText("hello", 5)).toBe("hello");
});

test("truncateText handles text shorter than ellipsis", () => {
  // maxLength < ellipsis length: slice(0, negative) is empty, leaving just the ellipsis
  expect(truncateText("hi", 1)).toBe("…");
});

test("escapeForDoubleQuotes escapes backslashes and quotes", () => {
  expect(escapeForDoubleQuotes('hello "world"')).toBe('hello \\"world\\"');
  expect(escapeForDoubleQuotes("hello \\ world")).toBe("hello \\\\ world");
  expect(escapeForDoubleQuotes('hello "world" \\')).toBe('hello \\"world\\" \\\\');
});

test("quoteIfNeeded wraps text in escaped double quotes", () => {
  expect(quoteIfNeeded('hello "world"')).toBe('"hello \\"world\\""');
  expect(quoteIfNeeded("simple")).toBe('"simple"');
});
