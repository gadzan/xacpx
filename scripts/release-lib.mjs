/**
 * Pure planning logic for coordinated releases.
 *
 * Everything here is a function of its arguments — no git, no filesystem, no
 * network — so the version policy and the derived-metadata table can be unit
 * tested directly. `scripts/release.mjs` supplies the git/file reads and the
 * writes; `docs/release-automation.md` documents the contract.
 *
 * The table below is the single source of truth for "which paths belong to
 * which published package". It has to stay in sync with the publish workflows
 * under `.github/workflows/publish-*.yml`.
 */

/** @typedef {"core"|"relay-protocol"|"relay"|"channel-relay"|"channel-feishu"|"channel-discord"|"channel-yuanbao"} PackageId */

/**
 * Published packages, in publish-dependency order.
 *
 * `sourcePaths` are repo-relative POSIX prefixes that make the package stale.
 * Docs and tests are deliberately excluded: neither changes shipped bytes, and
 * a release for them is noise.
 */
export const PACKAGE_REGISTRY = [
  {
    id: "relay-protocol",
    npmName: "@ganglion/xacpx-relay-protocol",
    tagPrefix: "relay-protocol-v",
    manifestPath: "packages/relay-protocol/package.json",
    sourcePaths: ["packages/relay-protocol/src/", "packages/relay-protocol/dist/"],
    // Zero runtime deps, and relay + channel-relay install it, so it must be on
    // npm before either of them starts.
    wave: 1,
  },
  {
    id: "relay",
    npmName: "@ganglion/xacpx-relay",
    tagPrefix: "relay-v",
    manifestPath: "packages/relay/package.json",
    // relay-web is private and bundled into relay at build time, so its changes
    // ship as a relay release.
    sourcePaths: ["packages/relay/src/", "packages/relay-web/src/", "packages/relay-web/public/", "packages/relay-web/assets/"],
    wave: 2,
  },
  {
    id: "channel-relay",
    npmName: "@ganglion/xacpx-channel-relay",
    tagPrefix: "channel-relay-v",
    manifestPath: "packages/channel-relay/package.json",
    sourcePaths: ["packages/channel-relay/src/"],
    pluginEntryPath: "packages/channel-relay/src/index.ts",
    wave: 2,
  },
  {
    id: "core",
    npmName: "@ganglion/xacpx",
    tagPrefix: "v",
    manifestPath: "package.json",
    sourcePaths: ["src/", "patches/"],
    wave: 3,
  },
  {
    id: "channel-feishu",
    npmName: "@ganglion/xacpx-channel-feishu",
    tagPrefix: "channel-feishu-v",
    manifestPath: "packages/channel-feishu/package.json",
    sourcePaths: ["packages/channel-feishu/src/"],
    pluginEntryPath: "packages/channel-feishu/src/index.ts",
    wave: 3,
  },
  {
    id: "channel-discord",
    npmName: "@ganglion/xacpx-channel-discord",
    tagPrefix: "channel-discord-v",
    manifestPath: "packages/channel-discord/package.json",
    sourcePaths: ["packages/channel-discord/src/"],
    pluginEntryPath: "packages/channel-discord/src/index.ts",
    wave: 3,
  },
  {
    id: "channel-yuanbao",
    npmName: "@ganglion/xacpx-channel-yuanbao",
    tagPrefix: "channel-yuanbao-v",
    manifestPath: "packages/channel-yuanbao/package.json",
    sourcePaths: ["packages/channel-yuanbao/src/"],
    wave: 3,
  },
];

/**
 * Per-package build script and publish-verification id.
 *
 * `publish`'s pre-flight gate needs to build and verify only the packages this
 * release ships. A package outside the release set owns no changed path (that
 * is what put it outside the set), so its artifact is the same one already on
 * npm — rebuilding it verifies a byte stream nobody is about to publish, while
 * the shipping packages are still built and verified in full. The unscoped
 * `verify:publish` still runs in the publish workflow before `npm publish`, so
 * nothing ships on the strength of this scope alone.
 */
