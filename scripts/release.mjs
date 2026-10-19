#!/usr/bin/env node
/**
 * Release driver: detect what changed, decide versions, apply the derived
 * metadata, and (only with an explicit flag) publish.
 *
 * The point is that the derived-metadata table lives in exactly one place
 * (`scripts/release-lib.mjs`) instead of in a release checklist. Every step
 * automated here is one that has actually shipped a wrong artifact:
 *
 *   - a plugin peer floor that lagged core after a core release
 *   - a protocol range that stopped matching after a protocol prerelease
 *   - `bun.lock` workspace entries that `bun install` leaves stale
 *   - a beta that bumped its base version instead of its beta counter
 *   - version-less rmux-bridge lockfile stubs that crash `npm ci` with
 *     `Invalid Version:` once the platform packages exist on the registry
 *
 * Usage:
 *   node ./scripts/release.mjs plan    [--beta|--stable] [--bump patch|minor|major] [--json]
 *   node ./scripts/release.mjs apply   [--beta|--stable] [--bump ...] --yes
 *   node ./scripts/release.mjs check
 *   node ./scripts/release.mjs publish [--skip-gates] --yes
 *
 * `plan` is read-only. `apply` writes the tree and stops so the CHANGELOG prose
 * and the diff can be reviewed. `publish` is irreversible from the first tag
 * push: the tag fires the npm workflow and npm refuses to republish a version.
 *
 * See `docs/release-automation.md`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = await import(pathToFileURL(join(ROOT, "scripts/release-lib.mjs")).href);
const {
  PACKAGE_REGISTRY,
  CHANGELOG_HEADER,
  COMPAT_MANIFEST,
  CORE_FLOOR_TRACKERS,
  RELEASE_ARTIFACTS,
  assignPrsToPackages,
  changelogMaterial,
  collectEdits,
  collectFloorViolations,
  expandReleaseSet,
  gateScope,
  nextVersion,
  packageForPath,
  parseVersion,
  prsForPackages,
  publishWaves,
  renderChangelog,
  rootManifestShipsChanges,
  spliceChangelog,
  tagFor,
} = LIB;

/** Paths this tool is allowed to touch. `publish` sweeps only these. */
const TOOL_OWNED_PATHS = [
  "CHANGELOG.md",
  "package-lock.json",
  "bun.lock",
  "package.json",
  COMPAT_MANIFEST,
  ...PACKAGE_REGISTRY.map((pkg) => pkg.manifestPath),
  ...CORE_FLOOR_TRACKERS.map((id) => `packages/${id}/src/index.ts`),
  "tests/unit/packages/package-metadata.test.ts",
  "tests/unit/packages/channel-relay/channel-relay-plugin.test.ts",
  "tests/unit/packages/channel-feishu/feishu-plugin.test.ts",
  "tests/unit/packages/channel-discord/discord-plugin.test.ts",
  ...PACKAGE_REGISTRY.filter((pkg) => pkg.pluginEntryPath).map((pkg) => pkg.pluginEntryPath),
  "packages/relay-protocol/dist",
  "packages/relay-web/package.json",
];

const REGISTRY_ATTEMPTS = 24;
const REGISTRY_POLL_TIMEOUT_MS = 6 * 60_000;
const REGISTRY_REQUEST_TIMEOUT_MS = 10_000;

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

/**
 * Git output with no trimming.
 *
 * `git()` trims the whole string, which silently eats the leading status space
 * of the FIRST line of `git status --porcelain` (whose lines are `XY PATH`).
 * Anything that parses machine-readable output must use this instead.
 */
