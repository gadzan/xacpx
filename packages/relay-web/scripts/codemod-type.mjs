// Mechanical type-scale migration for the relay-web redesign (spec 2.5):
//   text-[9px] [9.5px] [10px] [10.5px] [11px] [11.5px] -> text-xs  (12/18)
//   text-[12px] [12.5px] [13px]                          -> text-ui  (13/20)
//   text-[13.5px] [14px]                                  -> text-sm  (14/22)
//   text-[15px] [16px]                                    -> text-base (16/24)
// Any other arbitrary value is left alone and reported by the runner, so
// `text-[#fff]`, `text-[length:14px]` and unknown sizes survive untouched.
//
// Usage:
//   node scripts/codemod-type.mjs [paths...]   (default: src)
// Runnable with node or bun. Idempotent: every output token is a fixed point.
//
// The class-like-region scanner is shared with codemod-radius.mjs (see
// scripts/codemod-scan.mjs); this file owns only the font-size map. Unlike the
// radius tokens the half-pixel sizes need "." inside the token charset.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, transformText, isTokenChar } from "./codemod-scan.mjs";

const SELF_FILE = fileURLToPath(import.meta.url);
const SELF_TEST_FILE = path.join(
  path.dirname(SELF_FILE),
  "..",
  "src",
  "__tests__",
  "codemod-type.test.ts",
);
const SELF_FILES = new Set([path.resolve(SELF_FILE), path.resolve(SELF_TEST_FILE)]);

const SIZE_TOKENS = {
  "9": "text-xs",
  "9.5": "text-xs",
  "10": "text-xs",
  "10.5": "text-xs",
  "11": "text-xs",
  "11.5": "text-xs",
  "12": "text-ui",
  "12.5": "text-ui",
  "13": "text-ui",
  "13.5": "text-sm",
  "14": "text-sm",
  "15": "text-base",
  "16": "text-base",
};
const ARBITRARY_SIZE = /^text-\[(\d+(?:\.\d+)?)px\]$/;

// A token starts after any char outside [A-Za-z0-9_-] (so variant prefixes,
// "!" and ":" boundaries work) and runs over [A-Za-z0-9_-] plus "[", "]", "/"
// and "." (so text-[10.5px] is consumed whole). Returns the mapped replacement,
// or null when the token at i is not a mapped source token or i is mid-token.
function mappedTokenAt(text, i) {
  if (i > 0 && isTokenChar(text[i - 1])) return null;
  if (!text.startsWith("text-", i)) return null;
  let j = i;
  while (
    j < text.length &&
    (isTokenChar(text[j]) || text[j] === "[" || text[j] === "]" || text[j] === "/" || text[j] === ".")
  ) {
    j++;
  }
  const token = text.slice(i, j);
  const m = ARBITRARY_SIZE.exec(token);
  if (!m) return null;
  const mapped = SIZE_TOKENS[m[1]];
  return mapped ? { end: j, replacement: mapped } : null;
}

export function transformType(text, fileExt = ".vue") {
  return transformText(text, fileExt, mappedTokenAt).text;
}

// Any other `text-[…]` arbitrary value is reported, never rewritten: colors
// (text-[#fff]), keyword forms (text-[length:14px]) and sizes outside the scale
// all stay as the author wrote them.
function reportUnmapped(text, i) {
  if (i > 0 && isTokenChar(text[i - 1])) return null;
  if (!text.startsWith("text-[", i)) return null;
  let j = i;
  while (
    j < text.length &&
    (isTokenChar(text[j]) || text[j] === "[" || text[j] === "]" || text[j] === "/" || text[j] === ".")
  ) {
    j++;
  }
  return { end: j, note: text.slice(i, j) };
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === SELF_FILE;
if (invokedAsMain) {
  run({
    mapToken: mappedTokenAt,
    needle: "text-[",
    selfFiles: SELF_FILES,
    argv: process.argv,
    reportSkip: reportUnmapped,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