export const RELEASE_ARTIFACTS = {
  core: { build: "build", verifyId: "root" },
  "relay-protocol": { build: "build:relay-protocol", verifyId: "relay-protocol" },
  relay: { build: "build:relay", verifyId: "relay" },
  "channel-relay": { build: "build:channel-relay", verifyId: "channel-relay" },
  "channel-feishu": { build: "build:channel-feishu", verifyId: "channel-feishu" },
  "channel-discord": { build: "build:channel-discord", verifyId: "channel-discord" },
  "channel-yuanbao": { build: "build:channel-yuanbao", verifyId: "channel-yuanbao" },
};

/**
 * Builds and verification ids for a release set, or null when any id is
 * unmapped.
 *
 * Null means "run the unscoped gate": a package this map cannot describe is one
 * whose artifact cannot be assumed unchanged, and guessing there would trade a
 * minute of build time for a publish that fails after the tag exists.
 *
 * @param {string[]} releaseIds
 * @returns {{builds:string[], verifyIds:string[]}|null}
 */
export function gateScope(releaseIds) {
  const specs = releaseIds.map((id) => RELEASE_ARTIFACTS[id]);
  if (specs.some((spec) => spec === undefined)) return null;
  return {
    builds: specs.map((spec) => spec.build),
    verifyIds: specs.map((spec) => spec.verifyId),
  };
}

/**
 * Plugins that pin `minXacpxVersion` and `peerDependencies.xacpx` to the exact
 * core release they were verified against.
 *
 * They statically import runtime named exports from `xacpx/plugin-api`, which
 * ESM resolves during linking — before the plugin's default export (and so
 * before `minXacpxVersion`'s runtime check) ever runs. The published floor is
 * the only guard, so it must track core on every core release.
 *
 * `channel-yuanbao` is deliberately absent: its floor is `0.17.0` and it does
 * not import the newer runtime exports.
 */
export const CORE_FLOOR_TRACKERS = ["channel-relay", "channel-feishu", "channel-discord"];

/** Files whose contents mirror a package version. */
export const COMPAT_MANIFEST = "weacpx-compat/package.json";

/** Every consumer whose protocol dependency range must equal the protocol version. */
export const PROTOCOL_CONSUMERS = ["relay", "relay-web", "channel-relay"];

/** Files carrying the core-floor literals that must move with a core release. */
export const CORE_FLOOR_TEST_FILES = {
  "channel-relay": "tests/unit/packages/channel-relay/channel-relay-plugin.test.ts",
  "channel-feishu": "tests/unit/packages/channel-feishu/feishu-plugin.test.ts",
  "channel-discord": "tests/unit/packages/channel-discord/discord-plugin.test.ts",
};

export const METADATA_TEST_FILE = "tests/unit/packages/package-metadata.test.ts";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const BETA = /^beta\.(\d+)$/;

/**
 * @param {string} value
 * @returns {{major:number,minor:number,patch:number,prerelease:string|null}|null}
 */