function gitRaw(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/**
 * How far this checkout is from origin/main.
 *
 * `apply` writes versions derived from the working tree and `publish` pushes it,
 * so releasing from a stale checkout either computes from superseded manifests or
 * fails at the push — after the gates have spent minutes. Knowing requires a
 * fetch: the local `origin/main` ref is only as fresh as the last one.
 *
 * @returns {{behind:number, ahead:number}|null} null when there is no remote or
 *   git cannot answer (offline). Not knowing is not a reason to block a release.
 */
function originGap() {
  if (git(["remote"], { allowFailure: true }).trim() === "") return null;
  git(["fetch", "origin", "main", "--quiet"], { allowFailure: true });
  const behind = git(["rev-list", "--count", "HEAD..origin/main"], { allowFailure: true }).trim();
  const ahead = git(["rev-list", "--count", "origin/main..HEAD"], { allowFailure: true }).trim();
  if (behind === "" || ahead === "") return null;
  return { behind: Number(behind), ahead: Number(ahead) };
}

/** Refuse to touch the tree when it is behind origin/main. */
function assertUpToDate() {
  const gap = originGap();
  if (!gap || gap.behind === 0) return;
  throw new Error(
    `this checkout is ${gap.behind} commit(s) behind origin/main.`
    + "\nA release reads the working tree, so pull first:"
    + "\n  git pull --ff-only origin main",
  );
}

const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
const writeJson = (relativePath, value) =>
  writeFileSync(join(ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const today = () => new Date().toISOString().slice(0, 10);
const registryEntry = (id) => {
  const entry = PACKAGE_REGISTRY.find((pkg) => pkg.id === id);
  if (!entry) throw new Error(`unknown package: ${id}`);
  return entry;
};

function parseArgs(argv) {
  const options = { command: argv[0] ?? "plan", target: "beta", bump: "patch", json: false, yes: false, skipGates: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--beta") options.target = "beta";
    else if (arg === "--stable") options.target = "stable";
    else if (arg === "--json") options.json = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--new-cycle") options.newCycle = true;
    else if (arg === "--skip-gates") options.skipGates = true;
    else if (arg === "--bump") options.bump = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["patch", "minor", "major"].includes(options.bump)) throw new Error(`--bump must be patch|minor|major`);
  if (!["plan", "notes", "apply", "check", "publish"].includes(options.command)) {
    throw new Error(`unknown command: ${options.command}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Most recent release tag for a package, or "" when it has never shipped. */
function lastTagFor(id) {
  const { tagPrefix } = registryEntry(id);
  return git(["tag", "--list", `${tagPrefix}*`, "--sort=-v:refname"]).split("\n").filter(Boolean)[0] ?? "";
}

/**
 * Commit time of a tag in epoch milliseconds, or undefined when there is none.
 *
 * Used to bound the changelog's PR list: a path *name* can be touched again long
 * after it last shipped, so membership in `changedPaths` says nothing about
 * whether a given PR is inside the window. The tag's time does.
 */
function tagTimeFor(tag) {
  if (!tag) return undefined;
  const seconds = git(["log", "-1", "--format=%ct", tag], { allowFailure: true }).trim();
  return seconds ? Number(seconds) * 1000 : undefined;
}

/**
 * Paths owned by a package that changed since its own last tag.
 *
 * Diffing per package rather than against one shared commit matters: core and
 * relay release on independent cadences, so a shared baseline either misses a
 * package's changes or reports phantom ones.
 */
function changedPathsFor(id) {
  const since = lastTagFor(id);
  const args = since ? ["diff", "--name-only", `${since}..HEAD`] : ["ls-files"];
  let paths = git(args).split("\n").filter(Boolean).filter((path) => packageForPath(path) === id);

  // Root package.json holds both shipped metadata and dev-only script wiring.
  // Only the shipped fields make a core release; adding an npm script does not.
  if (id === "core" && paths.includes("package.json")) {
    const before = since ? manifestAtTag(since, "package.json") : null;
    if (!rootManifestShipsChanges(before, readJson("package.json"))) {
      paths = paths.filter((path) => path !== "package.json");
    }
  }
  return paths;
}

/** Parse a manifest as it existed at a tag, or null when it is absent there. */
function manifestAtTag(tag, relativePath) {
  const raw = git(["show", `${tag}:${relativePath}`], { allowFailure: true });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Whether the given base version was already released as a stable tag. */
function releasedBaseExists(id, base) {
  return git(["tag", "--list", tagFor(id, base)]).length > 0;
}

function buildPlan(options) {
  const current = {};
  const changedPaths = {};
  const changed = [];
  const lastTags = {};

  for (const pkg of PACKAGE_REGISTRY) {
    const manifest = readJson(pkg.manifestPath);
    current[pkg.id] = String(manifest.version ?? "");
    if (!parseVersion(current[pkg.id])) {
      throw new Error(`${pkg.manifestPath}: version ${current[pkg.id]} is not semver`);
    }
    lastTags[pkg.id] = lastTagFor(pkg.id);
    changedPaths[pkg.id] = changedPathsFor(pkg.id);
    if (changedPaths[pkg.id].length > 0) changed.push(pkg.id);
  }

  const { releases: releaseIds, floorTrackers } = expandReleaseSet({ changed });

  // Versions are decided from the ORIGINAL manifests, then written together, so
  // a derived edit (compat mirrors core) has both endpoints available.
  const releases = [];
  const nextVersions = { ...current };
  for (const id of releaseIds) {
    const base = current[id].split("-")[0];
    const to = nextVersion({
      current: current[id],
      target: options.target,
      bump: options.bump,
      newCycle: options.newCycle,
      baseReleased: releasedBaseExists(id, base),
    });
    nextVersions[id] = to;
    releases.push({ id, from: current[id], to, tag: tagFor(id, to) });
  }

  const edits = collectEdits({ releases: releaseIds, versions: nextVersions, previousVersions: current });
  const sinceById = Object.fromEntries(
    Object.entries(lastTags).map(([id, tag]) => [id, tagTimeFor(tag)]).filter(([, ms]) => ms !== undefined),
  );
  const bullets = changelogBullets({ releases, changedPaths, lastTags, sinceById });

  return {
    target: options.target,
    bump: options.bump,
    releases,
    floorTrackers,
    waves: publishWaves(releaseIds),
    edits,
    changedPaths,
    lastTags,
    changelogSource: bullets.source,
    changelogWindows: releases.map((release) => ({
      id: release.id,
      tag: lastTags[release.id] || "",
      // The bound the PR list was filtered by, in UTC — the value an operator
      // would otherwise recompute by hand, timezone bugs included.
      since: sinceById[release.id] === undefined
        ? ""
        : new Date(sinceById[release.id]).toISOString().replace(".000Z", "Z"),
      bullets: (bullets.byPackage[release.id] ?? []).length,
    })),
    changelog: renderChangelog({
      date: today(),
      releases: releases.map((release) => ({
        id: release.id,
        from: release.from,
        to: release.to,
        subjects: bullets.byPackage[release.id] ?? [],
      })),
    }),
  };
}

/**
 * Merged PRs, newest first, or null when `gh` is unavailable.
 *
 * `files` is what makes this useful: it assigns each PR to a package by the
 * same evidence the release uses, so no commit-graph walk is needed. Descriptions
 * are only fetched when asked for — they are large, and only `notes` needs them.
 *
 * @param {{withBody?:boolean}} [options]
 */
function fetchMergedPrs({ withBody = false } = {}) {
  const fields = ["number", "title", "mergedAt", "files"];
  if (withBody) fields.push("body");
  try {
    return JSON.parse(execFileSync(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "200", "--json", fields.join(",")],
      {
        cwd: ROOT,
        encoding: "utf8",
        // Descriptions are ~1.3 MB over 200 PRs, past execFileSync's 1 MiB
        // default. Without this the call throws, the catch below swallows it,
        // and the tool reports "gh is unavailable" while gh is answering fine.
        maxBuffer: 64 * 1024 * 1024,
      },
    ));
  } catch {
    return null;
  }
}

/** Commit subjects that touched the given paths since a ref. */
function subjectsFor(id, since, paths) {
  if (paths.length === 0) return [];
  const args = ["log", "--no-merges", "--pretty=%s"];
  args.push(since ? `${since}..HEAD` : "HEAD");
  args.push("--", ...paths);
  const subjects = git(args, { allowFailure: true }).split("\n").filter(Boolean);
  return [...new Set(subjects)];
}

/**
 * Changelog bullets for every releasing package.
 *
 * Prefers one bullet per merged PR (its title), which is what a squash-merged
 * repo wants; falls back to commit subjects when `gh` is not available. PR
 * bodies are deliberately unused — they run to several paragraphs, and the
 * CHANGELOG's convention is a one-line bullet per change.
 */
function changelogBullets({ releases, changedPaths, lastTags, sinceById }) {
  const byPackage = {};
  const prs = fetchMergedPrs();
  const assigned = prs && prs.length > 0 ? assignPrsToPackages({ prs, changedPaths, sinceById }) : null;
  const sources = new Set();

  for (const release of releases) {
    const fromPrs = assigned?.[release.id] ?? [];
    if (fromPrs.length > 0) {
      byPackage[release.id] = fromPrs;
      sources.add("merged PR titles");
      continue;
    }
    // Per package, not all-or-nothing: a directly pushed commit (or a PR the
    // API has not surfaced yet) still describes its change.
    const fromCommits = subjectsFor(release.id, lastTags[release.id], changedPaths[release.id]);
    byPackage[release.id] = fromCommits;
    if (fromCommits.length > 0) sources.add("commit subjects");
  }

  const source = sources.size === 0 ? "nothing found — write the entry by hand" : [...sources].join(" + ");
  return { source, byPackage };
}

// ---------------------------------------------------------------------------
// Derived-metadata verification
// ---------------------------------------------------------------------------

function readAllManifests() {
  const manifests = {};
  for (const pkg of PACKAGE_REGISTRY) manifests[pkg.manifestPath] = readJson(pkg.manifestPath);
  manifests[COMPAT_MANIFEST] = readJson(COMPAT_MANIFEST);
  manifests["packages/relay-web/package.json"] = readJson("packages/relay-web/package.json");
  for (const id of CORE_FLOOR_TRACKERS) {
    const source = readFileSync(join(ROOT, `packages/${id}/src/index.ts`), "utf8");
    manifests[`${id}:minXacpxVersion`] = /minXacpxVersion:\s*"([^"]+)"/.exec(source)?.[1];
  }
  return manifests;
}

function manifestVersions() {
  const versions = {};
  for (const pkg of PACKAGE_REGISTRY) versions[pkg.id] = readJson(pkg.manifestPath).version;
  return versions;
}

function floorViolations() {
  return collectFloorViolations({ versions: manifestVersions(), manifests: readAllManifests() });
}

// ---------------------------------------------------------------------------
// Plan rendering
// ---------------------------------------------------------------------------

function printPlan(plan) {
  const out = [`target: ${plan.target} (--bump ${plan.bump})`];
  if (plan.releases.length === 0) {
    out.push("", "nothing to release: no package has changes since its last tag.");
    return out.join("\n");
  }
  out.push("", "releases:");
  for (const release of plan.releases) {
    const why = plan.floorTrackers.includes(release.id)
      ? "  (republished so its published floor tracks core)"
      : "";
    out.push(`  ${release.id.padEnd(16)} ${release.from} -> ${release.to}   ${release.tag}${why}`);
  }
  out.push("", "changed since last tag:");
  for (const release of plan.releases) {
    const paths = plan.changedPaths[release.id];
    out.push(`  ${release.id.padEnd(16)} ${plan.lastTags[release.id] || "(no tag)"} -> HEAD, ${paths.length} path(s)`);
    for (const path of paths.slice(0, 6)) out.push(`      ${path}`);
    if (paths.length > 6) out.push(`      … ${paths.length - 6} more`);
  }
  out.push("", "publish waves (sequential inside a wave, wait between waves):");
  for (const [index, wave] of plan.waves.entries()) out.push(`  wave ${index + 1}: ${wave.join(", ")}`);
  out.push("", "pre-flight gate (runs on `publish`, before the commit):");
  out.push("  tsc --noEmit (whole repo) + check");
  const scope = gateScope(plan.releases.map((release) => release.id));
  if (!scope) {
    const unmapped = plan.releases.map((release) => release.id).filter((id) => RELEASE_ARTIFACTS[id] === undefined);
    out.push(`  verify:publish (every package — nothing maps ${unmapped.join(", ")} to a build)`);
  } else {
    for (const script of scope.builds) out.push(`  ${script}`);
    out.push(`  verify-publish --packages ${scope.verifyIds.join(",")}`);
    for (const compile of scope.compiles) {
      out.push(`  compile ${compile.id} (consumes the protocol this release rewrites)`);
    }
  }
  out.push("", "derived edits:");
  for (const edit of plan.edits) {
    if (edit.kind === "script") {
      out.push(`  [script] ${edit.script}  — ${edit.reason}`);
      continue;
    }
    const where = edit.path ? `${edit.file} → ${edit.path.join(".")}` : edit.file;
    out.push(`  [${edit.kind}] ${where}: ${edit.from} -> ${edit.to}`);
    out.push(`      ${edit.reason}`);
  }
  out.push("", "changelog window (bullets are counted from merged PRs after each tag's commit time):");
  for (const entry of plan.changelogWindows) {
    const bound = entry.tag
      ? `${entry.tag} since ${entry.since}`
      : "no previous tag — unbounded";
    out.push(`  ${entry.id.padEnd(16)} ${bound}, ${entry.bullets} bullet${entry.bullets === 1 ? "" : "s"}`);
  }
  out.push("", `changelog draft (source: ${plan.changelogSource}; review and edit before publishing):`, "", plan.changelog);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function applyEdits(plan) {
  const applied = [];
  for (const edit of plan.edits) {
    if (edit.kind === "script") continue;
    const absolute = join(ROOT, edit.file);
    if (!existsSync(absolute)) throw new Error(`edit target missing: ${edit.file}`);

    if (edit.kind === "json-value") {
      const json = readJson(edit.file);
      let cursor = json;
      for (const key of edit.path.slice(0, -1)) {
        cursor = cursor?.[key];
        if (!cursor) throw new Error(`${edit.file}: ${edit.path.join(".")} does not exist`);
      }
      const leaf = edit.path.at(-1);
      if (cursor[leaf] !== edit.from) {
        throw new Error(`${edit.file}: ${edit.path.join(".")} is ${cursor[leaf]}, expected ${edit.from}`);
      }
      cursor[leaf] = edit.to;
      writeJson(edit.file, json);
      applied.push(`${edit.file} ${edit.path.join(".")}`);
      continue;
    }

    if (edit.kind === "text-replace-all") {
      const source = readFileSync(absolute, "utf8");
      if (!source.includes(edit.from)) throw new Error(`${edit.file}: expected text not found: ${edit.from}`);
      writeFileSync(absolute, source.replaceAll(edit.from, edit.to), "utf8");
      applied.push(`${edit.file} (${edit.from} -> ${edit.to})`);
      continue;
    }

    throw new Error(`unknown edit kind: ${edit.kind}`);
  }
  return applied;
}

function prependChangelog(plan) {
  const path = join(ROOT, "CHANGELOG.md");
  const current = readFileSync(path, "utf8");
  const hadUnreleased = current.slice(CHANGELOG_HEADER.length).replace(/^\n+/, "").startsWith("## [Unreleased]");
  writeFileSync(
    path,
    spliceChangelog({ current, releases: plan.releases, date: today(), draft: plan.changelog }),
    "utf8",
  );
  console.log(
    hadUnreleased
      ? "CHANGELOG.md: relabelled the top [Unreleased] section and added headings for the other packages"
      : "CHANGELOG.md: inserted a draft section — review the prose before publishing",
  );
}

/**
 * The material for a CHANGELOG entry: the descriptions of this release's PRs.
 *
 * `plan` drafts one line per PR, which is enough to see what shipped and not
 * enough to write why it mattered. This prints the other half, pre-filtered to
 * the window and grouped per package, so the writer never has to go looking
 * through PRs one at a time.
 */
function cmdNotes(plan) {
  if (plan.releases.length === 0) {
    console.log("nothing to release: no package has changes since its last tag");
    return 0;
  }
  const prs = fetchMergedPrs({ withBody: true });
  if (!prs || prs.length === 0) {
    console.log("gh returned no merged PRs, so there are no descriptions to show.");
    console.log("Write the entry from the commit subjects in the `plan` draft.");
    return 0;
  }
  const sinceById = Object.fromEntries(
    plan.changelogWindows
      .filter((window) => window.since !== "")
      .map((window) => [window.id, Date.parse(window.since)]),
  );
  const changedPaths = Object.fromEntries(
    plan.releases.map((release) => [release.id, plan.changedPaths[release.id]]),
  );
  const byPackage = prsForPackages({ prs, changedPaths, sinceById });

  for (const release of plan.releases) {
    const list = byPackage[release.id] ?? [];
    console.log(`\n${"═".repeat(78)}`);
    console.log(`${release.id} ${release.to} — ${list.length} PR(s) in the window`);
    console.log("═".repeat(78));
    if (list.length === 0) {
      console.log("no merged PR here, so the draft fell back to commit subjects");
      continue;
    }
    for (const pr of list) {
      const material = changelogMaterial(pr.body);
      console.log(`\n#${pr.number} ${pr.title}`);
      console.log(material === "" ? "(this PR body has no description, only verification)" : material);
    }
  }
  console.log("\nRaw material, not a draft: the entry is one line per user-visible change, in the file's own voice.");
  return 0;
}

function cmdApply(plan, options) {
  if (plan.releases.length === 0) {
    console.log("nothing to release");
    return 0;
  }
  assertUpToDate();
  // A manifest already carrying an unreleased version means a previous apply has
  // not been published yet. Applying again would compute the NEXT version from
  // it and burn a number nobody ships.
  const pending = buildPublishPlan().releases;
  if (pending.length > 0 && !options.force) {
    throw new Error(
      `the tree already carries an unreleased bump (${pending.map((r) => `${r.id} ${r.to}`).join(", ")}).\n`
      + "Run `publish`, or revert those paths and re-plan. Pass --force to bump past them.",
    );
  }
  console.log(printPlan(plan));
  if (!options.yes) {
    console.error("\nrefusing to write without --yes (edits manifests, tests, lockfiles, CHANGELOG.md)");
    return 1;
  }
  for (const line of applyEdits(plan)) console.log(`edited ${line}`);

  if (plan.releases.some((release) => release.id === "channel-relay")) {
    execFileSync("node", [join(ROOT, "scripts", "sync-rmux-bridge-versions.mjs")], { cwd: ROOT, stdio: "inherit" });
  }
  syncLockfiles();

  // Post-conditions, not intentions: if an edit landed wrong, fail here rather
  // than at tag-push time.
  const violations = floorViolations();
  if (violations.length > 0) {
    for (const violation of violations) console.error(`drift after apply: ${violation}`);
    return 1;
  }
  prependChangelog(plan);
  console.log("\napplied. review CHANGELOG.md and the diff, then run `publish`.");
  return 0;
}

// ---------------------------------------------------------------------------
// Lockfiles
// ---------------------------------------------------------------------------

/**
 * npm rewrites package-lock.json correctly except for the rmux-bridge optional
 * stubs. Those degrade to `{ optional: true }` for a version npm cannot resolve
 * yet, and that shape then crashes `npm ci` with `Invalid Version:` once the
 * platform packages are on the registry. Giving the stub an explicit version is
 * valid in both states.
 *
 * `bun install` is still run for the dependency graph, but it does not rewrite
 * the `workspaces` block, so that block is reconciled from the manifests.
 */
function syncLockfiles() {
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("bun", ["install"], { cwd: ROOT, stdio: "inherit" });

  const lockPath = join(ROOT, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const stubVersion = readJson("packages/channel-relay/package.json").version;
  let pinned = 0;
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!key.includes("rmux-bridge") || key.includes("platform-packages")) continue;
    if (typeof value.version === "string" && value.version.length > 0) continue;
    lock.packages[key] = { optional: true, version: stubVersion };
    pinned += 1;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  if (pinned > 0) console.log(`pinned ${pinned} version-less rmux-bridge lockfile stub(s) to ${stubVersion}`);

  reconcileBunLock();
}

/**
 * Rewrite bun.lock's `workspaces` block from the manifests.
 *
 * Textual, not structural: bun.lock is JSON-with-trailing-commas and parsing it
 * would reformat the whole file. Every replacement is bounded to one workspace
 * block, found by its `"packages/<dir>": {` key and its closing `\n    },`, so a
 * dependency range outside that block can never be hit.
 */
function reconcileBunLock() {
  const bunPath = join(ROOT, "bun.lock");
  let source = readFileSync(bunPath, "utf8");
  const notes = [];

  const eachWorkspaceBlock = (dir, transform) => {
    const start = source.indexOf(`    "${dir}": {`);
    if (start === -1) return;
    const end = source.indexOf("\n    },", start);
    const block = source.slice(start, end === -1 ? undefined : end);
    const updated = transform(block);
    if (updated === block) return;
    source = source.slice(0, start) + updated + source.slice(start + block.length);
  };

  for (const pkg of PACKAGE_REGISTRY) {
    if (pkg.id === "core") continue; // the root workspace carries no version
    const dir = pkg.manifestPath.replace(/\/package\.json$/, "");
    const { version, name } = readJson(pkg.manifestPath);
    eachWorkspaceBlock(dir, (block) => {
      if (!block.includes(`"name": "${name}"`)) return block;
      const updated = block.replace(/"version": "[^"]+"/, `"version": "${version}"`);
      if (updated !== block) notes.push(`${dir} version -> ${version}`);
      return updated;
    });
  }

  for (const dir of ["packages/relay", "packages/relay-web", "packages/channel-relay"]) {
    const range = readJson(`${dir}/package.json`).dependencies?.["@ganglion/xacpx-relay-protocol"];
    if (!range) continue;
    eachWorkspaceBlock(dir, (block) => {
      const updated = block.replace(
        /"@ganglion\/xacpx-relay-protocol": "[^"]+"/,
        `"@ganglion/xacpx-relay-protocol": "${range}"`,
      );
      if (updated !== block) notes.push(`${dir} protocol range -> ${range}`);
      return updated;
    });
  }

  const floor = readJson("package.json").version;
  for (const id of CORE_FLOOR_TRACKERS) {
    eachWorkspaceBlock(`packages/${id}`, (block) => {
      const updated = block.replace(/"xacpx": ">=[^"]+"/, `"xacpx": ">=${floor}"`);
      if (updated !== block) notes.push(`packages/${id} peer floor -> >=${floor}`);
      return updated;
    });
  }

  writeFileSync(bunPath, source, "utf8");
  for (const note of notes) console.log(`bun.lock: ${note}`);
  if (notes.length === 0) console.log("bun.lock: already reconciled");
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function cmdCheck() {
  const violations = floorViolations();

  const lock = readJson("package-lock.json");
  const versionless = Object.entries(lock.packages)
    .filter(([key, entry]) => key.includes("rmux-bridge") && !key.includes("platform-packages"))
    .filter(([, entry]) => typeof entry.version !== "string" || entry.version.length === 0)
    .map(([key]) => key);
  for (const key of versionless) violations.push(`package-lock.json: ${key} has no version (breaks npm ci)`);

  if (violations.length === 0) {
    console.log("release metadata is consistent");
    return 0;
  }
  for (const violation of violations) console.error(`drift: ${violation}`);
  return 1;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

/**
 * Verify that the working tree may be committed as this release.
 *
 * Returns true when the tree is already clean. That is the resume case: a
 * previous run committed these bumps and stopped before tagging everything (a
 * wave whose versions had not appeared on the registry yet), so there is nothing
 * to apply, nothing to sweep, and the run goes straight to the tags.
 *
 * Otherwise every modified path must belong to this tool, so unrelated work in
 * progress cannot be swept into the release commit.
 */
function assertReleaseTreeIsSweepable() {
  // `-z` keeps paths verbatim and, with --no-renames, emits exactly one record
  // per entry — so the parse cannot be thrown off by a rename's second field.
  const dirty = dirtyPaths();
  if (dirty.length === 0) return true;
  const unexpected = dirty.filter(
    (path) => !TOOL_OWNED_PATHS.some((owned) => path === owned || path.startsWith(`${owned}/`)),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `refusing to publish: unrelated modified paths would be swept into the release commit:\n  ${unexpected.join("\n  ")}`,
    );
  }
  return false;
}

/** Modified paths in the working tree, one per entry. */
function dirtyPaths() {
  return gitRaw(["status", "--porcelain", "-z", "--no-renames"])
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(3));
}

/**
 * Rebuild noise: `verify:publish` re-runs `build:relay-protocol`, and bun's
 * bundler sometimes renames a local, producing a 3-line diff in a tracked file.
 * When relay-protocol is not part of this release there is no source change to
 * ship, so that diff is pure churn and gets reverted.
 */
function dropProtocolDistChurn(plan) {
  if (plan.releases.some((release) => release.id === "relay-protocol")) return;
  if (!git(["diff", "--name-only", "--", "packages/relay-protocol/dist"])) return;
  git(["checkout", "--", "packages/relay-protocol/dist"]);
  console.log("reverted build-only churn in packages/relay-protocol/dist");
}

/**
 * The pre-flight gate, sized to the release.
 *
 * Root typecheck and metadata checks always run. The artifact gate is scoped:
 * only packages in this release are built and packed, plus protocol consumers
 * are compiled whenever the protocol ships. An unmapped release id falls back
 * to the unscoped `verify:publish` gate.
 */
function runGates(plan) {
  console.log("== gates: typecheck ==");
  execFileSync("bun", ["x", "tsc", "--noEmit"], { cwd: ROOT, stdio: "inherit" });
  console.log("== gates: metadata ==");
  execFileSync("node", [join(ROOT, "scripts", "release.mjs"), "check"], { cwd: ROOT, stdio: "inherit" });

  const ids = plan.releases.map((release) => release.id);
  const scope = gateScope(ids);
  if (!scope) {
    const unmapped = ids.filter((id) => RELEASE_ARTIFACTS[id] === undefined);
    console.log(`== gates: artifacts (every package — no artifact mapping for ${unmapped.join(", ")}) ==`);
    execFileSync("bun", ["run", "verify:publish"], { cwd: ROOT, stdio: "inherit" });
    return;
  }
  console.log(`== gates: artifacts (${ids.join(", ")}) ==`);
  for (const script of scope.builds) {
    execFileSync("bun", ["run", script], { cwd: ROOT, stdio: "inherit" });
  }
  execFileSync(
    "node",
    [join(ROOT, "scripts", "verify-publish.mjs"), "--packages", scope.verifyIds.join(",")],
    { cwd: ROOT, stdio: "inherit" },
  );
  for (const compile of scope.compiles) {
    // Only reachable on a protocol release: these consumers are not shipping,
    // but this release rewrites the protocol range they compile against.
    console.log(`  compiling ${compile.id}, which installs the protocol this release publishes`);
    execFileSync(compile.command, compile.args, {
      cwd: join(ROOT, compile.cwd ?? "."),
      stdio: "inherit",
    });
  }
}

/**
 * The release set as it stands in the APPLIED tree.
 *
 * `publish` must not re-derive versions: `apply` already bumped every manifest,
 * so re-running the version policy would propose a second bump (the manifest is
 * at `-beta.5`, so the "next" beta is `-beta.6`) and then refuse its own work.
 * Instead, read what is pending off the tags — a manifest whose version has no
 * tag yet, and which differs from the newest tag for its package, is exactly a
 * release waiting to be pushed.
 */
function buildPublishPlan() {
  const releases = [];
  for (const pkg of PACKAGE_REGISTRY) {
    const version = String(readJson(pkg.manifestPath).version ?? "");
    const lastTag = lastTagFor(pkg.id);
    if (lastTag === tagFor(pkg.id, version)) continue; // already released
    const from = lastTag ? lastTag.slice(pkg.tagPrefix.length) : "";
    if (from === version) continue; // tag exists under a different prefix shape
    releases.push({ id: pkg.id, from, to: version, tag: tagFor(pkg.id, version) });
  }
  return { releases, waves: publishWaves(releases.map((release) => release.id)) };
}

/** Tag -> the publish workflow run it triggered, or null. */
function findRunForTag(tag) {
  let runs;
  try {
    runs = JSON.parse(execFileSync(
      "gh",
      ["run", "list", "--limit", "30", "--json", "databaseId,headBranch,status,conclusion,name"],
      { cwd: ROOT, encoding: "utf8" },
    ));
  } catch {
    return undefined; // gh unavailable; distinguished from "no run yet"
  }
  return runs.find((run) => run.headBranch === tag) ?? null;
}

/**
 * Wait for one tag's publish workflow.
 *
 * A tag push is the normal trigger. It can silently produce no run (GitHub
 * drops some multi-tag push events), so a missing run is reported rather than
 * treated as success — the operator re-pushes that tag. Give the run a window
 * to register first: querying immediately after the push returns nothing and
 * would send the operator off to re-push a tag that is already publishing.
 */
async function awaitTagRun(tag) {
  let run = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const found = findRunForTag(tag);
    if (found === undefined) {
      console.log(`  (could not query workflow runs for ${tag}; check \`gh run list\`)`);
      return;
    }
    if (found) {
      run = found;
      break;
    }
    await sleep(5_000);
  }
  if (!run) {
    console.log(`  ${tag}: still no workflow run. Re-push it: git push origin ${tag}`);
    return;
  }
  console.log(`  ${run.name} ${run.status}${run.conclusion ? ` ${run.conclusion}` : ""}`);
  while (run.status === "queued" || run.status === "in_progress") {
    await sleep(20_000);
    const refreshed = JSON.parse(execFileSync(
      "gh",
      ["run", "view", String(run.databaseId), "--json", "status,conclusion"],
      { cwd: ROOT, encoding: "utf8" },
    ));
    run.status = refreshed.status;
    run.conclusion = refreshed.conclusion;
  }
  console.log(`  ${run.name} completed ${run.conclusion}`);
  if (run.conclusion !== "success") {
    throw new Error(
      `${tag}: publish run concluded ${run.conclusion}. See docs/release-automation.md for the recovery playbook.`,
    );
  }
}

/**
 * Wait for a released version to appear on the registry, then report its tag.
 *
 * The dedicated dist-tags endpoint keeps its own cache and updates first: on
 * 0.14.12-beta.7 the packument still served the previous tag a minute after
 * this endpoint was current, and minutes after the version document resolved.
 * Polling `npm view` is how a finished release gets misread as a failed one.
 *
 * An unconfirmed registry stops later waves without treating an already
 * published version as a failed publish. The deadline includes response bodies
 * and retry delays.
 */
async function reportRegistry(npmName, version) {
  const url = `https://registry.npmjs.org/-/package/${npmName.replace("/", "%2F")}/dist-tags`;
  const deadline = performance.now() + REGISTRY_POLL_TIMEOUT_MS;
  for (let attempt = 1; attempt <= REGISTRY_ATTEMPTS; attempt += 1) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    try {
      const response = await fetch(url, {
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(Math.min(REGISTRY_REQUEST_TIMEOUT_MS, remaining)),
      });
      if (response.ok) {
        const tags = await response.json();
        const live = Object.entries(tags).find(([, tagged]) => tagged === version);
        if (live) {
          console.log(`  ${npmName}@${version} is live on npm (dist-tag: ${live[0]})`);
          return true;
        }
      }
    } catch {
      // A transient failure means the same thing as "not yet": keep waiting.
    }
    const delay = Math.min(15_000, deadline - performance.now());
    if (attempt < REGISTRY_ATTEMPTS && delay > 0) await sleep(delay);
  }
  console.warn(`  ${npmName}@${version} is not visible yet — re-check ${url} before assuming the publish failed`);
  return false;
}

