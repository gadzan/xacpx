import { describe, expect, it } from "vitest";
import { baseCompile } from "@intlify/message-compiler";
import { i18n } from "../i18n";
import en from "../i18n/messages/en";
import zhCN from "../i18n/messages/zh-CN";

function messageEntries(catalog: Record<string, unknown>, prefix = ""): Array<{ path: string; text: string }> {
  return Object.entries(catalog).flatMap(([key, value]) =>
    value && typeof value === "object"
      ? messageEntries(value as Record<string, unknown>, `${prefix}${key}.`)
      : [{ path: `${prefix}${key}`, text: String(value) }],
  );
}

describe("i18n message catalogs", () => {
  // vue-i18n reads a bare `@` as linked-message syntax. The production
  // compiler throws on the parse error, which kills the component subtree.
  for (const [locale, catalog] of [["en", en], ["zh-CN", zhCN]] as const) {
    it(`compiles every ${locale} message without a parse error`, () => {
      const messages = messageEntries(catalog);
      expect(messages.map((message) => message.path)).toContain("group.manage.defaultRoutingLeadHint");

      const failures: string[] = [];
      for (const { path, text } of messages) {
        const errors: string[] = [];
        baseCompile(text, { onError: (error) => errors.push(error.message) });
        if (errors.length > 0) failures.push(`${path}: ${errors[0]} in ${JSON.stringify(text)}`);
      }
      expect(failures).toEqual([]);
    });
  }

  it("renders the default-routing hints with a literal @", () => {
    const expected: Record<"en" | "zh-CN", string[]> = {
      en: ["@member", "@everyone"],
      "zh-CN": ["@成员", "@everyone"],
    };
    try {
      for (const locale of ["en", "zh-CN"] as const) {
        i18n.global.locale.value = locale;
        for (const key of ["group.manage.defaultRoutingLeadHint", "group.manage.defaultRoutingAutomaticHint"]) {
          const rendered = i18n.global.t(key);
          for (const fragment of expected[locale]) expect(rendered).toContain(fragment);
          expect(rendered).not.toContain("{'@'}");
        }
      }
    } finally {
      i18n.global.locale.value = "en";
    }
  });
});
