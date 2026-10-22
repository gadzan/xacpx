import { expect, test } from "bun:test";
import { stableHash8, workspaceNameFallback } from "../../../../packages/relay-protocol/src/index";

test("stableHash8 returns the documented 8 hex digits", () => {
  expect(stableHash8("测试项目")).toBe("309d13f6");
  expect(stableHash8("项目")).toBe("695778ee");
  expect(stableHash8("")).toBe("811c9dc5");
});

test("workspaceNameFallback derives an opaque name from the trimmed input", () => {
  expect(workspaceNameFallback("测试项目")).toBe("workspace-309d13f6");
  expect(workspaceNameFallback("  测试项目  ")).toBe("workspace-309d13f6");
});

test("workspaceNameFallback keeps a sanitized custom prefix", () => {
  expect(workspaceNameFallback("测试项目", "My Fallback_")).toBe("My-Fallback_-309d13f6");
  expect(workspaceNameFallback("测试项目", "!!!")).toBe("workspace-309d13f6");
});
