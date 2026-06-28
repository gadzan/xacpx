import { expect, test } from "bun:test";
import { sanitizeString } from "../../../src/util/sanitize";

test("sanitizeString with allow pattern keeps allowed characters", () => {
  expect(sanitizeString("hello_world", { allow: /[a-z_]/ })).toBe("hello_world");
});

test("sanitizeString with allow pattern replaces disallowed characters", () => {
  expect(sanitizeString("hello world!", { allow: /[a-z_]/ })).toBe("hello-world-");
});

test("sanitizeString with deny pattern replaces denied characters", () => {
  expect(sanitizeString("hello world!", { deny: /\s/ })).toBe("hello-world!");
});

test("sanitizeString collapses multiple replacements", () => {
  expect(sanitizeString("hello   world", { deny: /\s/, collapse: true })).toBe("hello-world");
});

test("sanitizeString trims replacements from start and end", () => {
  expect(sanitizeString("  hello world  ", { deny: /\s/, trim: true })).toBe("hello-world");
});

test("sanitizeString lowercases when requested", () => {
  expect(sanitizeString("Hello World", { lowercase: true })).toBe("hello world");
});

test("sanitizeString returns fallback for empty result", () => {
  expect(sanitizeString("!!!", { deny: /[^a-z]/, fallback: "default" })).toBe("default");
});

test("sanitizeString uses custom replacement", () => {
  expect(sanitizeString("hello world", { deny: /\s/, replacement: "_" })).toBe("hello_world");
});

test("sanitizeString combines multiple options", () => {
  expect(sanitizeString("  Hello World!!!  ", {
    deny: /[^a-z]/,
    replacement: "-",
    lowercase: true,
    collapse: true,
    trim: true,
  })).toBe("hello-world");
});

test("sanitizeString returns empty string when all characters are stripped", () => {
  expect(sanitizeString("!!!", { deny: /[^a-z]/ })).toBe("");
});