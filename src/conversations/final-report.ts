import type { MemberTurnState } from "./conversation-types";

/**
 * Structured final report: the ONLY thing a Group member's conclusion may
 * put on the main timeline (see publishableMemberResult below).
 *
 * Presentation rule, not a storage rule: this module is pure and never
 * deletes, truncates, or rewrites a member's raw output. The raw output
 * stays whole in the record the store already keeps — the `role='bot'`
 * message row inserted by `completeExecution` in
 * `sqlite-conversation-store.ts`, which is what the execution-detail view
 * reads. A caller that publishes this module's text must keep that row;
 * publishing the report is a projection of the raw output, never a
 * replacement for it.
 *
 * Verdict and turn state are separate fields everywhere this module is
 * used: a turn can be `completed` while its verdict is `not-achieved` (the
 * work ended, the goal did not), and a `cancelled`/`failed` turn has no
 * verdict at all. Never render a turn state as if it were a verdict.
 */

/** Goal verdict carried by a structured report. Distinct from MemberTurnState. */
export type FinalReportVerdict = "achieved" | "not-achieved" | "interrupted";

export interface FinalReport {
  verdict: FinalReportVerdict;
  /** First line must stand alone: it is the conclusion a reader sees first. */
  summary: string;
  /** What changed: files, branch, PR, if any. */
  changes: string[];
  /** Tests run and their outcomes, including excluded baseline failures. */
  testEvidence: string[];
  /** Known limitations, unverified items, next steps. */
  leftovers: string[];
  /** Methods already tried against a blocker, with evidence — not just "failed". */
  blockedAttempts: string[];
  /** Why the verdict is what it is; required reading for `interrupted`. */
  reason?: string;
}

/** What the timeline may show for one member turn. */
export interface PublishableMemberResult {
  /** Text safe for the main timeline: a formatted report, or a short stop
   *  notice. It never contains the member's process narrative. */
  text: string;
  /** Goal verdict, when the member supplied a structured report. Absent
   *  means the card must say "无结论" — never "已完成" as a verdict. */
  verdict?: FinalReportVerdict;
  /** Display word for the verdict column, kept separate from `turnState`. */
  verdictDisplay: string;
  /** The durable turn state, carried through untouched for the state column. */
  turnState: MemberTurnState;
  /** True only when `text` is a formatted structured report. */
  hasReport: boolean;
}

export const NO_VERDICT_DISPLAY = "无结论";

const VERDICT_DISPLAY: Record<FinalReportVerdict, string> = {
  achieved: "目标已达成",
  "not-achieved": "目标未达成",
  interrupted: "已中断",
};

const VERDICT_WORDS: Record<string, FinalReportVerdict> = {
  achieved: "achieved",
  "not-achieved": "not-achieved",
  "not achieved": "not-achieved",
  interrupted: "interrupted",
  "目标已达成": "achieved",
  "达成": "achieved",
  "目标未达成": "not-achieved",
  "未达成": "not-achieved",
  "已中断": "interrupted",
  "中断": "interrupted",
};

const SECTION_KEYS: Record<string, keyof Pick<FinalReport, "changes" | "testEvidence" | "leftovers" | "blockedAttempts">> = {
  changes: "changes",
  "改动": "changes",
  "test evidence": "testEvidence",
  "tests": "testEvidence",
  "测试证据": "testEvidence",
  leftovers: "leftovers",
  "剩余项": "leftovers",
  "blocked attempts": "blockedAttempts",
  "尝试过的阻塞": "blockedAttempts",
  "阻塞尝试": "blockedAttempts",
};

function parseVerdict(line: string): FinalReportVerdict | undefined {
  const match = line.match(/^\s*(?:verdict|裁决)\s*[:：]\s*(.+?)\s*$/i);
  if (!match) return undefined;
  return VERDICT_WORDS[match[1]!.trim().toLowerCase()];
}

function parseKeyedLine(line: string): { key: string; value: string } | undefined {
  const match = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.+?)\s*$/);
  if (!match) return undefined;
  return { key: match[1]!.trim().toLowerCase(), value: match[2]!.trim() };
}

function isBullet(line: string): string | undefined {
  const match = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/);
  return match?.[1];
}

/**
 * Extract a structured report from raw member output, or null when the
 * output carries no complete structured report segment. A segment starts at
 * a `Final report` / `最终报告` header line or at its `Verdict:` line, and
 * is parsed to the end of the output. It is complete only when it has both
 * a verdict and a summary; anything else is not a report, and the caller
 * must fall back to a stop notice rather than guess one from process text.
 */
