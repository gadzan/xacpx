import { describe, expect, it } from "vitest";
// Plain Node ESM codemod; intentionally outside the TS program (no allowJs).
// @ts-expect-error - untyped .mjs module
import { transformType } from "../../scripts/codemod-type.mjs";

// Vue SFC template and script/style sections (default ".vue" mode).
const vueCases: Array<[string, string]> = [
  // Static class attributes, one per scale tier.
  ['<div class="text-[9px]"></div>', '<div class="text-xs"></div>'],
  ['<div class="text-[9.5px]"></div>', '<div class="text-xs"></div>'],
  ['<div class="text-[10px]"></div>', '<div class="text-xs"></div>'],
  ['<div class="text-[10.5px]"></div>', '<div class="text-xs"></div>'],
  ['<div class="text-[11px]"></div>', '<div class="text-xs"></div>'],
  ['<div class="text-[11.5px]"></div>', '<div class="text-xs"></div>'],
  ['<div class="text-[12px]"></div>', '<div class="text-ui"></div>'],
  ['<div class="text-[12.5px]"></div>', '<div class="text-ui"></div>'],
  ['<div class="text-[13px]"></div>', '<div class="text-ui"></div>'],
  ['<div class="text-[13.5px]"></div>', '<div class="text-sm"></div>'],
  ['<div class="text-[14px]"></div>', '<div class="text-sm"></div>'],
  ['<div class="text-[15px]"></div>', '<div class="text-base"></div>'],
  ['<div class="text-[16px]"></div>', '<div class="text-base"></div>'],
  // Several sizes in one attribute, with neighbours kept.
  [
    '<div class="flex items-center gap-1 text-[11px] font-medium text-fg-muted"></div>',
    '<div class="flex items-center gap-1 text-xs font-medium text-fg-muted"></div>',
  ],
  // Variant prefixes.
  ['<i class="hover:text-[10px]"></i>', '<i class="hover:text-xs"></i>'],
  ['<i class="lg:text-[14px]"></i>', '<i class="lg:text-sm"></i>'],
  ['<i class="max-md:text-[12px]"></i>', '<i class="max-md:text-ui"></i>'],
  ['<i class="focus-visible:text-[13px]"></i>', '<i class="focus-visible:text-ui"></i>'],
  // Stacked prefixes.
  ['<i class="dark:hover:text-[11.5px]"></i>', '<i class="dark:hover:text-xs"></i>'],
  ['<i class="group-hover:text-[16px]"></i>', '<i class="group-hover:text-base"></i>'],
  ['<i class="[&>svg]:text-[12px]"></i>', '<i class="[&>svg]:text-ui"></i>'],
  // Important prefix.
  ['<i class="!text-[10px]"></i>', '<i class="!text-xs"></i>'],
  // Bound class expressions.
  [
    '<button :class="cond ? \'text-[16px]\' : \'text-[14px]\'"></button>',
    '<button :class="cond ? \'text-base\' : \'text-sm\'"></button>',
  ],
  [
    '<button :class="[\'text-[12px]\', cond ? \'text-[13px]\' : \'text-ui\']"></button>',
    '<button :class="[\'text-ui\', cond ? \'text-ui\' : \'text-ui\']"></button>',
  ],
  ['<span :class="{ \'text-[11px]\': ok }"></span>', '<span :class="{ \'text-xs\': ok }"></span>'],
  // Bare-token boundaries: only exact source tokens are mapped.
  ['<i class="text-xs"></i>', '<i class="text-xs"></i>'],
  ['<i class="text-ui"></i>', '<i class="text-ui"></i>'],
  ['<i class="text-sm"></i>', '<i class="text-sm"></i>'],
  ['<i class="text-base"></i>', '<i class="text-base"></i>'],
  ['<i class="text-lg"></i>', '<i class="text-lg"></i>'],
  ['<i class="text-xl"></i>', '<i class="text-xl"></i>'],
  ['<i class="textX"></i>', '<i class="textX"></i>'],
  ['<i class="a-text-[10px]"></i>', '<i class="a-text-[10px]"></i>'],
  ['<i class="text-[10px]X"></i>', '<i class="text-[10px]X"></i>'],
  ['<i class="text-sm/50"></i>', '<i class="text-sm/50"></i>'],
  // Not font sizes: colors and keyword forms keep their arbitrary value.
  ['<i class="text-[#fff]"></i>', '<i class="text-[#fff]"></i>'],
  ['<i class="text-[length:14px]"></i>', '<i class="text-[length:14px]"></i>'],
  // Unknown sizes are left for the run report, never guessed at.
  ['<i class="text-[8px]"></i>', '<i class="text-[8px]"></i>'],
  ['<i class="text-[17px]"></i>', '<i class="text-[17px]"></i>'],
  ['<i class="text-[10.25px]"></i>', '<i class="text-[10.25px]"></i>'],
  ['<i class="text-[1rem]"></i>', '<i class="text-[1rem]"></i>'],
  // Comments and prose keep the source word.
  ['<!-- text-[10px] -->', '<!-- text-[10px] -->'],
  ['<div class="text-[10px]"></div> <!-- text-[11px] -->', '<div class="text-xs"></div> <!-- text-[11px] -->'],
  [
    "<script>\n// text-[12px]\nconst cls = \"text-[13px]\";\n</script>\n<style>\n/* text-[14px] */\n.a { font-size: 12.5px; }\n</style>\n<template><div class=\"text-[15px]\"></div></template>",
    "<script>\n// text-[12px]\nconst cls = \"text-ui\";\n</script>\n<style>\n/* text-[14px] */\n.a { font-size: 12.5px; }\n</style>\n<template><div class=\"text-base\"></div></template>",
  ],
  // Template text nodes are prose, not classes.
  ["<p>text-[10px] stays</p>", "<p>text-[10px] stays</p>"],
];

