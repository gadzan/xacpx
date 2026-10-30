import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Path prefixes (repo-relative, forward-slash) that MUST be free of CJK string
// literals. Final flip: entire src/ tree is now enforced.
const MIGRATED_PREFIXES = ["src/"];

// Match only Han (Chinese) characters. Using \p{Script=Han} (not a raw BMP range)
// is important: above-BMP emoji like 📖🔍💻 are encoded as surrogate pairs whose
// code units fall inside naive CJK BMP ranges and would false-positive. Emoji are
// allowed in catalogs (incl. the English ones); only Han characters are flagged.
const CJK = /\p{Script=Han}/u;

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) listTsFiles(p, acc);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) acc.push(p);
  }
  return acc;
}

// Best-effort: strip /* */ block comments and // line comments, then flag CJK.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("no hardcoded CJK in migrated paths", () => {
  it("migrated source files contain no CJK string literals", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles("src")) {
      const rel = file.replace(/\\/g, "/");
      if (!MIGRATED_PREFIXES.some((p) => rel.startsWith(p))) continue;
      if (rel.startsWith("src/i18n/messages/zh/")) continue; // the one allowed home for CJK
      // Protocol literals, not UI text: the silence token and the relay closing
      // hint are sent to the agent verbatim, so they are exempt like the zh
      // catalog the prefix above allows.
      if (rel === "src/conversations/group-chat-wake.ts") continue;
      const body = stripComments(readFileSync(file, "utf8"));
      if (CJK.test(body)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
