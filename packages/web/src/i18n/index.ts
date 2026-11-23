import { createI18n } from "vue-i18n";
import en from "./messages/en";
import zhCN from "./messages/zh-CN";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

/** Map a raw BCP-47 tag (e.g. navigator.language "zh-Hans-CN") to a supported
 *  locale. Anything starting with "zh" → zh-CN; everything else → en. */
export function resolveLocale(tag: string | undefined | null): AppLocale {
  if (tag && tag.toLowerCase().startsWith("zh")) return "zh-CN";
  return "en";
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_LOCALE,
  fallbackLocale: "en",
  messages: { en, "zh-CN": zhCN },
});
