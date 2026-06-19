import { i18n } from "../i18n";

/** Active BCP-47 locale string for Intl formatters. */
function activeLocale(): string {
  return i18n.global.locale.value;
}

/** Compact local time, e.g. "15:45". Empty string for missing/invalid input. */
export function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });
}

/** Full local date+time. Empty string for missing/invalid input. */
export function fmtDateTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(activeLocale());
}
