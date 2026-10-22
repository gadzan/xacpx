import { expect, test } from "bun:test";
import {
  allocateWorkspaceName,
  isWorkspaceNameValid,
  quoteWorkspaceNameIfNeeded,
  sanitizeWorkspaceName,
} from "../../../src/commands/workspace-name";

test("sanitizeWorkspaceName keeps clean ASCII names", () => {
  expect(sanitizeWorkspaceName("backend")).toBe("backend");
  expect(sanitizeWorkspaceName("api.v2")).toBe("api.v2");
  expect(sanitizeWorkspaceName("my_repo-1")).toBe("my_repo-1");
});

test("sanitizeWorkspaceName replaces whitespace and unsafe runs with single dash", () => {
  expect(sanitizeWorkspaceName("My Project")).toBe("My-Project");
  expect(sanitizeWorkspaceName("foo  bar")).toBe("foo-bar");
  expect(sanitizeWorkspaceName("foo/bar baz")).toBe("foo-bar-baz");
});

test("sanitizeWorkspaceName trims leading and trailing dashes", () => {
  expect(sanitizeWorkspaceName("  spaced  ")).toBe("spaced");
  expect(sanitizeWorkspaceName("--weird--")).toBe("weird");
});

test("sanitizeWorkspaceName maps an all-CJK name to a valid opaque workspace name", () => {
  expect(sanitizeWorkspaceName("测试项目")).toBe("workspace-309d13f6");
  expect(isWorkspaceNameValid(sanitizeWorkspaceName("测试项目"))).toBe(true);
});

test("sanitizeWorkspaceName maps different all-CJK names to different workspace names", () => {
  expect(sanitizeWorkspaceName("项目")).toBe("workspace-695778ee");
  expect(sanitizeWorkspaceName("测试项目")).not.toBe(sanitizeWorkspaceName("项目"));
});

test("sanitizeWorkspaceName maps a symbols-only name to a valid opaque workspace name", () => {
  expect(sanitizeWorkspaceName("!!!")).toBe("workspace-2d53a722");
  expect(isWorkspaceNameValid(sanitizeWorkspaceName("!!!"))).toBe(true);
});

test("sanitizeWorkspaceName ignores surrounding whitespace when hashing opaque names", () => {
  expect(sanitizeWorkspaceName("  测试项目  ")).toBe("workspace-309d13f6");
  expect(sanitizeWorkspaceName("\t测试项目\n")).toBe("workspace-309d13f6");
});

test("sanitizeWorkspaceName keeps the static fallback for blank input", () => {
  expect(sanitizeWorkspaceName("")).toBe("workspace");
  expect(sanitizeWorkspaceName("   ")).toBe("workspace");
  expect(sanitizeWorkspaceName("", "fallback")).toBe("fallback");
});

test("sanitizeWorkspaceName uses a sanitized custom fallback for opaque names", () => {
  expect(sanitizeWorkspaceName("中文", "My Fallback_")).toBe("My-Fallback_-5132b5ad");
  expect(sanitizeWorkspaceName("中文", "!!!")).toBe("workspace-5132b5ad");
});

test("sanitizeWorkspaceName keeps the ASCII part of a mixed CJK name", () => {
  expect(sanitizeWorkspaceName("中文-API_v2.0-项目")).toBe("API_v2.0");
  expect(sanitizeWorkspaceName("api v2 中文")).toBe("api-v2");
});

test("sanitizeWorkspaceName ignores custom fallback when input survives sanitization", () => {
  expect(sanitizeWorkspaceName("backend", "other")).toBe("backend");
  expect(sanitizeWorkspaceName("My Project", "other")).toBe("My-Project");
});

test("allocateWorkspaceName returns base when free, appends suffix when taken", () => {
  expect(allocateWorkspaceName("backend", {})).toBe("backend");
  expect(allocateWorkspaceName("backend", { backend: 1 })).toBe("backend-2");
  expect(allocateWorkspaceName("backend", { backend: 1, "backend-2": 1 })).toBe(
    "backend-3",
  );
});

test("allocateWorkspaceName disambiguates two opaque names that share a base", () => {
  const existing = { "workspace-309d13f6": { cwd: "/tmp/a" } };
  expect(allocateWorkspaceName("workspace-309d13f6", existing)).toBe("workspace-309d13f6-2");
  expect(allocateWorkspaceName("workspace-695778ee", existing)).toBe("workspace-695778ee");
});

test("isWorkspaceNameValid matches the sanitize alphabet", () => {
  expect(isWorkspaceNameValid("backend")).toBe(true);
  expect(isWorkspaceNameValid("api.v2_3-final")).toBe(true);
  expect(isWorkspaceNameValid("")).toBe(false);
  expect(isWorkspaceNameValid("My Project")).toBe(false);
  expect(isWorkspaceNameValid("中文")).toBe(false);
  expect(isWorkspaceNameValid("foo/bar")).toBe(false);
});

test("quoteWorkspaceNameIfNeeded wraps names with unsafe characters", () => {
  expect(quoteWorkspaceNameIfNeeded("backend")).toBe("backend");
  expect(quoteWorkspaceNameIfNeeded("api.v2_3-final")).toBe("api.v2_3-final");
  expect(quoteWorkspaceNameIfNeeded("My Project")).toBe('"My Project"');
  expect(quoteWorkspaceNameIfNeeded("中文")).toBe('"中文"');
  expect(quoteWorkspaceNameIfNeeded('say"hi')).toBe('"say\\"hi"');
  expect(quoteWorkspaceNameIfNeeded("a\\b")).toBe('"a\\\\b"');
});
