// Group final-report protocol strings, in Chinese.
//
// This is the repo's designated home for CJK literals: the
// `no-hardcoded-cjk` test enforces that the rest of `src/` contains no Han
// characters, and explicitly exempts `src/i18n/messages/zh/`. These strings
// are NOT UI copy waiting for a locale switch — they are the wire format of
// the structured final report itself:
//  - member bots write their report in Chinese (the group's working
//    language), so the parser must recognise Chinese verdict words, section
//    keys and header lines;
//  - the timeline renders the formatted report in Chinese, so the display
//    words and the prompt example live here too.
// Keeping them in one file keeps the parser, the formatter and the prompt
// example in agreement; do not duplicate a Chinese word in
// `src/conversations/` — import it from here.

import type { FinalReportVerdict } from "../../../conversations/final-report";

/** Display word for the verdict column when a turn supplied no report. */
export const NO_VERDICT_DISPLAY_ZH = "无结论";

/** Display word for each verdict, used on the main timeline. */
export const VERDICT_DISPLAY_ZH: Record<FinalReportVerdict, string> = {
  achieved: "目标已达成",
  "not-achieved": "目标未达成",
  interrupted: "已中断",
};

/** Chinese verdict words a member bot may write, mapped to the verdict. */
export const VERDICT_WORDS_ZH: Record<string, FinalReportVerdict> = {
  "目标已达成": "achieved",
  "达成": "achieved",
  "目标未达成": "not-achieved",
  "未达成": "not-achieved",
  "已中断": "interrupted",
  "中断": "interrupted",
};

/** Chinese section keys, mapped to the report field they open. */
export const SECTION_KEYS_ZH: Record<string, "changes" | "testEvidence" | "leftovers" | "blockedAttempts"> = {
  "改动": "changes",
  "测试证据": "testEvidence",
  "剩余项": "leftovers",
  "尝试过的阻塞": "blockedAttempts",
  "阻塞尝试": "blockedAttempts",
};

/** Chinese keys for the summary line inside a report segment. */
export const SUMMARY_KEYS_ZH = ["结论", "摘要"];

/** Chinese keys for the reason line inside a report segment. */
export const REASON_KEYS_ZH = ["原因"];

/** A line that opens a structured report segment (Chinese header). */
export const FINAL_REPORT_HEADER_LINE_RE = /^(final report|最终报告)\s*[:：]?\s*$/i;

/** A verdict line, e.g. `裁决：目标已达成`. */
export const VERDICT_LINE_RE = /^\s*(?:verdict|裁决)\s*[:：]\s*(.+?)\s*$/i;

/** Labels used when formatting a structured report for the timeline. */
export const FINAL_REPORT_LABELS_ZH = {
  conclusion: "结论",
  reason: "原因",
  change: "改动",
  test: "测试",
  evidence: "证据",
  evidenceEmpty: "证据：本次未记录改动与测试证据。",
  leftover: "剩余",
  blocked: "已尝试但受阻",
  leftovers: "剩余项",
  leftoversEmpty: "剩余项：无。",
} as const;

/** Stop notice for a turn with no structured report. */
export const STOP_NOTICE_ZH = {
  stopped: "已停止。",
  noConclusion: "本次无结论。下一步：请重新派发，或由负责人汇总后升级给用户。",
} as const;

/** Reason words for each turn state, used in the stop notice. */
export const TURN_STATE_REASON_ZH: Record<string, string> = {
  failed: "执行失败",
  cancelled: "已被取消",
  indeterminate: "结果未证实",
  completed: "已结束但未给出结构化结论",
  default: "未结束",
};

/**
 * The example report block the member prompt shows bots. It must stay in
 * sync with the parser above: verdict word, header and section keys here
 * are exactly the words the parser recognises.
 */
export const FINAL_REPORT_PROMPT_EXAMPLE_ZH = [
  "最终报告：",
  "裁决：目标已达成",
  "结论：<one sentence that stands alone>",
  "改动：",
  "- <file, branch, or PR>",
  "测试证据：",
  "- <tests run and their outcomes>",
  "剩余项：",
  "- <known limitations, unverified items, next steps>",
  "尝试过的阻塞：",
  "- <methods tried against a blocker, with evidence>",
].join("\n");
