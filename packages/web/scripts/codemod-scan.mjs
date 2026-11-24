// Shared scanner for the relay-web redesign codemods (codemod-radius.mjs,
// codemod-type.mjs). One state machine, one injected token mapper, so every
// codemod agrees on what a "class-like quoted region" is and none of them can
// drift from the others.
//
// Context rules. Tokens are rewritten only inside class-like quoted regions:
// HTML attribute values (class="...", :class="['rounded', ...]") and JS/TS
// string and template literals. Comments (HTML <!-- -->, JS // and slash-star,
// CSS slash-star), unquoted code, and regex literals are copied verbatim, so
// prose such as "four rounded capsules" is never touched and a quote inside a
// regex cannot open a phantom string. SFC script and style sections are
// scanned with code rules, the template with tag rules. Plain TS/JS/TSX files
// start in code mode.
//
// The mapper owns the token shape: it receives the text and the index of a
// candidate token start (already known to sit after a boundary char) and returns
// { end, replacement } or null. That lets each codemod consume its own charset
// — the radius tokens need "[", "/" and identifier chars, the type scale also
// needs "." for the half-pixel sizes.

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSIONS = new Set([".vue", ".ts", ".js", ".tsx"]);

export function isTokenChar(ch) {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "-"
  );
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

/**
 * Shared scanner. See the header comment for the context rules.
 *
 * `mappedTokenAt(text, i)` returns { end, replacement } or null and is called
 * at every position inside a class-like region. `onSkip(text, i)` is the
 * optional reporting hook for tokens that look like candidates but are not
 * mapped: it returns { end, note } to record the occurrence and consume it, or
 * null. Unmapped candidates are still copied verbatim.
 */
export function transformText(text, fileExt, mappedTokenAt, onSkip) {
  const n = text.length;
  let out = "";
  let replacements = 0;
  const skipped = [];
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
        } else if (onSkip) {
          const skip = onSkip(text, i);
          if (skip) {
            skipped.push({ index: i, note: skip.note });
            out += text.slice(i, skip.end);
            i = skip.end;
          } else {
            out += ch;
            i++;
          }
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
        } else if (onSkip) {
          const skip = onSkip(text, i);
          if (skip) {
            skipped.push({ index: i, note: skip.note });
            out += text.slice(i, skip.end);
            i = skip.end;
          } else {
            out += ch;
            i++;
          }
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
  return { text: out, replacements, skipped };
}

export async function collect(target) {
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

export function displayPath(file, from) {
  const rel = path.relative(from, file);
  return rel.startsWith("..") ? file : rel;
}

/**
 * Runs one codemod over the target paths (default: the package's src).
 *
 * `mapToken(text, i)` returns { end, replacement } or null and is called at
 * every position inside a class-like region. `needle` is the cheap substring
 * pre-filter that skips files which cannot contain a source token. `selfFiles`
 * are the codemod's own script and fixture test: both intentionally keep
 * pre-migration tokens as literals, so they must never be rewritten.
 * `reportSkip(text, i)` marks candidate-but-unmapped tokens for the run report
 * without rewriting them.
 */
export async function run({ mapToken, needle, selfFiles, argv, reportSkip }) {
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
  let totalSkipped = 0;
  for (const file of files) {
    if (selfFiles.has(path.resolve(file))) continue;
    const original = await readFile(file, "utf8");
    if (!original.includes(needle)) continue;
    const result = transformText(original, path.extname(file), mapToken, reportSkip);
    if (result.replacements === 0 && result.skipped.length === 0) continue;
    if (result.replacements > 0) {
      await writeFile(file, result.text);
      changedFiles++;
      totalReplacements += result.replacements;
      console.log(`${displayPath(file, process.cwd())}: ${result.replacements}`);
    }
    for (const skip of result.skipped) {
      const line = original.slice(0, skip.index).split("\n").length;
      console.log(`${displayPath(file, process.cwd())}:${line}: left ${skip.note}`);
      totalSkipped++;
    }
  }
  console.log(`total: ${totalReplacements} replacements in ${changedFiles} files`);
  if (reportSkip) console.log(`left as-is: ${totalSkipped} unmapped candidates`);
}
