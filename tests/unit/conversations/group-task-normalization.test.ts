import { expect, test } from "bun:test";
import { normalizeGroupTaskText } from "../../../src/conversations/group-task-normalization";

test("normalizeGroupTaskText collapses whitespace and trims", () => {
  expect(normalizeGroupTaskText("  same   task  ")).toBe("same task");
  expect(normalizeGroupTaskText("same\ttask")).toBe("same task");
  expect(normalizeGroupTaskText("same\r\n\ntask")).toBe("same task");
  // Full-width space is whitespace too, not a character to keep.
  expect(normalizeGroupTaskText("same\u3000task")).toBe("same task");
});

test("normalizeGroupTaskText applies NFKC so full-width maps to half-width", () => {
  expect(normalizeGroupTaskText("ＦＩＸ　ｔｈｅ　ｌｏｇｉｎ　ｂｕｇ")).toBe("fix the login bug");
  // Full-width comma normalizes to a half-width comma; middle content stays.
  expect(normalizeGroupTaskText("task，done")).toBe("task,done");
});

test("normalizeGroupTaskText lowercases", () => {
  expect(normalizeGroupTaskText("Fix The LOGIN Bug")).toBe("fix the login bug");
  expect(normalizeGroupTaskText("修复 LOGIN")).toBe("修复 login");
});

test("normalizeGroupTaskText strips leading and trailing punctuation", () => {
  expect(normalizeGroupTaskText("...same task...")).toBe("same task");
  expect(normalizeGroupTaskText("。同一个任务。")).toBe("同一个任务");
  expect(normalizeGroupTaskText("!! same task ??")).toBe("same task");
  expect(normalizeGroupTaskText("：same task；")).toBe("same task");
  expect(normalizeGroupTaskText("same task,")).toBe("same task");
  // Only the edges: punctuation inside the task is task text.
  expect(normalizeGroupTaskText("fix bug #12, then retest")).toBe("fix bug #12, then retest");
  // Symbols are not punctuation and survive at the edges.
  expect(normalizeGroupTaskText("port C++")).toBe("port c++");
});

test("normalizeGroupTaskText keeps different middle content different", () => {
  expect(normalizeGroupTaskText("implement login")).not.toBe(normalizeGroupTaskText("implement login page"));
  expect(normalizeGroupTaskText("run the tests")).not.toBe(normalizeGroupTaskText("run the tests twice"));
});

test("normalizeGroupTaskText empties whitespace-only and punctuation-only text", () => {
  expect(normalizeGroupTaskText("   ")).toBe("");
  expect(normalizeGroupTaskText("\u3000\t\n ")).toBe("");
  expect(normalizeGroupTaskText("...。！？")).toBe("");
});

test("normalizeGroupTaskText is idempotent", () => {
  const once = normalizeGroupTaskText("  ＦＩＸ   the login bug...  ");
  expect(normalizeGroupTaskText(once)).toBe(once);
});
