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
// Context rules. Tokens are rewritten only inside class-like quoted regions:
// HTML attribute values (class="...", :class="['rounded', ...]") and JS/TS
// string and template literals. Comments (HTML <!-- -->, JS // and slash-star,
// CSS slash-star), unquoted code, and regex literals are copied verbatim, so
// prose such as "four rounded capsules" is never touched and a quote inside a
// regex cannot open a phantom string. SFC script and style sections are
// scanned with code rules, the template with tag rules. All files under the
// target paths are processed, including __tests__ (class assertions must track
// the new tokens); there are no snapshot fixtures to exclude. The script and
// its own fixture file are skipped: both intentionally contain pre-migration
// tokens as literals.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_FILE = fileURLToPath(import.meta.url);
const SELF_TEST_FILE = path.join(
  path.dirname(SELF_FILE),
  "..",
  "src",
  "__tests__",
  "codemod-radius.test.ts",
);
const SELF_FILES = new Set([path.resolve(SELF_FILE), path.resolve(SELF_TEST_FILE)]);

const EXTENSIONS = new Set([".vue", ".ts", ".js", ".tsx"]);
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

function isTokenChar(ch) {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "-"
  );
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

const OPEN_SECTION = /^<(script|style)(?=[\s/>])/;
const CLOSE_SECTION = { script: "</script", style: "</style" };
// A "/" opens a regex literal only in expression position. After a value
// (identifier, number, string, ")" or "]") it is division. Without this split,
// a quote inside a regex (e.g. /\bviewBox="([^"]+)"/) opens a phantom string
// that swallows the next comment.
const REGEX_AFTER_PUNCT = new Set([..."([{!&|?:;=+-*%<>~^},"]);
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await",
]);

function transformText(text, fileExt = ".vue") {
  const n = text.length;
  let out = "";
  let replacements = 0;
  let i = 0;
  // text: template prose; tag: inside an HTML tag; tagValue: inside a quoted
  // attribute value; code: SFC script/style section or plain TS/JS; the rest
  // are comment, string, and regex sub-states of code. SFCs start in template
  // prose; plain TS/JS/TSX files start in code.
  let state = fileExt === ".vue" ? "text" : "code";
  let quote = "";
  let section = null;
  let pendingSection = null;
  let inCharClass = false;
  // Last significant code char and trailing identifier word, for the regex
  // versus division decision. Whitespace and comments change neither.
  let prevSig;
  let word = "";

  const noteSig = (ch) => {
    if (isTokenChar(ch) || ch === "$") {
      word += ch;
      prevSig = ch;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      word = "";
      prevSig = ch;
    }
  };
  const regexAllowed = () =>
    prevSig === undefined ||
    REGEX_AFTER_PUNCT.has(prevSig) ||
    REGEX_AFTER_WORD.has(word);

  while (i < n) {
    const ch = text[i];
    if (state === "text") {
      if (text.startsWith("<!--", i)) {
        const end = text.indexOf("-->", i + 4);
        const stop = end === -1 ? n : end + 3;
        out += text.slice(i, stop);
        i = stop;
      } else if (ch === "<") {
        const m = OPEN_SECTION.exec(text.slice(i, i + 12));
        pendingSection = m ? m[1] : null;
        state = "tag";
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
      }
    } else if (state === "tag") {
      if (ch === '"' || ch === "'") {
        quote = ch;
        state = "tagValue";
        out += ch;
        i++;
      } else if (ch === ">") {
        if (pendingSection) {
          section = pendingSection;
          state = "code";
          prevSig = undefined;
          word = "";
        } else {
          state = "text";
        }
        pendingSection = null;
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
      }
    } else if (state === "tagValue") {
      if (ch === quote) {
        state = "tag";
        out += ch;
        i++;
      } else {
        const hit = mappedTokenAt(text, i);
        if (hit) {
          out += hit.replacement;
          replacements++;
          i = hit.end;
        } else {
          out += ch;
          i++;
        }
      }
    } else if (state === "code") {
      const close = CLOSE_SECTION[section];
      if (close && text.startsWith(close, i)) {
        const end = text.indexOf(">", i);
        const stop = end === -1 ? n : end + 1;
        out += text.slice(i, stop);
        i = stop;
        section = null;
        state = "text";
      } else if (text.startsWith("//", i)) {
        state = "lineComment";
        out += "//";
        i += 2;
      } else if (text.startsWith("/*", i)) {
        state = "blockComment";
        out += "/*";
        i += 2;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        state = "codeString";
        out += ch;
        i++;
        prevSig = ch;
        word = "";
      } else if (ch === "/" && regexAllowed()) {
        state = "regex";
        inCharClass = false;
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
        noteSig(ch);
      }
    } else if (state === "codeString") {
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (ch === quote) {
        state = "code";
        out += ch;
        i++;
        prevSig = ch;
        word = "";
      } else {
        const hit = mappedTokenAt(text, i);
        if (hit) {
          out += hit.replacement;
          replacements++;
          i = hit.end;
        } else {
          out += ch;
          i++;
        }
      }
    } else if (state === "regex") {
      if (ch === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (inCharClass) {
        if (ch === "]") inCharClass = false;
        out += ch;
        i++;
      } else if (ch === "[") {
        inCharClass = true;
        out += ch;
        i++;
      } else if (ch === "/") {
        out += ch;
        i++;
        while (i < n && text[i] >= "a" && text[i] <= "z") {
          out += text[i];
          i++;
        }
        state = "code";
        prevSig = "/";
        word = "";
      } else {
        out += ch;
        i++;
      }
    } else if (state === "lineComment") {
      if (ch === "\n") {
        state = "code";
      }
      out += ch;
      i++;
    } else if (state === "blockComment") {
      if (text.startsWith("*/", i)) {
        state = "code";
        out += "*/";
        i += 2;
      } else {
        out += ch;
        i++;
      }
    }
  }
  return { text: out, replacements };
}

export function transformRadius(text, fileExt = ".vue") {
  return transformText(text, fileExt).text;
}

async function collect(target) {
  const info = await stat(target);
  if (!info.isDirectory()) {
    return EXTENSIONS.has(path.extname(target)) ? [target] : [];
  }
  const entries = [...(await readdir(target, { withFileTypes: true }))].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const files = [];
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collect(full)));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function displayPath(file, from) {
  const rel = path.relative(from, file);
  return rel.startsWith("..") ? file : rel;
}

async function main(argv) {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = argv.slice(2);
  const targets = args.length > 0
    ? args.map((p) => path.resolve(process.cwd(), p))
    : [path.join(pkgRoot, "src")];

  const files = [];
  for (const target of targets) {
    files.push(...(await collect(target)));
  }

  let changedFiles = 0;
  let totalReplacements = 0;
  for (const file of files) {
    if (SELF_FILES.has(path.resolve(file))) continue;
    const original = await readFile(file, "utf8");
    if (!original.includes("rounded")) continue;
    const result = transformText(original, path.extname(file));
    if (result.replacements === 0) continue;
    await writeFile(file, result.text);
    changedFiles++;
    totalReplacements += result.replacements;
    console.log(`${displayPath(file, process.cwd())}: ${result.replacements}`);
  }
  console.log(`total: ${totalReplacements} replacements in ${changedFiles} files`);
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  main(process.argv).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