export function parseVersion(value) {
  const match = SEMVER.exec(String(value ?? ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * @param {{major:number,minor:number,patch:number,prerelease:string|null}} version
 */
export function formatVersion(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

/**
 * Compare two versions by SemVer precedence. A prerelease ranks below the same
 * release (so `1.0.0-beta.1 < 1.0.0`), and numeric prerelease identifiers
 * compare numerically (`beta.2 < beta.10`).
 *
 * @returns {-1|0|1}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`cannot compare non-semver versions: ${left} / ${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const x = aParts[i];
    const y = bParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** @param {"patch"|"minor"|"major"} bump */
export function bumpBase(version, bump) {
  if (bump === "major") return { major: version.major + 1, minor: 0, patch: 0, prerelease: null };
  if (bump === "minor") return { major: version.major, minor: version.minor + 1, patch: 0, prerelease: null };
  if (bump === "patch") return { major: version.major, minor: version.minor, patch: version.patch + 1, prerelease: null };
  throw new Error(`unknown bump level: ${bump}`);
}

/** The version a beta counter would have had immediately before `version`. */
export function precedingBeta(version) {
  const parsed = parseVersion(version);
  if (!parsed?.prerelease) throw new Error(`${version} is not a prerelease`);
  const match = BETA.exec(parsed.prerelease);
  if (!match || Number(match[1]) === 0) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}-beta.${Number(match[1]) - 1}`;
}

/**
 * Decide the next version for one package.
 *
 * The rule that matters: while a base version is still unreleased, a new beta
 * increments the counter (`X.Y.Z-beta.2` -> `X.Y.Z-beta.3`). It must NOT move
 * the base and reset to `-beta.0` — that claims a version nobody shipped and
 * burns a number per beta. `newCycle` is the explicit escape hatch for when
 * the operator really does want the next base.
 *
 * `baseReleased` is whether `X.Y.Z` (the base, without the prerelease) already
 * exists as a published tag. When it does, the manifest is inconsistent with
 * the tag history and we refuse instead of guessing.
 *
 * @param {{current:string, target:"beta"|"stable", bump?:"patch"|"minor"|"major", newCycle?:boolean, baseReleased?:boolean}} input
 */
export function nextVersion({ current, target, bump = "patch", newCycle = false, baseReleased = false }) {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`current version ${current} is not semver`);
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;

  if (target === "stable") {
    if (parsed.prerelease) return base;
    return formatVersion(bumpBase(parsed, bump));
  }

  if (target !== "beta") throw new Error(`unknown target: ${target}`);

  if (!parsed.prerelease) {
    // Stable manifest -> open a fresh beta line on the bumped base.
    return `${formatVersion(bumpBase(parsed, bump))}-beta.0`;
  }

  const match = BETA.exec(parsed.prerelease);
  if (!match || newCycle) {
    if (baseReleased) throw new Error(`${base} is already released; cannot reuse it as a new beta base`);
    return newCycle ? `${formatVersion(bumpBase(parsed, bump))}-beta.0` : `${base}-beta.0`;
  }

  if (baseReleased) {
    throw new Error(
      `manifest is ${current} but ${base} is already a released tag; refusing to guess — reconcile the manifest or pass an explicit base`,
    );
  }
  return `${base}-beta.${Number(match[1]) + 1}`;
}

/**
 * Root `package.json` fields that change what core publishes.
 *
 * `scripts` and `devDependencies` are deliberately absent: adding a dev script
 * ships nothing, so it must not trigger a core release. `version` is absent
 * too — bumping it IS the release, not evidence for one.
 */
export const CORE_SHIPPED_FIELDS = [
  "name",
  "bin",
  "main",
  "types",
  "type",
  "exports",
  "files",
  "engines",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "publishConfig",
];

/**
 * Whether a root package.json edit changes shipped behavior.
 *
 * Without this, a commit that only adds an npm script reads as "core changed",
 * and because a core release republishes every floor tracker, one dev-tooling
 * edit would fan out into five package releases.
 *
 * @param {unknown} before parsed package.json at the last core tag (null if none)
 * @param {unknown} after parsed package.json at HEAD
 */
export function rootManifestShipsChanges(before, after) {
  if (!before || typeof before !== "object" || typeof after !== "object" || after === null) return true;
  for (const field of CORE_SHIPPED_FIELDS) {
    const left = JSON.stringify(before[field] ?? null);
    const right = JSON.stringify(after[field] ?? null);
    if (left !== right) return true;
  }
  return false;
}

/**
 * Map a repo-relative path to the package that owns it.
 *
 * @returns {PackageId|null} null for paths that ship nothing (docs, tests, CI).
 */
export function packageForPath(path) {
  const normalized = String(path).replaceAll("\\", "/");
  for (const pkg of PACKAGE_REGISTRY) {
    for (const prefix of pkg.sourcePaths) {
      if (normalized === prefix || normalized.startsWith(prefix)) return pkg.id;
    }
  }
  if (normalized === "package.json") return "core";
  if (normalized.startsWith("patches/")) return "core";
  if (normalized.startsWith("platform-packages/")) return "channel-relay";
  // weacpx-compat has no independent release — it ships from the core publish
  // workflow and its version is derived from core, so it maps to nothing.
  return null;
}

/**
 * Which packages a change set makes stale.
 *
 * @param {string[]} changedPaths
 * @returns {PackageId[]} sorted by registry order
 */
export function detectChanged(changedPaths) {
  const hit = new Set();
  for (const path of changedPaths) {
    const id = packageForPath(path);
    if (id) hit.add(id);
  }
  const ordered = PACKAGE_REGISTRY.filter((pkg) => hit.has(pkg.id)).map((pkg) => pkg.id);
  // platform-packages and weacpx-compat changes only ever ride along with their
  // owner; they have no independent release of their own.
  return ordered;
}

/**
 * Expand a change set into the full set of releases, including packages that
 * must be republished only so a published floor keeps tracking core.
 *
 * @param {{changed:PackageId[]}} input
 * @returns {{releases:PackageId[], floorTrackers:PackageId[]}} `releases` in registry order
 */
export function expandReleaseSet({ changed }) {
  const changedSet = new Set(changed);
  const coreReleased = changedSet.has("core");
  const floorTrackers = coreReleased ? CORE_FLOOR_TRACKERS.filter((id) => !changedSet.has(id)) : [];

  // A core release always republishes every floor-tracker, even one with no
  // source change: its published peer range would otherwise point at an older
  // core than the one it was verified against.
  const all = new Set(changed);
  if (coreReleased) for (const id of CORE_FLOOR_TRACKERS) all.add(id);

  // A protocol release bumps the range in all three consumers, but a consumer
  // only gets republished if it has changes of its own: the range bump alone
  // changes no shipped behavior, and npm matches prereleases only when the
  // range names them (`^X.Y.Z` excludes `X.Y.Z-beta.N`).

  const releases = PACKAGE_REGISTRY.filter((pkg) => all.has(pkg.id)).map((pkg) => pkg.id);
  return { releases, floorTrackers };
}

/**
 * Group releases into publish waves. Within a wave the packages share no
 * dependency and can be pushed concurrently; between waves the next wave's
 * packages install the previous wave's output from npm.
 *
 * relay and channel-relay sit in the same wave but the CLI pushes them one at
 * a time on purpose: both are heavy ubuntu jobs and running them together
 * invites hosted-runner contention.
 *
 * @param {PackageId[]} releases
 * @returns {PackageId[][]}
 */
export function publishWaves(releases) {
  const set = new Set(releases);
  const waves = [];
  for (const wave of [1, 2, 3]) {
    const ids = PACKAGE_REGISTRY.filter((pkg) => pkg.wave === wave && set.has(pkg.id)).map((pkg) => pkg.id);
    if (ids.length > 0) waves.push(ids);
  }
  return waves;
}

function registryEntry(id) {
  const entry = PACKAGE_REGISTRY.find((pkg) => pkg.id === id);
  if (!entry) throw new Error(`unknown package id: ${id}`);
  return entry;
}

/** Tag name for a package version. */
export function tagFor(id, version) {
  return `${registryEntry(id).tagPrefix}${version}`;
}

/**
 * The "expected floor" invariants a released tree must satisfy.
 *
 * These are the ones that have actually broken CI: a plugin whose published
 * peer range lagged core, and protocol ranges that stopped matching after a
 * protocol prerelease.
 *
 * @param {{versions:Record<string,string|undefined>, manifests:Record<string,any>}} input
 * @returns {string[]} violations (empty when consistent)
 */
export function collectFloorViolations({ versions, manifests }) {
  const violations = [];
  const core = versions.core;
  if (!core) return ["cannot check floors without a core version"];

  const compat = manifests[COMPAT_MANIFEST];
  if (compat) {
    if (compat.version !== core) violations.push(`${COMPAT_MANIFEST}: version ${compat.version} != core ${core}`);
    const range = compat.dependencies?.["@ganglion/xacpx"];
    if (range !== `^${core}`) violations.push(`${COMPAT_MANIFEST}: @ganglion/xacpx range ${range} != ^${core}`);
  }

  for (const id of CORE_FLOOR_TRACKERS) {
    const entry = registryEntry(id);
    const manifest = manifests[entry.manifestPath];
    if (!manifest) continue;
    const peer = manifest.peerDependencies?.xacpx;
    const expectedPeer = `>=${core}`;
    if (peer !== expectedPeer) {
      violations.push(`${entry.manifestPath}: peer xacpx ${peer} != ${expectedPeer}`);
    }
    const floor = manifests[`${entry.id}:minXacpxVersion`];
    if (floor && floor !== core) {
      violations.push(`${entry.id}: minXacpxVersion ${floor} != ${core}`);
    }
  }

  const protocol = versions["relay-protocol"];
  if (protocol) {
    const expected = `^${protocol}`;
    for (const id of PROTOCOL_CONSUMERS) {
      const entry = id === "relay-web"
        ? { manifestPath: "packages/relay-web/package.json" }
        : registryEntry(id);
      const manifest = manifests[entry.manifestPath];
      if (!manifest) continue;
      const range = manifest.dependencies?.["@ganglion/xacpx-relay-protocol"];
      if (range !== expected) {
        violations.push(`${entry.manifestPath}: protocol range ${range} != ${expected}`);
      }
    }
  }

  return violations;
}

/**
 * Build the ordered edit list for a plan. Returned rather than applied so the
 * plan can be printed, diffed, and unit tested.
 *
 * @param {{releases:PackageId[], versions:Record<string,string>, previousVersions:Record<string,string>}} input
 */
export function collectEdits({ releases, versions, previousVersions }) {
  const edits = [];
  const released = new Set(releases);
  const coreReleased = released.has("core");
  const protocolReleased = released.has("relay-protocol");
  const channelRelayReleased = released.has("channel-relay");

  for (const id of releases) {
    const entry = registryEntry(id);
    edits.push({
      kind: "json-value",
      file: entry.manifestPath,
      path: ["version"],
      from: previousVersions[id] ?? null,
      to: versions[id],
      reason: `publish ${id} at the new version`,
    });
  }

  if (coreReleased) {
    const from = previousVersions.core;
    const to = versions.core;
    edits.push({
      kind: "json-value",
      file: COMPAT_MANIFEST,
      path: ["version"],
      from,
      to,
      reason: "the compat shim mirrors core exactly",
    });
    edits.push({
      kind: "json-value",
      file: COMPAT_MANIFEST,
      path: ["dependencies", "@ganglion/xacpx"],
      from: `^${from}`,
      to: `^${to}`,
      reason: "the compat shim forwards to the matching core",
    });
    for (const id of CORE_FLOOR_TRACKERS) {
      const entry = registryEntry(id);
      edits.push({
        kind: "json-value",
        file: entry.manifestPath,
        path: ["peerDependencies", "xacpx"],
        from: `>=${from}`,
        to: `>=${to}`,
        reason: `${id} statically imports core runtime exports; the peer floor is its only guard`,
      });
      edits.push({
        kind: "text-replace-all",
        file: entry.pluginEntryPath,
        from: `minXacpxVersion: "${from}"`,
        to: `minXacpxVersion: "${to}"`,
        reason: `${id} runtime floor`,
      });
      const testFile = CORE_FLOOR_TEST_FILES[id];
      if (testFile) {
        edits.push({
          kind: "text-replace-all",
          file: testFile,
          from,
          to,
          reason: `${id} test expectations follow the floor`,
        });
      }
    }
    edits.push({
      kind: "text-replace-all",
      file: METADATA_TEST_FILE,
      from,
      to,
      reason: "root version + feishu peer assertions",
    });
  }

  if (protocolReleased) {
    const from = `^${previousVersions["relay-protocol"]}`;
    const to = `^${versions["relay-protocol"]}`;
    for (const id of PROTOCOL_CONSUMERS) {
      const file = id === "relay-web"
        ? "packages/relay-web/package.json"
        : registryEntry(id).manifestPath;
      edits.push({
        kind: "json-value",
        file,
        path: ["dependencies", "@ganglion/xacpx-relay-protocol"],
        from,
        to,
        reason: "prerelease ranges must name the exact prerelease; `^X.Y.Z` would not match it",
      });
    }
  }

  if (channelRelayReleased) {
    edits.push({
      kind: "script",
      script: "sync-rmux-bridge-versions.mjs",
      reason: "the 5 rmux-bridge platform packages and channel-relay's optional pins ship as one unit",
    });
  }

  return edits;
}

/**
 * The merged PRs inside each package's changelog window, oldest first.
 *
 * A PR belongs to a package when it merged after that package's last tag *and*
 * touched a path that changed since it. Both halves are required. The time bound
 * is not redundant: a path can be touched again long after it last shipped, so
 * an old PR's file list can intersect today's `changedPaths` purely because the
 * same file shows up in both — without the bound, one release re-lists every PR
 * that ever edited a file it happens to touch again.
 *
 * The repo squash-merges, so a commit subject already carries the PR title and
 * number; going to the PR list directly is still better because it yields the
 * PR's own file list rather than a commit-graph walk, and because it carries the
 * description that `notes` hands to whoever writes the CHANGELOG entry.
 *
 * @param {{prs:Array<{number:number,title:string,mergedAt:string,files:Array<string|{path:string}>,body?:string}>, changedPaths:Record<string,string[]>, sinceById?:Record<string,number>}} input
 *   `sinceById` maps package id -> its last tag's commit time in epoch ms; a
 *   package absent from it has no lower bound (it has never shipped).
 * @returns {Record<string,Array<{number:number,title:string,mergedAt:string,body:string}>>}
 */
export function prsForPackages({ prs, changedPaths, sinceById = {} }) {
  const ordered = [...prs].sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  const byPackage = {};
  for (const id of Object.keys(changedPaths)) byPackage[id] = [];
  for (const pr of ordered) {
    // `gh pr list --json files` yields objects ({path, additions, …}), not
    // strings; a bare string list is accepted too so a caller can pass either.
    const touched = new Set(
      (pr.files ?? [])
        .map((file) => (typeof file === "string" ? file : file?.path))
        .filter(Boolean),
    );
    const mergedAt = Date.parse(pr.mergedAt);
    for (const [id, paths] of Object.entries(changedPaths)) {
      const since = sinceById[id];
      if (since !== undefined && !(mergedAt > since)) continue;
      if (!paths.some((path) => touched.has(path))) continue;
      // `body` is only present when the caller asked gh for it; the changelog
      // draft needs the title, `notes` needs the description.
      byPackage[id].push({
        number: pr.number,
        title: pr.title,
        mergedAt: pr.mergedAt,
        body: typeof pr.body === "string" ? pr.body : "",
      });
    }
  }
  return byPackage;
}

/** The same selection, formatted as one changelog bullet per PR. */
export function assignPrsToPackages(input) {
  const byPackage = prsForPackages(input);
  return Object.fromEntries(
    Object.entries(byPackage).map(([id, list]) => [id, list.map((pr) => `${pr.title} (#${pr.number})`)]),
  );
}

/**
 * Where a PR description stops being changelog material.
 *
 * Two shapes, because the repo's PRs use both: a markdown heading (`## Tests`,
 * anything after it is that section) and a bare label line (`Validation:` with
 * nothing else on the line). A sentence that merely starts with "Tests pass …"
 * is prose, not a boundary, so the label form requires the line to end there.
 */
const SECTION_HEADING = /^#{1,6}\s*(?:verification|validat(?:e|ed|ion)|tests?|testing|screenshots?|验证|测试|截图)/i;
const SECTION_LABEL = /^(?:verification|validat(?:e|ed|ion)|tests?|testing|screenshots?|验证|测试|截图)\s*[:：]\s*$/i;

/**
 * The part of a PR description that can feed a CHANGELOG entry.
 *
 * Cuts at the first verification-style heading or label: a release reader wants
 * what changed, not how it was checked, and screenshots/test steps are noise in
 * a file whose convention is one line per user-visible change.
 *
 * @param {string} body
 * @returns {string} the description, or "" when the body opens with verification
 */
export function changelogMaterial(body) {
  const kept = [];
  for (const line of String(body ?? "").split("\n")) {
    const trimmed = line.trim();
    if (SECTION_HEADING.test(trimmed) || SECTION_LABEL.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// CHANGELOG.md's own vocabulary: `### Added` / `### Fixed` / `### Changed` and
// friends, with no conventional-commit prefixes on the bullets. Mapping the
// type is mechanical, so the draft does it; deciding that a given feat is
// really a "Changed" is prose work and stays with the human.
const SECTION_ORDER = ["Added", "Changed", "Fixed", "Docs", "Tests"];
const SECTION_FOR_TYPE = {
  feat: "Added",
  feature: "Added",
  fix: "Fixed",
  docs: "Docs",
  doc: "Docs",
  test: "Tests",
  tests: "Tests",
};
const KNOWN_TYPES = new Set([
  ...Object.keys(SECTION_FOR_TYPE),
  "chore", "refactor", "perf", "style", "build", "ci", "revert",
]);

/**
 * Split a commit subject into its section and its prose.
 *
 * Only a prefix whose type is a real conventional-commit type is stripped, so a
 * subject that merely contains a colon (`Update README: clarify`) survives
 * intact instead of losing its first word to the parser.
 *
 * @param {string} subject
 * @returns {{section:string, text:string}}
 */
export function splitBullet(subject) {
  const match = /^([A-Za-z]+)(?:\([^()]*\))?!?:\s+(.+)$/s.exec(subject);
  const type = match ? match[1].toLowerCase() : "";
  if (!match || !KNOWN_TYPES.has(type)) return { section: "Changed", text: subject };
  return { section: SECTION_FOR_TYPE[type] ?? "Changed", text: match[2] };
}

/**
 * Render the CHANGELOG blocks for a release from the commit subjects that
 * produced it. The prose is mechanical on purpose: it is a starting point the
 * operator edits, not a substitute for writing the entry.
 *
 * @param {{date:string, releases:Array<{id:PackageId,from:string,to:string,npmName?:string,subjects:string[]}>}} input
 */
export function renderChangelog(input) {
  const { date, releases } = input;
  const lines = [];
  for (const release of releases) {
    lines.push(`## [${changelogHeading(release)}] - ${date}`, "");
    if (release.subjects.length === 0) {
      lines.push("- Patch release; no user-visible behavior change beyond the version bump.", "");
      continue;
    }
    const sections = new Map();
    for (const subject of release.subjects) {
      const { section, text } = splitBullet(subject);
      if (!sections.has(section)) sections.set(section, []);
      sections.get(section).push(text);
    }
    const names = [...sections.keys()].sort(
      (a, b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b),
    );
    for (const name of names) {
      lines.push(`### ${name}`, "");
      for (const text of sections.get(name)) lines.push(`- ${text}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** Core is labelled bare; every other package is prefixed with its id. */
export function changelogHeading(release) {
  return release.id === "core" ? release.to : `${release.id} ${release.to}`;
}

export const CHANGELOG_HEADER = "# Changelog\n";
const UNRELEASED_HEADING = "## [Unreleased]";

/**
 * Splice a release block into CHANGELOG.md.
 *
 * An `## [Unreleased]` section counts only when it is the FIRST section — this
 * file legitimately carries older `## [Unreleased]` headings deep in its
 * history, and relabelling one of those would rewrite a shipped entry and
 * orphan the current cycle's prose. When the top section is Unreleased, its text
 * becomes the primary package's entry and the remaining packages get generated
 * headings after it.
 *
 * @param {{current:string, releases:Array<{id:PackageId,from:string,to:string}>, date:string, draft:string}} input
 * @returns {string} the new file contents
 */
export function spliceChangelog({ current, releases, date, draft }) {
  if (!current.startsWith(CHANGELOG_HEADER)) {
    throw new Error("CHANGELOG.md does not start with `# Changelog`");
  }
  const body = current.slice(CHANGELOG_HEADER.length).replace(/^\n+/, "");
  const [first, ...others] = releases;
  if (!first) throw new Error("spliceChangelog needs at least one release");

  if (!body.startsWith(UNRELEASED_HEADING)) {
    // `draft` already ends with a newline after its last bullet; the extra one
    // separates it from whatever section follows.
    return `${CHANGELOG_HEADER}${draft}\n${body}`;
  }

  const afterHeading = body.slice(UNRELEASED_HEADING.length).replace(/^\n+/, "");
  const nextSection = afterHeading.indexOf("\n## [");
  const authored = (nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection)).trimEnd();
  const tail = nextSection === -1 ? "" : afterHeading.slice(nextSection + 1);

  let block = `## [${changelogHeading(first)}] - ${date}\n`;
  block += authored.length > 0 ? `\n${authored}\n` : "\n";
  if (others.length > 0) {
    block += `\n${renderChangelog({ date, releases: others.map((release) => ({ ...release, subjects: [] })) })}`;
  }
  return `${CHANGELOG_HEADER}${block}${tail ? `\n${tail}` : ""}`;
}
