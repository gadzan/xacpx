import { ZH_ABORT_TRIGGER_WORDS } from "./i18n/zh.js";

const BASE_ABORT_TRIGGERS = new Set([
  "stop",
  "abort",
  "interrupt",
  "stop weacpx",
  "weacpx stop",
  "stop xacpx",
  "xacpx stop",
  "stop action",
  "stop current action",
  "stop run",
  "stop current run",
  "stop agent",
  "stop the agent",
  "please stop",
  "stop please",
]);

const TRAILING_ABORT_PUNCTUATION_RE = /[.!?…,，。;；:：'"'")\]}]+$/u;

function normalizeAbortTriggerText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/['`]/g, "'")
    .replace(/\s+/g, " ")
    .replace(TRAILING_ABORT_PUNCTUATION_RE, "")
    .trim();
}

export function isAbortTrigger(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeAbortTriggerText(text);
  if (BASE_ABORT_TRIGGERS.has(normalized)) return true;
  return ZH_ABORT_TRIGGER_WORDS.has(normalized);
}

export function isLikelyAbortText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/stop" || trimmed === "/abort" || trimmed === "/cancel") return true;
  return isAbortTrigger(trimmed);
}