// Plain TS/JS/TSX sources start in code mode: string and template literals are
// class contexts; comments and unquoted code (identifiers, regexes) are not.
const codeCases: Array<[string, string]> = [
  ['const cls = "text-[11px]";', 'const cls = "text-xs";'],
  ["const cls = 'text-[13px]';", "const cls = 'text-ui';"],
  ["const cls = `text-[14px] ${x}`;", "const cls = `text-sm ${x}`;"],
  ['const cls = cond ? "text-[16px]" : "text-[12px]";', 'const cls = cond ? "text-base" : "text-ui";'],
  ['const map = { "text-[10px]": 1 };', 'const map = { "text-xs": 1 };'],
  ['const list = ["text-[9px]", "text-[15px]"];', 'const list = ["text-xs", "text-base"];'],
  ["// text-[12px] stays in a comment", "// text-[12px] stays in a comment"],
  ["/* text-[14px] stays */", "/* text-[14px] stays */"],
  ["const re = /text-\\[10px\\]/;", "const re = /text-\\[10px\\]/;"],
  ["const n = 5; // text-[11px]", "const n = 5; // text-[11px]"],
  ["const s = 'a \\' text-[10px]';", "const s = 'a \\' text-xs';"],
  ["const textSizes = 1;", "const textSizes = 1;"],
];

describe("codemod-type transformType (Vue SFC mode)", () => {
  it.each(vueCases)("transforms %j", (input, expected) => {
    expect(transformType(input)).toBe(expected);
  });
});

describe("codemod-type transformType (code mode)", () => {
  it.each(codeCases)("transforms %j", (input, expected) => {
    expect(transformType(input, ".ts")).toBe(expected);
  });
});

describe("codemod-type idempotency", () => {
  it("maps every fixture to a fixed point", () => {
    for (const [input, expected] of vueCases) {
      expect(transformType(expected)).toBe(expected);
      expect(transformType(transformType(input))).toBe(expected);
    }
    for (const [input, expected] of codeCases) {
      expect(transformType(expected, ".ts")).toBe(expected);
      expect(transformType(transformType(input, ".ts"), ".ts")).toBe(expected);
    }
  });
});
