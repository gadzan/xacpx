/** A name edge that reads as Latin text: an ASCII letter or digit. */
const LATIN_EDGE = /[A-Za-z0-9]/;

/** Which side of the name touches CJK text in the template. */
export type CjkNameSide = "before" | "after";

/**
 * Spaces a bot name for a zh-CN template that writes `{name}` flush against
 * Chinese text. A name whose touching edge is a Latin letter or digit gets a
 * space on that side ("派发给 Tester", "Lead 和…"); a name that starts or ends
 * in Chinese stays flush ("停止项管"). Other locales already space their
 * templates, so their names pass through unchanged.
 */
export function spaceNameForCjk(name: string, locale: string, side: CjkNameSide): string {
  if (!locale.startsWith("zh") || name === "") return name;
  if (side === "before") return LATIN_EDGE.test(name[0]!) ? ` ${name}` : name;
  return LATIN_EDGE.test(name[name.length - 1]!) ? `${name} ` : name;
}
