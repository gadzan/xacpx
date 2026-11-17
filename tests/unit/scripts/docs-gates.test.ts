import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globToRegExp, hashText } from "../../../scripts/sync-docs-site.mjs";
import { IGNORE, ZH_EXEMPT, collectBrandFiles, isBrandViolation } from "../../../scripts/check-doc-i18n.mjs";

// Both doc gates shipped with real bugs on the first pass: the glob treated
// `**` as a single path segment (so docs/superpowers/** never matched and 240
// historical brand mentions failed CI), and the site gate hashed entries that
// have no site page (every internal-docs edit became an unresolvable failure).
// These tests pin the semantics that make the gates usable.

const ROOT = join(import.meta.dir, "../../..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "packages/docs/sync-manifest.json"), "utf8"));
const matches = (rel: string, pattern: string) => globToRegExp(pattern).test(rel);

test("glob: ** crosses separators, * does not", () => {
  expect(matches("docs/superpowers/plans/2026-06-05-x.md", "docs/superpowers/**")).toBe(true);
  expect(matches("docs/agents/skills/x.md", "docs/agents/**")).toBe(true);
  expect(matches("docs/faq.md", "docs/*.md")).toBe(true);
  expect(matches("docs/zh/faq_zh.md", "docs/*.md")).toBe(false);
  expect(matches("docs/cli-reference.md", "docs/cli-reference.md")).toBe(true);
  expect(matches("docs/cli-reference.md", "docs/cli-reference*")).toBe(true);
});

test("hash: line endings and trailing whitespace are not content", () => {
  const base = "# Title\n\nbody line\n";
  expect(hashText(base)).toBe(hashText(base.replace(/\n/g, "\r\n")));
  expect(hashText(base)).toBe(hashText("# Title\n\nbody line   \n\n"));
  expect(hashText(base)).not.toBe(hashText("# Title\n\nbody line changed\n"));
});

test("manifest: every docs top-level page is registered or ignored", () => {
  const registered = new Set(MANIFEST.entries.map((e: { source: string }) => e.source));
  const docs = readdirSync(join(ROOT, "docs"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `docs/${e.name}`);
  const unregistered = docs.filter(
    (rel) => !registered.has(rel) && !(MANIFEST.ignore ?? []).some((p: string) => matches(rel, p)),
  );
  expect(unregistered).toEqual([]);
});

test("manifest: every mapped site page exists in both locales", () => {
  const missing: string[] = [];
  for (const entry of MANIFEST.entries) {
    if (!entry.site) continue;
    for (const locale of ["en", "zh"] as const) {
      const rel = entry.site[locale];
      if (rel && !existsSync(join(ROOT, "packages/docs", rel))) missing.push(`${entry.source} → ${locale}:${rel}`);
    }
  }
  expect(missing).toEqual([]);
});

test("manifest: zh mappings point at the zh tree, not the en page", () => {
  // Regression: the first manifest set site.zh === site.en, so the gate's
  // existence check read the English page twice and all 20+ zh pages were
  // silently unprotected.
  const wrong: string[] = [];
  for (const entry of MANIFEST.entries) {
    if (!entry.site?.en || !entry.site?.zh) continue;
    if (!entry.site.zh.startsWith("zh/")) wrong.push(`${entry.source}: zh → ${entry.site.zh}`);
    if (entry.site.zh === entry.site.en) wrong.push(`${entry.source}: zh === en`);
  }
  expect(wrong).toEqual([]);
});

test("manifest: every site page is mapped from a source or declared site-only", () => {
  const mapped = new Set<string>();
  for (const entry of MANIFEST.entries) {
    if (!entry.site) continue;
    for (const locale of ["en", "zh"] as const) if (entry.site[locale]) mapped.add(entry.site[locale]);
  }
  const siteOnly = new Set<string>(MANIFEST.siteOnly ?? []);
  const siteRoot = join(ROOT, "packages/docs");
  const pages: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), child);
      else if (e.name.endsWith(".md")) pages.push(child);
    }
  };
  for (const section of ["guide", "reference", "development", "plugins", "zh"]) {
    const dir = join(siteRoot, section);
    if (existsSync(dir)) walk(dir, section);
  }
  if (existsSync(join(siteRoot, "index.md"))) pages.push("index.md");
  const unmapped = pages.filter((rel) => !mapped.has(rel) && !siteOnly.has(rel));
  expect(unmapped).toEqual([]);
});

test("i18n: every translated-by-convention page has a zh counterpart", () => {
  const docs = readdirSync(join(ROOT, "docs"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `docs/${e.name}`);
  const missing = docs
    .filter((rel) => !IGNORE.some((p) => matches(rel, p)) && !ZH_EXEMPT.includes(rel))
    .filter((rel) => !existsSync(join(ROOT, "docs/zh", `${rel.slice("docs/".length, -3)}_zh.md`)));
  expect(missing).toEqual([]);
});

test("brand: the guard scans package READMEs, not just docs/", () => {
  // The two channel READMEs still said `weacpx plugin add …` for months: the
  // brand rule only walked docs/ and packages/docs, while those READMEs are
  // the sync-manifest sources for plugins/feishu.md and plugins/yuanbao.md.
  const files = collectBrandFiles();
  expect(files).toContain("packages/channel-feishu/README.md");
  expect(files).toContain("packages/channel-yuanbao/README.md");
  expect(files).toContain("packages/channel-discord/README.md");
  expect(files).toContain("packages/relay/README.md");
  // Historical records and the compat package keep quoting the old brand.
  expect(files.some((f: string) => f.startsWith("docs/superpowers/"))).toBe(false);
  expect(files.some((f: string) => f.startsWith("weacpx-compat/"))).toBe(false);
});

test("brand: violations are flagged, legacy contexts are exempt", () => {
  // Real violations found in the repo on 2026-11-17.
  expect(isBrandViolation("# Weacpx 群组使用指南")).toBe(true);
  expect(isBrandViolation("2. In WeChat, run `/ss opencode --ws weacpx`.")).toBe(true);
  expect(isBrandViolation("before auto-installing, weacpx enumerates the candidate directories")).toBe(true);
  // Legitimate legacy/compat mentions.
  expect(isBrandViolation("- Cross-package rename migration: this project was renamed `weacpx` → `xacpx`.")).toBe(false);
  expect(isBrandViolation("| `XACPX_CLI_COMMAND` (legacy `WEACPX_*`) | explicit command |")).toBe(false);
  expect(isBrandViolation("回退到旧前缀 `WEACPX_<后缀>`")).toBe(false);
  expect(isBrandViolation("export interface WeacpxPlugin {")).toBe(false);
  expect(isBrandViolation("nothing to see here")).toBe(false);
});
