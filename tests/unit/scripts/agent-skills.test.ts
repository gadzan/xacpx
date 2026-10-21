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

test("every agent loader resolves the release skill to the tracked file", () => {
  const canonical = join(ROOT, "docs", "agents", "skills", `${SKILL}.md`);
  const expected = readFileSync(canonical, "utf8");
  for (const loader of LOADERS) {
    const link = join(ROOT, loader, "skills", SKILL, "SKILL.md");
    const stats = lstatSync(link, { throwIfNoEntry: false });
    expect({ loader, isSymlink: stats?.isSymbolicLink() ?? false }).toEqual({ loader, isSymlink: true });
    // Reading through the link is the assertion that matters: a stale copy
    // would differ here even while both files exist.
    expect({ loader, same: readFileSync(link, "utf8") === expected }).toEqual({ loader, same: true });
    expect({ loader, target: readlinkSync(link) }).toEqual({
      loader,
      target: "../../../docs/agents/skills/xacpx-release.md",
    });
  }
});

test("the skill routes to the release script instead of hand-editing versions", () => {
  // The stale copy's failure mode, stated as a contract: these instructions must
  // not come back, because the derived metadata spans ~14 files and a miss only
  // fails at tag-push time.
  const skill = readFileSync(join(ROOT, "docs", "agents", "skills", "xacpx-release.md"), "utf8");
  expect(skill).toContain("node ./scripts/release.mjs apply --yes");
  expect(skill).toContain("node ./scripts/release.mjs publish --yes");
  expect(skill).toContain("never hand-edit a version");
  expect(skill).not.toContain("edit its `package.json` version field");
});
