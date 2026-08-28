import { getLocale } from "xacpx/plugin-api";
import type { Locale } from "xacpx/plugin-api";
import type { DiscordMessages } from "./messages.js";
import { en } from "./en.js";
import { zh } from "./zh.js";

export type { DiscordMessages } from "./messages.js";

let active: Locale | null = null;

export function setChannelLocale(locale: Locale): void {
  active = locale;
}

export function t(): DiscordMessages {
  return (active ?? getLocale()) === "zh" ? zh : en;
}
