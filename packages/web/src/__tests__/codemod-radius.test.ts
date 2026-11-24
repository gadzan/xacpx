import { describe, expect, it } from "vitest";
// Plain Node ESM codemod; intentionally outside the TS program (no allowJs).
// @ts-expect-error - untyped .mjs module
import { transformRadius } from "../../scripts/codemod-radius.mjs";

// Vue SFC template and script/style sections (default ".vue" mode).
const vueCases: Array<[string, string]> = [
  // Static class attributes.
  ['<div class="flex rounded p-2"></div>', '<div class="flex rounded-sm p-2"></div>'],
  ['<div class="rounded-md"></div>', '<div class="rounded-sm"></div>'],
  ['<div class="rounded-xl"></div>', '<div class="rounded-2xl"></div>'],
  ['<div class="rounded-3xl"></div>', '<div class="rounded-2xl"></div>'],
  // Variant prefixes.
  ['<i class="hover:rounded-md"></i>', '<i class="hover:rounded-sm"></i>'],
  ['<i class="md:rounded"></i>', '<i class="md:rounded-sm"></i>'],
  ['<i class="focus-visible:rounded-xl"></i>', '<i class="focus-visible:rounded-2xl"></i>'],
  ['<i class="lg:rounded-t-md"></i>', '<i class="lg:rounded-t-sm"></i>'],
  // Stacked prefixes.
  ['<i class="dark:hover:rounded-xl"></i>', '<i class="dark:hover:rounded-2xl"></i>'],
  ['<i class="group-hover:rounded"></i>', '<i class="group-hover:rounded-sm"></i>'],
  // Important prefix.
  ['<i class="!rounded-md"></i>', '<i class="!rounded-sm"></i>'],
  // Bound class expressions.
  [
    '<button :class="cond ? \'rounded-xl\' : \'rounded-lg\'"></button>',
    '<button :class="cond ? \'rounded-2xl\' : \'rounded-lg\'"></button>',
  ],
  [
    '<button :class="[\'rounded\', cond ? \'rounded-xl\' : \'rounded-lg\']"></button>',
    '<button :class="[\'rounded-sm\', cond ? \'rounded-2xl\' : \'rounded-lg\']"></button>',
  ],
  ['<span :class="{ \'rounded-md\': ok }"></span>', '<span :class="{ \'rounded-sm\': ok }"></span>'],
  // Corner and side variants.
  ['<i class="rounded-t"></i>', '<i class="rounded-t-sm"></i>'],
  ['<i class="rounded-t-md"></i>', '<i class="rounded-t-sm"></i>'],
  ['<i class="rounded-t-xl"></i>', '<i class="rounded-t-2xl"></i>'],
  ['<i class="rounded-t-3xl"></i>', '<i class="rounded-t-2xl"></i>'],
  ['<i class="rounded-bl"></i>', '<i class="rounded-bl-sm"></i>'],
  ['<i class="rounded-tr-md"></i>', '<i class="rounded-tr-sm"></i>'],
  ['<i class="rounded-t-2xl"></i>', '<i class="rounded-t-2xl"></i>'],
  ['<i class="rounded-t-lg"></i>', '<i class="rounded-t-lg"></i>'],
  // Bare-token boundaries: only exact source tokens are mapped.
  ['<i class="rounded-lg"></i>', '<i class="rounded-lg"></i>'],
  ['<i class="rounded-full"></i>', '<i class="rounded-full"></i>'],
  ['<i class="rounded-none"></i>', '<i class="rounded-none"></i>'],
  ['<i class="rounded-sm"></i>', '<i class="rounded-sm"></i>'],
  ['<i class="rounded-2xl"></i>', '<i class="rounded-2xl"></i>'],
  ['<i class="rounded-[4px]"></i>', '<i class="rounded-[4px]"></i>'],
  ['<i class="roundedX"></i>', '<i class="roundedX"></i>'],
  ['<i class="a-rounded"></i>', '<i class="a-rounded"></i>'],
  ['<i class="roundedCorners"></i>', '<i class="roundedCorners"></i>'],
  ['<i class="rounded-square"></i>', '<i class="rounded-square"></i>'],
  ['<i class="rounded-md/50"></i>', '<i class="rounded-md/50"></i>'],
  ['<i class="[&>svg]:rounded"></i>', '<i class="[&>svg]:rounded-sm"></i>'],
  // Comments and prose keep the source word.
  ['<!-- rounded-md -->', '<!-- rounded-md -->'],
  ['<div class="rounded"></div> <!-- rounded-md -->', '<div class="rounded-sm"></div> <!-- rounded-md -->'],
  [
    "<script>\n// rounded-md\nconst cls = \"rounded\";\n</script>\n<style>\n/* rounded-lg */\n.a { border-radius: 4px; }\n</style>\n<template><div class=\"rounded-xl\"></div></template>",
    "<script>\n// rounded-md\nconst cls = \"rounded-sm\";\n</script>\n<style>\n/* rounded-lg */\n.a { border-radius: 4px; }\n</style>\n<template><div class=\"rounded-2xl\"></div></template>",
  ],
  // Template text nodes are prose, not classes.
  ["<p>rounded corners stay</p>", "<p>rounded corners stay</p>"],
];

// Plain TS/JS/TSX sources start in code mode: string and template literals are
// class contexts; comments and unquoted code (identifiers, regexes) are not.
const codeCases: Array<[string, string]> = [
  ['const cls = "rounded";', 'const cls = "rounded-sm";'],
  ["const cls = 'rounded-md';", "const cls = 'rounded-sm';"],
  ["const cls = `rounded ${x}`;", "const cls = `rounded-sm ${x}`;"],
  ['const cls = cond ? "rounded-xl" : "rounded-lg";', 'const cls = cond ? "rounded-2xl" : "rounded-lg";'],
  ['const map = { "rounded-md": 1 };', 'const map = { "rounded-sm": 1 };'],
  ['const list = ["rounded", "rounded-3xl"];', 'const list = ["rounded-sm", "rounded-2xl"];'],
  ["// rounded-md stays in a comment", "// rounded-md stays in a comment"],
  ["/* rounded-lg stays */", "/* rounded-lg stays */"],
  ["const re = /rounded/;", "const re = /rounded/;"],
  ["const n = 5; // rounded", "const n = 5; // rounded"],
  ["const s = 'a \\' rounded-md';", "const s = 'a \\' rounded-sm';"],
  ["const roundedCorners = 1;", "const roundedCorners = 1;"],
  // "/" is a token boundary per the codemod contract, so a path segment that is
  // exactly a source token is mapped like any other occurrence.
  ['const url = "https://x/rounded-md";', 'const url = "https://x/rounded-sm";'],
];

describe("codemod-radius transformRadius (Vue SFC mode)", () => {
  it.each(vueCases)("transforms %j", (input, expected) => {
    expect(transformRadius(input)).toBe(expected);
  });
});

describe("codemod-radius transformRadius (code mode)", () => {
  it.each(codeCases)("transforms %j", (input, expected) => {
    expect(transformRadius(input, ".ts")).toBe(expected);
  });
});

describe("codemod-radius idempotency", () => {
  it("maps every fixture to a fixed point", () => {
    for (const [input, expected] of vueCases) {
      expect(transformRadius(expected)).toBe(expected);
      expect(transformRadius(transformRadius(input))).toBe(expected);
    }
    for (const [input, expected] of codeCases) {
      expect(transformRadius(expected, ".ts")).toBe(expected);
      expect(transformRadius(transformRadius(input, ".ts"), ".ts")).toBe(expected);
    }
  });
});
