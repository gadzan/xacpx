import { expect, test } from "bun:test";
import { homedir } from "node:os";

import {
  basenameForWorkspacePath,
  normalizeWorkspacePath,
  sameWorkspacePath,
} from "../../../src/commands/workspace-path";

test("normalizes Windows drive paths written with forward slashes", () => {
  expect(normalizeWorkspacePath("E:/projects/ec_trade_m")).toBe("E:/projects/ec_trade_m");
});

test("normalizes Windows drive paths written with backslashes", () => {
  expect(normalizeWorkspacePath("E:\\projects\\ec_trade_m")).toBe("E:/projects/ec_trade_m");
});

test("derives the same basename from Windows paths with either separator", () => {
  expect(basenameForWorkspacePath("E:/projects/ec_trade_m")).toBe("ec_trade_m");
  expect(basenameForWorkspacePath("E:\\projects\\ec_trade_m")).toBe("ec_trade_m");
});

test("treats Windows workspace paths with different separators and casing as equal", () => {
  expect(sameWorkspacePath("E:/Projects/ec_trade_m", "e:\\projects\\ec_trade_m")).toBe(true);
});

test("collapses POSIX double-slash prefix", () => {
  expect(normalizeWorkspacePath("//mnt/share/repo")).toBe("/mnt/share/repo");
});

test("expands tilde to home directory", () => {
  expect(normalizeWorkspacePath("~/projects/repo")).toBe(normalizeWorkspacePath(homedir()) + "/projects/repo");
});

test("expands bare tilde to home directory", () => {
  expect(normalizeWorkspacePath("~")).toBe(normalizeWorkspacePath(homedir()));
});

test("derives basename from POSIX paths", () => {
  expect(basenameForWorkspacePath("/home/user/ec_trade_m")).toBe("ec_trade_m");
});

test("POSIX paths compare case-sensitively", () => {
  expect(sameWorkspacePath("/Users/Alice/repo", "/Users/alice/repo")).toBe(false);
});

test("identical POSIX paths are equal", () => {
  expect(sameWorkspacePath("/Users/alice/repo", "/Users/alice/repo")).toBe(true);
});

test("different POSIX paths are not equal", () => {
  expect(sameWorkspacePath("/Users/alice/repo", "/Users/bob/repo")).toBe(false);
});

test("falls back to full path for root paths with empty basename", () => {
  expect(basenameForWorkspacePath("C:/")).toBe("C:/");
  expect(basenameForWorkspacePath("/")).toBe("/");
});

test("treats POSIX paths with a trailing slash as equal", () => {
  expect(sameWorkspacePath("/tmp/x/", "/tmp/x")).toBe(true);
  expect(sameWorkspacePath("/tmp/x", "/tmp/x/")).toBe(true);
});

test("treats Windows drive paths with a trailing separator and different casing as equal", () => {
  expect(sameWorkspacePath("C:/Work/", "c:\\work")).toBe(true);
  expect(sameWorkspacePath("c:\\work", "C:/Work/")).toBe(true);
});

test("keeps root paths equal while tolerating trailing separator variants", () => {
  expect(sameWorkspacePath("/", "/")).toBe(true);
  expect(sameWorkspacePath("/", "//")).toBe(true);
  expect(sameWorkspacePath("C:/", "c:\\")).toBe(true);
  expect(sameWorkspacePath("C:", "C:")).toBe(true);
});

test("different paths stay different after trailing separator normalization", () => {
  expect(sameWorkspacePath("/tmp/x/", "/tmp/y")).toBe(false);
  expect(sameWorkspacePath("/", "/tmp")).toBe(false);
  expect(sameWorkspacePath("C:/Work/", "C:/Workshop")).toBe(false);
  expect(sameWorkspacePath("C:/", "C:/Work")).toBe(false);
});

test("treats tilde paths and expanded paths with a trailing separator as equal", () => {
  expect(sameWorkspacePath("~", normalizeWorkspacePath(homedir()) + "/")).toBe(true);
  expect(sameWorkspacePath("~/", normalizeWorkspacePath(homedir()))).toBe(true);
});
