// Mechanical radius-token migration for the relay-web redesign (spec 2.3):
//   rounded, rounded-md        -> rounded-sm   (6px)
//   rounded-xl, rounded-3xl    -> rounded-2xl  (16px)
//   corner/side variants likewise (rounded-t -> rounded-t-sm, rounded-tr-md ->
//   rounded-tr-sm, rounded-t-xl -> rounded-t-2xl, rounded-t-3xl -> rounded-t-2xl)
// rounded-lg (10px via tailwind.config.js) and rounded-full are intentionally
// left alone, as are arbitrary values (rounded-[4px], rounded-bl-[2px]) and any
// identifier that merely contains "rounded" (roundedCorners, --rounded,
// .rounded-foo, rounded-square).
//
// Usage:
//   node scripts/codemod-radius.mjs [paths...]   (default: src)
// Runnable with node or bun. Idempotent: every output token is a fixed point.
//
// The class-like-region scanner is shared with codemod-type.mjs (see
// scripts/codemod-scan.mjs); this file owns only the radius token map.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, transformText, isTokenChar } from "./codemod-scan.mjs";

const SELF_FILE = fileURLToPath(import.meta.url);
const SELF_TEST_FILE = path.join(
  path.dirname(SELF_FILE),
  "..",
  "src",
  "__tests__",
  "codemod-radius.test.ts",
);
const SELF_FILES = new Set([path.resolve(SELF_FILE), path.resolve(SELF_TEST_FILE)]);

const SIDES = new Set([
  "t", "r", "b", "l", "s", "e",
  "tl", "tr", "br", "bl",
  "ss", "se", "es", "ee",
]);
const SIDE_TOKEN = /^rounded-([a-z]{1,2})(?:-(sm|md|lg|xl|2xl|3xl|full|none))?$/;

function mapRadiusToken(token) {
  switch (token) {
    case "rounded":
    case "rounded-md":
      return "rounded-sm";
    case "rounded-xl":
    case "rounded-3xl":
      return "rounded-2xl";
  }
  const m = SIDE_TOKEN.exec(token);
  if (!m) return null;
  const [, side, suffix] = m;
  if (!SIDES.has(side)) return null;
  if (suffix === undefined || suffix === "md") return `rounded-${side}-sm`;
  if (suffix === "xl" || suffix === "3xl") return `rounded-${side}-2xl`;
  return null;
}

// A token starts after any char outside [A-Za-z0-9_-] (so variant prefixes,
// "!" and ":" boundaries work) and runs over [A-Za-z0-9_-] plus "[" and "/"
// (so rounded-[4px] and rounded-md/50 arbitrary forms are consumed whole and
// never match). Returns the mapped replacement, or null when the token at i is
// not a source token or i is mid-token.
function mappedTokenAt(text, i) {
  if (i > 0 && isTokenChar(text[i - 1])) return null;
  if (!text.startsWith("rounded", i)) return null;
  let j = i;
  while (j < text.length && (isTokenChar(text[j]) || text[j] === "[" || text[j] === "/")) {
    j++;
  }
  const token = text.slice(i, j);
  const mapped = mapRadiusToken(token);
  return mapped ? { end: j, replacement: mapped } : null;
}

export function transformRadius(text, fileExt = ".vue") {
  return transformText(text, fileExt, mappedTokenAt).text;
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === SELF_FILE;
if (invokedAsMain) {
  run({ mapToken: mappedTokenAt, needle: "rounded", selfFiles: SELF_FILES, argv: process.argv })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
