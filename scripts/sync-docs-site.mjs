#!/usr/bin/env node
/**
 * Docs-site drift gate.
 *
 * packages/docs is an editorially independent VitePress site (English-first,
 * condensed, own link graph) — NOT a byte copy of docs/. So "sync" cannot mean
 * copying files; it means: when a source of truth changes, the corresponding
 * site page must be reviewed. This script records, per source, the content hash
 * at the moment its site page(s) were last reconciled.
 *
 *   check       (default, CI) fail when a source changed since its last
 *               reconciliation, when a site page is missing, or when a docs/
 *               top-level page is not registered in the manifest.
 *   reconcile   record the current hash for the given sources. Run AFTER
 *               updating the site page, or to explicitly accept a no-impact
 *               delta. Default targets: stale + unrecorded entries.
 *               --all re-records everything; --source <glob> restricts.
 *   status      print the per-source table.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILE = path.join(ROOT, "packages", "docs", "sync-manifest.json");
const STATE_FILE = path.join(ROOT, "packages", "docs", "sync-state.json");
const SITE_DIR = path.join(ROOT, "packages", "docs");

function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** Content hash of already-normalized text (line endings / trailing spaces are
 *  not content, so a CRLF checkout must not trip the gate). */
export function hashText(text) {
  return createHash("sha256").update(normalize(text)).digest("hex");
}

function hashFile(file) {
  return hashText(readFileSync(file, "utf8"));
}

function loadJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Minimal glob: `**` crosses separators, `*` does not. */
export function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(relPath, patterns) {
  return patterns.some((p) => globToRegExp(p).test(relPath));
}

function listDocsTopLevel() {
  return readdirSync(path.join(ROOT, "docs"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `docs/${e.name}`);
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "check";
  const rest = command === "check" && argv[0]?.startsWith("--") ? argv : argv.slice(1);
  const sources = [];
  let all = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--all") all = true;
    else if (rest[i] === "--source") sources.push(rest[i + 1]), (i += 1);
    else if (rest[i].startsWith("--source=")) sources.push(rest[i].slice("--source=".length));
  }
  return { command, all, sources };
}

function main() {
  const { command, all, sources } = parseArgs(process.argv.slice(2));
  const manifest = loadJson(MANIFEST_FILE, null);
  if (!manifest) {
    console.error(`FATAL: manifest missing: ${path.relative(ROOT, MANIFEST_FILE)}`);
    process.exit(2);
  }
  const state = loadJson(STATE_FILE, {});
  const entries = manifest.entries;

  if (command === "status") return status(entries, state);
  if (command === "reconcile") return reconcile(entries, state, { all, sources });
  if (command === "check") return check(entries, state, manifest.ignore ?? []);
  console.error(`unknown command: ${command} (expected check | reconcile | status)`);
  process.exit(2);
}

function check(entries, state, ignore) {
  const problems = [];

  // Coverage: every docs/ top-level page is registered or explicitly ignored.
  const registered = new Set(entries.map((e) => e.source));
  for (const rel of listDocsTopLevel()) {
    if (matchesAny(rel, ignore)) continue;
    if (!registered.has(rel)) {
      problems.push(`unregistered docs source: ${rel} — add it to packages/docs/sync-manifest.json (with site pages or site: null)`);
    }
  }

  const stale = [];
  const unrecorded = [];
  for (const entry of entries) {
    const abs = path.join(ROOT, entry.source);
    if (!existsSync(abs)) {
      problems.push(`manifest source does not exist: ${entry.source}`);
      continue;
    }
    // Entries without a site page are registered for coverage only — there is
    // nothing to review when they change, so they carry no drift obligation.
    if (!entry.site) continue;
    for (const locale of ["en", "zh"]) {
      const rel = entry.site[locale];
      if (rel && !existsSync(path.join(SITE_DIR, rel))) {
        problems.push(`site page missing (${locale}): packages/docs/${rel} — source ${entry.source}`);
      }
    }
    const current = hashFile(abs);
    const recorded = state[entry.source];
    if (!recorded) unrecorded.push(entry.source);
    else if (recorded.hash !== current) stale.push(`${entry.source} → site ${entry.site.en} (+zh)`);
  }

  if (unrecorded.length > 0) {
    problems.push(`no recorded baseline for ${unrecorded.length} source(s) — run: node ./scripts/sync-docs-site.mjs reconcile`);
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} source(s) changed since their site page was last reconciled:\n` +
        stale.map((s) => `    ${s}`).join("\n") +
        `\n  Update the site page(s), then: node ./scripts/sync-docs-site.mjs reconcile`,
    );
  }

  if (problems.length > 0) {
    console.error("docs-site drift check FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`docs-site drift check OK (${entries.length} sources, ${Object.keys(state).length} recorded)`);
}

function reconcile(entries, state, { all, sources }) {
  const targets = entries.filter((entry) => {
    if (!entry.site) return false; // coverage-only entries carry no hash
    if (!existsSync(path.join(ROOT, entry.source))) return false;
    if (all) return true;
    if (sources.length > 0) return matchesAny(entry.source, sources);
    const recorded = state[entry.source];
    return !recorded || recorded.hash !== hashFile(path.join(ROOT, entry.source));
  });

  if (targets.length === 0) {
    console.log("nothing to reconcile");
    return;
  }
  for (const entry of targets) {
    const hash = hashFile(path.join(ROOT, entry.source));
    const previous = state[entry.source]?.hash ?? "(none)";
    state[entry.source] = { hash, reconciledAt: new Date().toISOString() };
    console.log(`reconciled ${entry.source}\n    ${previous.slice(0, 12)} → ${hash.slice(0, 12)}`);
  }
  const sorted = Object.fromEntries(Object.entries(state).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(STATE_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, STATE_FILE)} (${targets.length} entr${targets.length === 1 ? "y" : "ies"})`);
}

function status(entries, state) {
  const rows = [];
  for (const entry of entries) {
    const abs = path.join(ROOT, entry.source);
    const site = entry.site ? `${entry.site.en} (+zh)` : "docs-only";
    if (!existsSync(abs)) {
      rows.push([entry.source, "MISSING", "-", site]);
      continue;
    }
    const current = hashFile(abs);
    if (!entry.site) {
      rows.push([entry.source, "n/a", current.slice(0, 12), site]);
      continue;
    }
    const recorded = state[entry.source];
    const verdict = !recorded ? "unrecorded" : recorded.hash === current ? "ok" : "STALE";
    rows.push([entry.source, verdict, current.slice(0, 12), site]);
  }
  const w0 = Math.max(...rows.map((r) => r[0].length));
  for (const [source, verdict, hash, site] of rows) {
    console.log(`${source.padEnd(w0)}  ${verdict.padEnd(10)}  ${hash}  ${site}`);
  }
  if (rows.some((r) => r[1] === "STALE" || r[1] === "unrecorded" || r[1] === "MISSING")) process.exitCode = 1;
}

if (import.meta.main) main();
