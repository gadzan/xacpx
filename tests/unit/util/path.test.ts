import { expect, test } from "bun:test";
import { normalizePath, basenameForPath, isSamePath, isWindowsLikePath } from "../../../src/util/path";

test("normalizePath expands ~ to homedir", () => {
  const result = normalizePath("~/foo");
  expect(result).toContain("/foo");
  expect(result.endsWith("/foo")).toBe(true);
});

test("normalizePath converts backslashes to forward slashes on unix", () => {
  const result = normalizePath("foo/bar\\baz");
  expect(result).not.toContain("\\");
});

test("normalizePath normalizes windows drive paths", () => {
  const result = normalizePath("C:\\Users\\test");
  expect(result).toBe("C:/Users/test");
});

test("normalizePath handles UNC paths", () => {
  const result = normalizePath("\\\\server\\share\\file");
  expect(result).toBe("////server/share/file");
});

test("normalizePath normalizes posix paths", () => {
  const result = normalizePath("/foo//bar/../baz");
  expect(result).toBe("/foo/baz");
});

test("basenameForPath returns root for root paths", () => {
  expect(basenameForPath("/")).toBe("/");
  expect(basenameForPath("/a")).toBe("/a");
});

test("basenameForPath extracts basename from normalized paths", () => {
  expect(basenameForPath("/foo/bar.txt")).toBe("bar.txt");
  expect(basenameForPath("/foo/bar/baz")).toBe("baz");
});

test("basenameForPath handles empty basename", () => {
  const result = basenameForPath("/foo/");
  expect(result).toBe("foo");
});

test("basenameForPath works with normalized windows paths", () => {
  expect(basenameForPath("C:/Users/test/file.txt")).toBe("file.txt");
});

test("isSamePath compares normalized paths on unix", () => {
  expect(isSamePath("/foo/bar", "/foo/bar")).toBe(true);
  expect(isSamePath("/foo/bar/", "/foo/bar")).toBe(true);
  expect(isSamePath("/foo/bar/./baz", "/foo/bar/baz")).toBe(true);
  expect(isSamePath("/foo/bar", "/foo/baz")).toBe(false);
});

test("isSamePath is case-insensitive on windows", () => {
  expect(isSamePath("C:/Users/Test", "C:/users/test")).toBe(true);
});

test("isSamePath returns false for mismatched windows vs unix", () => {
  // Unix path should not match windows path even with similar structure
  expect(isSamePath("C:/foo/bar", "/foo/bar")).toBe(false);
});

test("isSamePath handles trailing slashes consistently", () => {
  expect(isSamePath("/foo/bar", "/foo/bar/")).toBe(true);
  expect(isSamePath("/foo/bar/", "/foo/bar")).toBe(true);
});

test("isWindowsLikePath detects drive paths", () => {
  expect(isWindowsLikePath("C:/foo")).toBe(true);
  expect(isWindowsLikePath("D:\\foo")).toBe(true);
  expect(isWindowsLikePath("c:\\foo")).toBe(true);
});

test("isWindowsLikePath detects UNC paths", () => {
  expect(isWindowsLikePath("\\\\server\\share")).toBe(true);
});

test("isWindowsLikePath returns false for unix paths", () => {
  expect(isWindowsLikePath("/foo/bar")).toBe(false);
  expect(isWindowsLikePath("foo/bar")).toBe(false);
});

test("normalizePath handles mixed separators", () => {
  expect(normalizePath("foo\\bar/baz")).toBe("foo/bar/baz");
  expect(normalizePath("foo/bar\\baz")).toBe("foo/bar/baz");
});

test("basenameForPath handles tilde paths", () => {
  const result = basenameForPath("~/foo/bar.txt");
  expect(result).toBe("bar.txt");
});

test("isSamePath handles tilde expansions", () => {
  const normalized = normalizePath("~/foo");
  const homedirPath = normalizePath(`${process.env.HOME || process.env.USERPROFILE}/foo`);
  expect(isSamePath(normalized, homedirPath)).toBe(true);
});