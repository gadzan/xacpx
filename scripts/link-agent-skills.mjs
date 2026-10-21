#!/usr/bin/env node
/**
 * Point every agent-skill loader path at the canonical file under `docs/`.
 *
 * `.qoder/`, `.claude/` and `.agents/` are gitignored, so a skill kept inside one
 * of them is invisible to git and drifts from its siblings the moment somebody
 * edits a single copy. `.qoder/skills/xacpx-release/SKILL.md` had fallen two
 * months behind and still told the agent to hand-edit `package.json` versions and
 * half the derived metadata — the exact thing `scripts/release.mjs` exists to
 * prevent. Symlinks make that divergence impossible: one inode, one edit.
 *
 * The links are in gitignored directories, so a fresh clone has none. Run this
 * after cloning (idempotent), and again when a skill is added:
 *
 *   node ./scripts/link-agent-skills.mjs
 */
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = join(ROOT, "docs", "agents", "skills");
const LOADERS = [".qoder", ".claude", ".agents"];

const skills = readdirSync(CANONICAL)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));

if (skills.length === 0) {
  console.log(`${relative(ROOT, CANONICAL)} has no skills to link`);
  process.exit(0);
}

let linked = 0;
let already = 0;
for (const loader of LOADERS) {
  for (const skill of skills) {
    const dir = join(ROOT, loader, "skills", skill);
    const link = join(dir, "SKILL.md");
    const target = join(CANONICAL, `${skill}.md`);
    const relativeTarget = relative(dir, target);

    mkdirSync(dir, { recursive: true });

    const existing = lstatSync(link, { throwIfNoEntry: false });
    if (existing && existing.isSymbolicLink() && readlinkSync(link) === relativeTarget) {
      already += 1;
      continue;
    }
    // A real file here is the drift this script exists to fix; the content lives
    // in docs/ already, so replacing it loses nothing.
    if (existing) rmSync(link);
    symlinkSync(relativeTarget, link);
    console.log(`linked ${loader}/skills/${skill}/SKILL.md -> ${relativeTarget}`);
    linked += 1;
  }
}

console.log(linked === 0 ? `all ${already} skill link(s) already point at docs/agents/skills` : `${linked} linked, ${already} already correct`);
