import type { MemberTurnState } from "./conversation-types";
// Chinese protocol strings live in the repo's designated CJK home
// (src/i18n/messages/zh/), not here: the no-hardcoded-cjk test enforces
// that the rest of src/ contains no Han characters.
import {
  FINAL_REPORT_HEADER_LINE_RE,
  FINAL_REPORT_LABELS_ZH,
  NO_VERDICT_DISPLAY_ZH,
  REASON_KEYS_ZH,
  SECTION_KEYS_ZH,
  STOP_NOTICE_ZH,
  SUMMARY_KEYS_ZH,
  TURN_STATE_REASON_ZH,
  VERDICT_DISPLAY_ZH,
  VERDICT_LINE_RE,
  VERDICT_WORDS_ZH,
} from "../i18n/messages/zh/group-final-report";

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

export const NO_VERDICT_DISPLAY = NO_VERDICT_DISPLAY_ZH;

const VERDICT_DISPLAY: Record<FinalReportVerdict, string> = VERDICT_DISPLAY_ZH;

const VERDICT_WORDS: Record<string, FinalReportVerdict> = {
  achieved: "achieved",
  "not-achieved": "not-achieved",
  "not achieved": "not-achieved",
  interrupted: "interrupted",
  ...VERDICT_WORDS_ZH,
};

const SECTION_KEYS: Record<string, keyof Pick<FinalReport, "changes" | "testEvidence" | "leftovers" | "blockedAttempts">> = {
  changes: "changes",
  "test evidence": "testEvidence",
  "tests": "testEvidence",
  leftovers: "leftovers",
  "blocked attempts": "blockedAttempts",
  ...SECTION_KEYS_ZH,
};

function parseVerdict(line: string): FinalReportVerdict | undefined {
  const match = line.match(VERDICT_LINE_RE);
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
    if (FINAL_REPORT_HEADER_LINE_RE.test(line) || parseVerdict(line) !== undefined) {
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
    if (i === start && FINAL_REPORT_HEADER_LINE_RE.test(trimmed)) continue;
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
      if (keyed.key === "summary" || SUMMARY_KEYS_ZH.includes(keyed.key)) {
        summary = keyed.value;
        current = undefined;
        continue;
      }
      if (keyed.key === "reason" || REASON_KEYS_ZH.includes(keyed.key)) {
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
  const labels = FINAL_REPORT_LABELS_ZH;
  const conclusion = `${labels.conclusion}：${VERDICT_DISPLAY[report.verdict]} — ${report.summary}`
    + (report.reason ? `（${labels.reason}：${report.reason}）` : "");
  const evidenceLines = [
    ...report.changes.map((item) => `${labels.change}：${item}`),
    ...report.testEvidence.map((item) => `${labels.test}：${item}`),
  ];
  const evidence = evidenceLines.length > 0
    ? `${labels.evidence}：\n${evidenceLines.join("\n")}`
    : labels.evidenceEmpty;
  const leftoverLines = [
    ...report.leftovers.map((item) => `${labels.leftover}：${item}`),
    ...report.blockedAttempts.map((item) => `${labels.blocked}：${item}`),
  ];
  const leftovers = leftoverLines.length > 0
    ? `${labels.leftovers}：\n${leftoverLines.join("\n")}`
    : labels.leftoversEmpty;
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
  const why = trimmed ? `${FINAL_REPORT_LABELS_ZH.reason}：${trimmed}。` : "";
  return `${STOP_NOTICE_ZH.stopped}${why}${STOP_NOTICE_ZH.noConclusion}`;
}

function stopReasonForState(turnState: MemberTurnState): string {
  return TURN_STATE_REASON_ZH[turnState] ?? TURN_STATE_REASON_ZH.default!;
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