export function extractFinalReport(raw: string): FinalReport | null {
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^(final report|最终报告)\s*[:：]?\s*$/i.test(line) || parseVerdict(line) !== undefined) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let verdict: FinalReportVerdict | undefined;
  let verdictAt = -1;
  let summary = "";
  let reason: string | undefined;
  const changes: string[] = [];
  const testEvidence: string[] = [];
  const leftovers: string[] = [];
  const blockedAttempts: string[] = [];
  const lists: Record<string, string[]> = { changes, testEvidence, leftovers, blockedAttempts };
  let current: string[] | undefined;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) { current = undefined; continue; }
    if (i === start && /^(final report|最终报告)\s*[:：]?\s*$/i.test(trimmed)) continue;
    const verdictValue = parseVerdict(line);
    if (verdictValue !== undefined) { verdict = verdictValue; verdictAt = i; current = undefined; continue; }
    // A bullet is a list item even when it contains a colon (e.g. a file
    // path followed by a description); it must never be re-read as a
    // `Key: value` line. Outside a list it is ignored, not promoted.
    const bulletLine = isBullet(line);
    if (bulletLine !== undefined) {
      if (current) current.push(bulletLine);
      continue;
    }
    // A bare section header (`Changes:` with no value on the line) opens
    // its list; without this it would be swallowed as a bare summary line.
    const bareSection = SECTION_KEYS[line.trim().replace(/[:：]\s*$/, "").toLowerCase()];
    if (bareSection) {
      const list = lists[bareSection];
      if (list) current = list;
      continue;
    }
    const keyed = parseKeyedLine(line);
    if (keyed) {
      if (keyed.key === "summary" || keyed.key === "结论" || keyed.key === "摘要") {
        summary = keyed.value;
        current = undefined;
        continue;
      }
      if (keyed.key === "reason" || keyed.key === "原因") {
        reason = keyed.value;
        current = undefined;
        continue;
      }
      const section = SECTION_KEYS[keyed.key];
      if (section) {
        const list = lists[section];
        if (list) {
          current = list;
          if (keyed.value) list.push(keyed.value);
        }
        continue;
      }
      // An unrecognised `Key: value` line inside the segment is not a
      // section and not a list item: it ends the current list, and is
      // otherwise ignored rather than smuggled into the report.
      current = undefined;
      continue;
    }
    if (!summary && current === undefined && verdict !== undefined && verdictAt >= 0
      && lines.slice(verdictAt + 1, i).every((prior) => !prior.trim())) {
      // A bare line immediately after the verdict, before any section, is
      // the summary — but only one line: the summary must stand alone.
      // Anything later is process narrative and is ignored, never guessed
      // into the summary.
      summary = trimmed;
      continue;
    }
    // Any other line (process narrative inside the segment) is ignored:
    // the report is built only from its structured fields.
  }

  if (verdict === undefined || !summary) return null;
  return {
    verdict,
    summary,
    changes,
    testEvidence,
    leftovers,
    blockedAttempts,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Format a structured report as three human paragraphs: conclusion line,
 * evidence paragraph, leftovers paragraph. The summary is the conclusion
 * line's whole claim, so it reads alone without the rest.
 */
export function formatFinalReport(report: FinalReport): string {
  const conclusion = `结论：${VERDICT_DISPLAY[report.verdict]} — ${report.summary}`
    + (report.reason ? `（原因：${report.reason}）` : "");
  const evidenceLines = [
    ...report.changes.map((item) => `改动：${item}`),
    ...report.testEvidence.map((item) => `测试：${item}`),
  ];
  const evidence = evidenceLines.length > 0
    ? `证据：\n${evidenceLines.join("\n")}`
    : "证据：本次未记录改动与测试证据。";
  const leftoverLines = [
    ...report.leftovers.map((item) => `剩余：${item}`),
    ...report.blockedAttempts.map((item) => `已尝试但受阻：${item}`),
  ];
  const leftovers = leftoverLines.length > 0
    ? `剩余项：\n${leftoverLines.join("\n")}`
    : "剩余项：无。";
  return `${conclusion}\n\n${evidence}\n\n${leftovers}`;
}

/**
 * Short stop notice for a turn with no structured report: reason, no
 * conclusion, next step — and nothing else. `reason` is a short reason
 * string supplied by the caller (turn state or failure reason); the raw
 * process output is never passed here and never quoted.
 */
export function formatStopNotice(reason: string): string {
  const trimmed = reason.trim();
  const why = trimmed ? `原因：${trimmed}。` : "";
  return `已停止。${why}本次无结论。下一步：请重新派发，或由负责人汇总后升级给用户。`;
}

function stopReasonForState(turnState: MemberTurnState): string {
  switch (turnState) {
    case "failed": return "执行失败";
    case "cancelled": return "已被取消";
    case "indeterminate": return "结果未证实";
    case "completed": return "已结束但未给出结构化结论";
    default: return "未结束";
  }
}

/**
 * The single presentation rule for a member turn's timeline text. A turn
 * with a structured report publishes only the formatted report; a turn
 * without one publishes only a stop notice — never process text, never a
 * truncation of it. The turn state travels in its own field, so a reader
 * can never mistake "completed" for "goal achieved".
 */
export function publishableMemberResult(raw: string, turnState: MemberTurnState): PublishableMemberResult {
  const report = extractFinalReport(raw);
  if (report) {
    return {
      text: formatFinalReport(report),
      verdict: report.verdict,
      verdictDisplay: VERDICT_DISPLAY[report.verdict],
      turnState,
      hasReport: true,
    };
  }
  return {
    text: formatStopNotice(stopReasonForState(turnState)),
    verdictDisplay: NO_VERDICT_DISPLAY,
    turnState,
    hasReport: false,
  };
}
