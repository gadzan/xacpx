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
  collectEdits,
  collectFloorViolations,
  expandReleaseSet,
  nextVersion,
  packageForPath,
  parseVersion,
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

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
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
    else if (arg === "--skip-gates") options.skipGates = true;
    else if (arg === "--bump") options.bump = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["patch", "minor", "major"].includes(options.bump)) throw new Error(`--bump must be patch|minor|major`);
  if (!["plan", "apply", "check", "publish"].includes(options.command)) {
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
      baseReleased: releasedBaseExists(id, base),
    });
    nextVersions[id] = to;
    releases.push({ id, from: current[id], to, tag: tagFor(id, to) });
  }

  const edits = collectEdits({ releases: releaseIds, versions: nextVersions, previousVersions: current });

  return {
    target: options.target,
    bump: options.bump,
    releases,
    floorTrackers,
    waves: publishWaves(releaseIds),
    edits,
    changedPaths,
    lastTags,
    changelog: renderChangelog({
      date: today(),
      releases: releases.map((release) => ({
        id: release.id,
        from: release.from,
        to: release.to,
        subjects: subjectsFor(release.id, lastTags[release.id], changedPaths[release.id]),
      })),
    }),
  };
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
  out.push("", "changelog draft (review and edit before publishing):", "", plan.changelog);
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

function cmdApply(plan, options) {
  if (plan.releases.length === 0) {
    console.log("nothing to release");
    return 0;
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

function assertOnlyReleasePathsModified(plan) {
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  const unexpected = [];
  for (const line of dirty) {
    const path = line.slice(3).trim().replace(/^"|"$/g, "");
    if (TOOL_OWNED_PATHS.some((owned) => path === owned || path.startsWith(`${owned}/`))) continue;
    unexpected.push(path);
  }
  if (unexpected.length > 0) {
    throw new Error(
      `refusing to publish: unrelated modified paths would be swept into the release commit:\n  ${unexpected.join("\n  ")}`,
    );
  }
  const expected = plan.releases.length + 1; // manifests + CHANGELOG, at minimum
  if (dirty.length === 0) throw new Error("nothing modified; run `apply` first");
  void expected;
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

function runGates() {
  console.log("== gates: typecheck ==");
  execFileSync("bun", ["x", "tsc", "--noEmit"], { cwd: ROOT, stdio: "inherit" });
  console.log("== gates: metadata + publishability ==");
  execFileSync("node", [join(ROOT, "scripts", "release.mjs"), "check"], { cwd: ROOT, stdio: "inherit" });
  execFileSync("bun", ["run", "verify:publish"], { cwd: ROOT, stdio: "inherit" });
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
    return null;
  }
  return runs.find((run) => run.headBranch === tag) ?? null;
}

/**
 * Wait for one tag's publish workflow.
 *
 * A tag push is the normal trigger. It can silently produce no run (GitHub
 * drops some multi-tag push events), so a missing run is reported rather than
 * treated as success — the operator re-pushes that tag.
 */
async function awaitTagRun(tag) {
  let run = findRunForTag(tag);
  if (!run) {
    console.log(`  ${tag}: no workflow run found. Re-push the tag: git push origin ${tag}`);
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

async function cmdPublish(plan, options) {
  if (plan.releases.length === 0) {
    console.log("nothing to release");
    return 0;
  }
  if (!options.yes) {
    console.error("refusing to publish without --yes");
    return 1;
  }
  const branch = git(["branch", "--show-current"]);
  if (branch !== "main") throw new Error(`on branch ${branch}; releases are tagged from main`);

  for (const release of plan.releases) {
    if (git(["tag", "--list", release.tag])) throw new Error(`tag ${release.tag} already exists`);
    if (readJson(registryEntry(release.id).manifestPath).version !== release.to) {
      throw new Error(`${release.id}: manifest is not ${release.to}; run \`apply\` first`);
    }
  }
  assertOnlyReleasePathsModified(plan);

  if (!options.skipGates) runGates();
  dropProtocolDistChurn(plan);

  const subject = `release: ${plan.releases.map((release) => `${release.id} ${release.to}`).join(" / ")}`;
  git(["add", "-A"]);
  git(["commit", "-m", subject]);
  const head = git(["rev-parse", "HEAD"]);
  for (const release of plan.releases) git(["tag", release.tag, head]);
  git(["push", "origin", "main"]);
  console.log(`committed ${head}`);

  // Wave by wave. Nothing in a later wave may be pushed before the earlier
  // wave's packages resolve from the registry, or its smoke steps fail with
  // `ETARGET No matching version found`.
  for (const [index, wave] of plan.waves.entries()) {
    console.log(`\n== wave ${index + 1}: ${wave.join(", ")} ==`);
    for (const id of wave) {
      const release = plan.releases.find((candidate) => candidate.id === id);
      // relay and channel-relay share a wave but go one at a time: both are
      // heavy ubuntu jobs and concurrent dispatch invites runner contention.
      git(["push", "origin", release.tag]);
      console.log(`pushed ${release.tag}`);
      await awaitTagRun(release.tag);
    }
  }

  console.log("\nall tags pushed. verify the registry next:");
  for (const release of plan.releases) {
    console.log(`  npm view ${registryEntry(release.id).npmName} dist-tags`);
  }
  return 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "check") process.exit(cmdCheck());

  const plan = buildPlan(options);
  if (options.command === "plan") {
    console.log(options.json ? JSON.stringify(plan, null, 2) : printPlan(plan));
    process.exit(0);
  }
  if (options.command === "apply") process.exit(cmdApply(plan, options));
  process.exit(await cmdPublish(plan, options));
}

main().catch((error) => {
  console.error(`release: ${error.message}`);
  process.exit(1);
});
