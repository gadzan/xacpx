#!/usr/bin/env node
/**
 * docs/ ↔ docs/zh/ parity gate.
 *
 * Rules:
 *   A. parity    every docs/<name>.md must have docs/zh/<name>_zh.md.
 *                FAIL — a new page may not ship English-only.
 *   B. recency   if the English page's last commit is newer than the zh page's,
 *                the translation is behind. WARN by default; FAIL with --strict.
 *   C. brand     `weacpx` may only appear in legacy/compat contexts (env
 *                fallbacks, deprecated identifiers, rename notes). Anything
 *                else FAILS — e.g. a heading still titled "Weacpx …".
 *
 * Exit code 1 on any FAIL.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");

/** Directories under docs/ that are not translated pages. */
export const IGNORE = ["docs/agents/**", "docs/superpowers/**", "docs/design/**", "docs/research/**", "docs/zh/**"];

/**
 * Pages that are English-only by convention (internal design / ops runbooks).
 * A NEW docs/<name>.md is not exempt by default: it must ship
 * docs/zh/<name>_zh.md or be listed here deliberately.
 */
export const ZH_EXEMPT = [
  "docs/control-module.md",
  "docs/conversation-runtime.md",
  "docs/desktop-rfb-setup.md",
  "docs/feishu-cardactions-deployment.md",
  "docs/peer-delegation.md",
  "docs/relay-deployment.md",
  "docs/relay-history-retirement.md",
  "docs/relay-interaction-deployment.md",
  "docs/relay-module.md",
  "docs/relay-release.md",
  "docs/relay-web-module.md",
  "docs/release-automation.md",
  "docs/runtime-mcp.md",
  "docs/runtime-permission.md",
  "docs/runtime-queue.md",
  "docs/verification-stack.md",
];

/** Legacy identifiers that legitimately contain "weacpx". */
const LEGACY_IDENT =
  /WEACPX_[A-Za-z0-9_<]*|weacpx-compat|\b(?:WeacpxPlugin|minWeacpxVersion|compatibleWeacpxVersions|validateWeacpxPlugin)\b|weacpxplugin|2026-03-25-weacpx-acpx-bridge-design\.md|2026-04-13-weacpx-orchestration-design\.md/gi;

/** A line framed as legacy/migration context may mention the old brand. */
const LEGACY_CONTEXT =
  /\b(?:renamed|rename|legacy|migrat\w*|backward|compat\w*|old name|old prefix|was named|previously|still works|deprecated)\b|旧名|改名|迁移|兼容|遗留|仍然|旧包|旧的|之前|回退/i;

export function globToRegExp(glob) {
  // `**` crosses directory separators; `*` does not.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Brand rule for one line: a `weacpx` occurrence is a violation unless it is a
 * documented legacy identifier or the line frames it as legacy/migration.
 */
export function isBrandViolation(line) {
  if (!/weacpx/i.test(line)) return false;
  const stripped = line.replace(LEGACY_IDENT, "");
  return /weacpx/i.test(stripped) && !LEGACY_CONTEXT.test(line);
}

function matchesAny(rel, patterns) {
  return patterns.some((p) => globToRegExp(p).test(rel));
}

function lastCommitUnix(relPath) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", relPath], { cwd: ROOT, encoding: "utf8" });
    const value = Number.parseInt(out.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function listDocsPages() {
  return readdirSync(DOCS, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `docs/${e.name}`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(abs, out);
    } else if (entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Every markdown file the brand guard scans: docs/, the VitePress site, and
 * all package trees (the site mirrors the channel package READMEs, so a stale
 * brand there contradicts its own site page). Historical record directories
 * and the compat package legitimately quote the old brand.
 */
export function collectBrandFiles() {
  const BRAND_SKIP = [
    "docs/superpowers/**",
    "docs/design/**",
    "docs/research/**",
    "docs/agents/**",
    "packages/docs/node_modules/**",
    "weacpx-compat/**",
  ];
  return [...walk(DOCS), ...walk(path.join(ROOT, "packages", "docs")), ...walk(path.join(ROOT, "packages"))].filter(
    (f) => !matchesAny(f, BRAND_SKIP),
  );
}

if (import.meta.main) {
  const strict = process.argv.includes("--strict");
  const failures = [];
  const warnings = [];

  // Rule A + B: parity and recency over docs/ ↔ docs/zh/.
  const missing = [];
  const behind = [];
  for (const en of listDocsPages()) {
    if (matchesAny(en, IGNORE)) continue;
    if (ZH_EXEMPT.includes(en)) continue;
    const base = path.basename(en, ".md");
    const zh = `docs/zh/${base}_zh.md`;
    if (!existsSync(path.join(ROOT, zh))) {
      missing.push(`${en} → ${zh}`);
      continue;
    }
    const enTime = lastCommitUnix(en);
    const zhTime = lastCommitUnix(zh);
    if (enTime !== null && zhTime !== null && enTime > zhTime) behind.push(`${en} (en ${new Date(enTime * 1000).toISOString().slice(0, 10)} > zh ${new Date(zhTime * 1000).toISOString().slice(0, 10)})`);
  }
  if (missing.length > 0) {
    failures.push(`missing zh translation for ${missing.length} page(s):\n` + missing.map((m) => `    ${m}`).join("\n"));
  }
  if (behind.length > 0) {
    const message = `zh translation behind for ${behind.length} page(s):\n` + behind.map((b) => `    ${b}`).join("\n");
    if (strict) failures.push(message);
    else warnings.push(message);
  }

  // Rule C: brand guard over docs/, the VitePress site, and every package
  // README (the site mirrors channel-* READMEs, so a stale brand in a README
  // silently contradicts its own site page). Historical record directories
  // (plans/specs/handoffs/designs) legitimately quote the old brand.
  const brandFiles = collectBrandFiles();
  const brandHits = [];
  for (const rel of brandFiles) {
    const lines = readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (isBrandViolation(line)) brandHits.push(`${rel}:${index + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
  if (brandHits.length > 0) {
    failures.push(`brand usage outside legacy/compat context (${brandHits.length}):\n` + brandHits.map((h) => `    ${h}`).join("\n"));
  }

  for (const w of warnings) console.warn(`WARN ${w}`);
  if (failures.length > 0) {
    console.error("doc i18n check FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`doc i18n check OK (${listDocsPages().length} docs pages${warnings.length > 0 ? `, ${warnings.length} warning(s)` : ""})`);
}
