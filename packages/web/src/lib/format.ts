import { i18n } from "../i18n";

/** Active BCP-47 locale string for Intl formatters. */
function activeLocale(): string {
  return i18n.global.locale.value;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** Start of the local day containing `at`. */
function startOfLocalDay(at: Date): Date {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day;
}

/**
 * Message timestamp: localized relative age while fresh, exact local time
 * afterwards. Under 60s shows just-now; 1-4 minutes show a minute count;
 * after 5 minutes the local clock time; other local days add month-day;
 * other years show yyyy-MM-dd without a clock. Empty string for missing/invalid input.
 */
export function fmtTime(iso?: string | number): string {
  if (iso === undefined || iso === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date(Date.now());
  const ageMs = now.getTime() - d.getTime();
  if (ageMs >= 0 && ageMs < 60 * SECOND_MS) return i18n.global.t("time.justNow");
  if (ageMs >= 0 && ageMs < 5 * MINUTE_MS) {
    const minutes = Math.floor(ageMs / MINUTE_MS);
    return i18n.global.t("time.minutesAgo", { count: minutes });
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (startOfLocalDay(d).getTime() === startOfLocalDay(now).getTime()) return clock;
  const day = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (d.getFullYear() === now.getFullYear()) return `${day} ${clock}`;
  return `${d.getFullYear()}-${day}`;
}

/** Full local date+time. Empty string for missing/invalid input. */
export function fmtDateTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(activeLocale());
}

