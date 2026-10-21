import { expect, test } from "bun:test";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

// The skill is loaded from a dot directory, which is gitignored — so the file
// git actually sees is docs/agents/skills/*.md, and every loader path must be a
// symlink to it. This regressed for real: .qoder/ carried a two-month-old copy
// that still instructed hand-editing package.json versions and half the derived
// metadata, while .claude/ had the current text. Nothing failed, because nothing
// compared them.

const ROOT = join(import.meta.dir, "../../..");
const LOADERS = [".qoder", ".claude", ".agents"];
const SKILL = "xacpx-release";
const LOADER_LINK = join("skills", SKILL, "SKILL.md");

test("the skill is tracked, and no loader keeps a copy git cannot see", () => {
  // CI checks out only tracked files, so the gitignored loader directories are
  // absent there. That is the assertion: a real file at a loader path would be
  // drift, and a link must point at the tracked original. Absent is fine — it is
  // what a fresh clone has, and scripts/link-agent-skills.mjs fills it in.
  const canonical = join(ROOT, "docs", "agents", "skills", `${SKILL}.md`);
  const expected = readFileSync(canonical, "utf8");

  for (const loader of LOADERS) {
    const link = join(ROOT, loader, LOADER_LINK);
    const stats = lstatSync(link, { throwIfNoEntry: false });
    if (!stats) continue;
    expect({ loader, isSymlink: stats.isSymbolicLink() }).toEqual({ loader, isSymlink: true });
    expect({ loader, target: readlinkSync(link) }).toEqual({
      loader,
      target: `../../../docs/agents/skills/${SKILL}.md`,
    });
    // Reading through the link is the assertion that matters: a stale copy would
    // differ here even while both files exist.
    expect({ loader, same: readFileSync(link, "utf8") === expected }).toEqual({ loader, same: true });
  }
});

test("the skill routes to the release script instead of hand-editing versions", () => {
  // The stale copy's failure mode, stated as a contract: these instructions must
  // not come back, because the derived metadata spans ~14 files and a miss only
  // fails at tag-push time.
  const skill = readFileSync(join(ROOT, "docs", "agents", "skills", `${SKILL}.md`), "utf8");
  expect(skill).toContain("node ./scripts/release.mjs apply --yes");
  expect(skill).toContain("node ./scripts/release.mjs publish --yes");
  expect(skill).toContain("never hand-edit a version");
  expect(skill).not.toContain("edit its `package.json` version field");
});
