import { expect, test } from "bun:test";

import {
  NO_VERDICT_DISPLAY,
  extractFinalReport,
  formatFinalReport,
  formatStopNotice,
  publishableMemberResult,
} from "../../../src/conversations/final-report";

const PROCESS = [
  "Step 1: opened the file and read 200 lines.",
  "Step 2: tried approach A, hit a race, retried three times.",
  "Step 3: same baseline check repeated four times for no reason.",
].join("\n");

const RAW_WITH_REPORT = [
  PROCESS,
  "",
  "Final report:",
  "Verdict: achieved",
  "Summary: Group member filter is implemented for create mode.",
  "Changes:",
  "- src/bots/bot-service.ts: filter disabled bots on create",
  "Test evidence:",
  "- 28 unit tests passed",
  "Leftovers:",
  "- edit-mode filter not yet done",
  "Blocked attempts:",
  "- none",
].join("\n");

test("extractFinalReport parses a structured report segment out of process output", () => {
  const report = extractFinalReport(RAW_WITH_REPORT);
  expect(report).not.toBeNull();
  expect(report!.verdict).toBe("achieved");
  expect(report!.summary).toBe("Group member filter is implemented for create mode.");
  expect(report!.changes).toEqual(["src/bots/bot-service.ts: filter disabled bots on create"]);
  expect(report!.testEvidence).toEqual(["28 unit tests passed"]);
  expect(report!.leftovers).toEqual(["edit-mode filter not yet done"]);
  expect(report!.blockedAttempts).toEqual(["none"]);
});

test("extractFinalReport returns null without both a verdict and a summary", () => {
  expect(extractFinalReport(PROCESS)).toBeNull();
  expect(extractFinalReport("Final report:\nVerdict: achieved\nChanges:\n- did stuff")).toBeNull();
  expect(extractFinalReport("Final report:\nSummary: did stuff\nChanges:\n- did stuff")).toBeNull();
});

test("formatFinalReport is three paragraphs with a standalone conclusion line", () => {
  const report = extractFinalReport(RAW_WITH_REPORT)!;
  const text = formatFinalReport(report);
  const paragraphs = text.split("\n\n");
  expect(paragraphs).toHaveLength(3);
  expect(paragraphs[0]).toBe("结论：目标已达成 — Group member filter is implemented for create mode.");
  expect(paragraphs[1]).toContain("28 unit tests passed");
  expect(paragraphs[2]).toContain("edit-mode filter not yet done");
  // Process narrative never leaks into the formatted report.
  expect(text.includes("retried three times")).toBe(false);
  expect(text.includes("repeated four times")).toBe(false);
});

test("publishableMemberResult with a report returns only the report, never process text", () => {
  const result = publishableMemberResult(RAW_WITH_REPORT, "completed");
  expect(result.hasReport).toBe(true);
  expect(result.verdict).toBe("achieved");
  expect(result.verdictDisplay).toBe("目标已达成");
  expect(result.turnState).toBe("completed");
  expect(result.text.includes("opened the file")).toBe(false);
});

test("publishableMemberResult without a report returns only a stop notice, not process text", () => {
  const result = publishableMemberResult(PROCESS, "cancelled");
  expect(result.hasReport).toBe(false);
  expect(result.verdict).toBeUndefined();
  expect(result.verdictDisplay).toBe(NO_VERDICT_DISPLAY);
  expect(result.turnState).toBe("cancelled");
  expect(result.text.includes("opened the file")).toBe(false);
  expect(result.text.includes("retried three times")).toBe(false);
  expect(result.text).toContain("无结论");
  expect(result.text).toContain("已被取消");
});

test("verdict and turn state stay separate fields", () => {
  // A turn can end (completed) while the goal was not achieved.
  const notAchieved = publishableMemberResult(
    "Final report:\nVerdict: not-achieved\nSummary: Review found blocking races.\nLeftovers:\n- fix the race",
    "completed",
  );
  expect(notAchieved.turnState).toBe("completed");
  expect(notAchieved.verdict).toBe("not-achieved");
  expect(notAchieved.verdictDisplay).toBe("目标未达成");
  expect(notAchieved.text).not.toContain("已完成");

  // An interrupted report keeps its verdict distinct from a failed state.
  const interrupted = publishableMemberResult(
    "Final report:\nVerdict: interrupted\nSummary: Review stopped mid-way.\nReason: provider session dropped",
    "failed",
  );
  expect(interrupted.turnState).toBe("failed");
  expect(interrupted.verdict).toBe("interrupted");
  expect(interrupted.text).toContain("provider session dropped");
});

test("a missing verdict is labelled 无结论, never implied achieved by completion", () => {
  const result = publishableMemberResult("only process, no report at all", "completed");
  expect(result.verdictDisplay).toBe("无结论");
  expect(result.text).toContain("无结论");
  expect(result.text).not.toContain("目标已达成");
});

test("formatStopNotice never quotes process text, only the short reason given", () => {
  const notice = formatStopNotice("已被取消");
  expect(notice).toContain("已被取消");
  expect(notice).toContain("无结论");
  expect(notice).toContain("下一步");
  expect(notice.includes(PROCESS)).toBe(false);
  expect(formatStopNotice("")).toContain("已停止");
});

test("indeterminate turns without a report get a stop notice, not a verdict", () => {
  const result = publishableMemberResult(PROCESS, "indeterminate");
  expect(result.hasReport).toBe(false);
  expect(result.verdict).toBeUndefined();
  expect(result.text).toContain("结果未证实");
});