async function cmdPublish(plan, options) {
  if (plan.releases.length === 0) {
    console.log("nothing to release: no manifest carries an unreleased version (run `apply` first)");
    return 0;
  }

  // Printed before the --yes gate so `publish` without it doubles as a dry run
  // of exactly what the applied tree would push.
  console.log(`${plan.releases.length} package(s) pending from the applied tree:`);
  for (const release of plan.releases) {
    console.log(`  ${release.id.padEnd(16)} ${release.from} -> ${release.to}   ${release.tag}`);
  }
  for (const [index, wave] of plan.waves.entries()) {
    console.log(`  wave ${index + 1}: ${wave.join(", ")}`);
  }

  if (!options.yes) {
    console.error("\nrefusing to publish without --yes (this pushes main and irreversible tags)");
    return 1;
  }
  const branch = git(["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`on branch ${branch}; releases are tagged from main`);
  // Before the gates, not after: catching this at `git push` costs the gates.
  assertUpToDate();

  for (const release of plan.releases) {
    if (git(["tag", "--list", release.tag])) throw new Error(`tag ${release.tag} already exists`);
    if (readJson(registryEntry(release.id).manifestPath).version !== release.to) {
      throw new Error(`${release.id}: manifest is not ${release.to}; run \`apply\` first`);
    }
  }
  const resuming = assertReleaseTreeIsSweepable();
  if (resuming) {
    console.log("working tree is clean: these bumps are already committed, so this run resumes at the tags");
  }

  if (!options.skipGates) runGates(plan);
  dropProtocolDistChurn(plan);

  const subject = `release: ${plan.releases.map((release) => `${release.id} ${release.to}`).join(" / ")}`;
  if (resuming) {
    // Nothing to commit, so the tags must not point at a tree the gates left
    // altered: that would publish something other than what was verified.
    const leftover = dirtyPaths();
    if (leftover.length > 0) {
      throw new Error(
        `resuming, but the gates left ${leftover.length} path(s) modified.`
        + "\nCommit or discard them first — the tags would otherwise point at a tree that was not verified:"
        + `\n  ${leftover.join("\n  ")}`,
      );
    }
    const needsProtocol = plan.releases.some((release) => ["relay", "channel-relay"].includes(release.id));
    if (needsProtocol && !plan.releases.some((release) => release.id === "relay-protocol")) {
      const protocol = registryEntry("relay-protocol");
      const version = readJson(protocol.manifestPath).version;
      if (!await reportRegistry(protocol.npmName, version)) {
        console.log("Stopped before pushing tags: the preceding protocol wave is still unconfirmed.");
        console.log("Re-check the registry URL above, then re-run `publish --yes` once it is visible.");
        return 1;
      }
    }
  } else {
    git(["add", "-A"]);
    git(["commit", "-m", subject]);
  }
  const head = git(["rev-parse", "HEAD"]);
  git(["push", "origin", "main"]);
  console.log(resuming ? `tagging the existing commit ${head}` : `committed ${head}`);

  // Wave by wave. Nothing in a later wave may be pushed before the earlier
  // wave's packages resolve from the registry, or its smoke steps fail with
  // `ETARGET No matching version found`. That is why an unconfirmed wave stops
  // the run rather than being reported at the very end: continuing would push a
  // tag whose workflow installs a package that is not there yet.
  for (const [index, wave] of plan.waves.entries()) {
    console.log(`\n== wave ${index + 1}: ${wave.join(", ")} ==`);
    const pushed = [];
    for (const id of wave) {
      const release = plan.releases.find((candidate) => candidate.id === id);
      // relay and channel-relay share a wave but go one at a time: both are
      // heavy ubuntu jobs and concurrent dispatch invites runner contention.
      git(["tag", release.tag, head]);
      try {
        git(["push", "origin", release.tag]);
      } catch (error) {
        // A local tag makes the next `buildPublishPlan()` treat the package as
        // released, so it must not survive a push that never reached the
        // remote. `ls-remote --exit-code` exits non-zero when the tag is
        // absent, which `git()` turns into "" — but if the remote DOES have
        // it (GitHub accepted the push and the error came after), the tag
        // stays and recovery is a re-push, not a re-tag.
        const remoteTag = git(["ls-remote", "--tags", "--exit-code", "origin", release.tag], { allowFailure: true });
        if (remoteTag === "") {
          git(["tag", "--delete", release.tag]);
          throw new Error(
            `push of ${release.tag} failed and the remote has no such tag;`
            + " deleted the local tag so the next run re-tags this package."
            + ` Original error: ${error.message}`,
          );
        }
        throw error;
      }
      console.log(`pushed ${release.tag}`);
      await awaitTagRun(release.tag);
      pushed.push({ npmName: registryEntry(id).npmName, version: release.to });
    }
    // Poll the wave together: its packages publish in parallel, so waiting for
    // them one after another adds up their propagation delays for nothing.
    const confirmed = await Promise.all(
      pushed.map(async (pkg) => ({ ...pkg, ok: await reportRegistry(pkg.npmName, pkg.version) })),
    );
    const missing = confirmed.filter((entry) => !entry.ok);
    if (missing.length > 0) {
      console.log(`\nstopped after wave ${index + 1}: ${missing.length} version(s) are not visible on npm yet.`);
      console.log("The workflows reported success, so this is propagation, not a failed publish:");
      for (const entry of missing) {
        console.log(`  curl -s https://registry.npmjs.org/-/package/${entry.npmName.replace("/", "%2F")}/dist-tags`);
      }
      const remaining = plan.waves.slice(index + 1).flat();
      if (remaining.length > 0) {
        console.log(`\nNot pushed: ${remaining.join(", ")} — their workflows install the packages above.`);
        console.log("Once those are visible, re-run `publish --yes`: the pending set is read from tags, so");
        console.log("everything already tagged drops out and the run resumes where it stopped.");
      }
      return 1;
    }
  }

  console.log("\nall tags pushed; every released version is live on npm.");
  return 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "check") process.exit(cmdCheck());

  // `publish` reads the tree `apply` produced; everything else computes a fresh
  // plan from the tags.
  if (options.command === "publish") {
    process.exit(await cmdPublish(buildPublishPlan(), options));
  }

  const plan = buildPlan(options);
  if (options.command === "notes") process.exit(cmdNotes(plan));
  if (options.command === "plan") {
    const gap = originGap();
    if (gap && gap.behind > 0) {
      console.log(`warning: this checkout is ${gap.behind} commit(s) behind origin/main`
        + " — the plan reads the local tree, so pull before applying.\n");
    }
    console.log(options.json ? JSON.stringify(plan, null, 2) : printPlan(plan));
    process.exit(0);
  }
  process.exit(cmdApply(plan, options));
}

main().catch((error) => {
  console.error(`release: ${error.message}`);
  process.exit(1);
});
