import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  COMPAT_MANIFEST,
  PACKAGE_REGISTRY,
  RELEASE_ARTIFACTS,
  assignPrsToPackages,
  collectEdits,
  collectFloorViolations,
  compareVersions,
  detectChanged,
  expandReleaseSet,
  gateScope,
  nextVersion,
  packageForPath,
  parseVersion,
  precedingBeta,
  publishWaves,
  renderChangelog,
  splitBullet,
  rootManifestShipsChanges,
  spliceChangelog,
  tagFor,
} from "../../../scripts/release-lib.mjs";

test("rootManifestShipsChanges ignores dev-only edits and catches shipped ones", () => {
  const base = {
    name: "@ganglion/xacpx",
    version: "0.24.10-beta.3",
    bin: { xacpx: "./dist/cli.js" },
    exports: { "./plugin-api": { types: "./dist/plugin-api.d.ts", default: "./dist/plugin-api.js" } },
    dependencies: { acpx: "0.19.5", "node-pty": "^1.1.0" },
    scripts: { test: "node ./scripts/run-tests.mjs" },
    devDependencies: { typescript: "^5.0.0" },
  };

  // The version bump and a new npm script are both release mechanics, not
  // shipped behavior — otherwise adding a dev script would fan out into a core
  // release plus every floor-tracking plugin.
  expect(rootManifestShipsChanges(base, {
    ...base,
    version: "0.24.10-beta.4",
    scripts: { ...base.scripts, "release:plan": "node ./scripts/release.mjs plan" },
  })).toBe(false);
  expect(rootManifestShipsChanges(base, {
    ...base,
    devDependencies: { ...base.devDependencies, vitest: "^3.0.0" },
  })).toBe(false);

  // Anything a consumer can observe does force a release.
  expect(rootManifestShipsChanges(base, { ...base, dependencies: { ...base.dependencies, acpx: "0.19.6" } })).toBe(true);
  expect(rootManifestShipsChanges(base, { ...base, bin: { xacpx: "./dist/main.js" } })).toBe(true);
  expect(rootManifestShipsChanges(base, { ...base, engines: { node: ">=22" } })).toBe(true);
  expect(rootManifestShipsChanges(base, { ...base, files: ["dist"] })).toBe(true);

  // No baseline (never released) is treated as changed rather than skipped.
  expect(rootManifestShipsChanges(null, base)).toBe(true);
});

test("assignPrsToPackages maps each PR to the packages its files belong to, oldest first", () => {
  const byPackage = assignPrsToPackages({
    changedPaths: {
      relay: ["packages/relay-web/src/style.css"],
      core: ["src/main.ts", "src/adapters/adapter-catalog.ts"],
      "channel-feishu": [],
    },
    prs: [
      { number: 432, title: "feat(relay-web): GroupPane single topbar", mergedAt: "2026-10-16T10:00:00Z", files: ["packages/relay-web/src/style.css"] },
      { number: 419, title: "chore(adapters): refresh managed pins", mergedAt: "2026-10-14T10:00:00Z", files: [{ path: "src/adapters/adapter-catalog.ts", additions: 4, changeType: "MODIFIED" }] },
      { number: 400, title: "feat: spans both", mergedAt: "2026-10-15T10:00:00Z", files: ["src/main.ts", "packages/relay-web/src/style.css"] },
      { number: 999, title: "docs: unrelated", mergedAt: "2026-10-15T11:00:00Z", files: ["docs/config-reference.md"] },
    ],
  });

  // Ordered by mergedAt, not by the order gh returned them.
  expect(byPackage.core).toEqual([
    "chore(adapters): refresh managed pins (#419)",
    "feat: spans both (#400)",
  ]);
  expect(byPackage.relay).toEqual([
    "feat: spans both (#400)",
    "feat(relay-web): GroupPane single topbar (#432)",
  ]);
  // A package with no intersection gets no bullets; a docs-only PR lands nowhere.
  expect(byPackage["channel-feishu"]).toEqual([]);
  expect(Object.values(byPackage).flat().join("\n")).not.toContain("docs: unrelated");
});

test("assignPrsToPackages excludes a PR merged before the package's last tag", () => {
  // The regression this guards: intersecting path *names* alone re-lists every
  // PR that ever edited a file this release happens to touch again, because a
  // path name is in `changedPaths` whether or not it changed *in this window*.
  // One real release drafted 86 bullets, most shipped months earlier.
  const byPackage = assignPrsToPackages({
    changedPaths: { relay: ["packages/relay-web/src/style.css"] },
    sinceById: { relay: Date.parse("2026-10-16T00:00:00Z") },
    prs: [
      { number: 313, title: "feat(relay-web): composer column alignment", mergedAt: "2026-08-27T00:00:00Z", files: ["packages/relay-web/src/style.css"] },
      { number: 434, title: "feat(relay-web): unified dropdown", mergedAt: "2026-10-16T09:00:00Z", files: ["packages/relay-web/src/style.css"] },
    ],
  });
  expect(byPackage.relay).toEqual(["feat(relay-web): unified dropdown (#434)"]);
});

test("assignPrsToPackages treats a package with no tag as having no lower bound", () => {
  const byPackage = assignPrsToPackages({
    changedPaths: { "channel-discord": ["packages/channel-discord/src/index.ts"] },
    prs: [{ number: 9, title: "feat(discord): initial plugin", mergedAt: "2026-01-01T00:00:00Z", files: ["packages/channel-discord/src/index.ts"] }],
  });
  expect(byPackage["channel-discord"]).toEqual(["feat(discord): initial plugin (#9)"]);
});

test("gateScope builds and verifies only what the release ships", () => {
  // A relay-only release must not rebuild the root CLI or the channel plugins:
  // their sources are unchanged, so their artifacts are the ones already on npm.
  expect(gateScope(["relay"])).toEqual({ builds: ["build:relay"], verifyIds: ["relay"] });
  // Core republishes the three floor trackers, so their artifacts do ship.
  expect(gateScope(["core", "channel-feishu", "channel-discord"]).builds).toEqual([
    "build",
    "build:channel-feishu",
    "build:channel-discord",
  ]);
  expect(gateScope(["core"]).verifyIds).toEqual(["root"]);
});

test("gateScope falls back to the unscoped gate for a package it cannot describe", () => {
  // Null, not a partial scope: an unmapped package is one whose artifact cannot
  // be assumed unchanged, and a silent partial gate would look like a pass.
  expect(gateScope(["relay", "mystery"])).toBe(null);
});

test("every registry package has an artifact mapping pointing at a real script", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).scripts;
  for (const pkg of PACKAGE_REGISTRY) {
    const spec = RELEASE_ARTIFACTS[pkg.id];
    expect(spec).toBeDefined();
    // A mapping naming a script that does not exist would only surface mid-release.
    expect(scripts[spec.build]).toBeDefined();
  }
});

test("parseVersion splits a prerelease and rejects non-semver", () => {
  expect(parseVersion("0.24.10-beta.3")).toEqual({ major: 0, minor: 24, patch: 10, prerelease: "beta.3" });
  expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  expect(parseVersion("nope")).toBeNull();
  expect(parseVersion("0.24.10-beta.3.1")).toEqual({ major: 0, minor: 24, patch: 10, prerelease: "beta.3.1" });
});

test("compareVersions ranks a prerelease below its release and counts numerically", () => {
  expect(compareVersions("0.24.10-beta.2", "0.24.10-beta.10")).toBe(-1);
  expect(compareVersions("0.24.10-beta.10", "0.24.10-beta.2")).toBe(1);
  expect(compareVersions("0.24.10", "0.24.10-beta.9")).toBe(1);
  expect(compareVersions("0.24.10-beta.1", "0.24.10-beta.1")).toBe(0);
  expect(compareVersions("0.24.9", "0.24.10-beta.0")).toBe(-1);
});

test("nextVersion increments the beta counter while the base is unreleased", () => {
  // The regression this whole rule exists for: 0.24.10 stable has never
  // shipped, so the next beta is beta.4 — not 0.24.11-beta.0.
  expect(nextVersion({ current: "0.24.10-beta.3", target: "beta" })).toBe("0.24.10-beta.4");
  expect(nextVersion({ current: "0.14.12-beta.4", target: "beta" })).toBe("0.14.12-beta.5");
});

test("nextVersion opens a fresh beta cycle from a stable manifest", () => {
  expect(nextVersion({ current: "0.24.10", target: "beta" })).toBe("0.24.11-beta.0");
  expect(nextVersion({ current: "0.24.10", target: "beta", bump: "minor" })).toBe("0.25.0-beta.0");
  expect(nextVersion({ current: "0.24.10", target: "beta", bump: "major" })).toBe("1.0.0-beta.0");
});

test("nextVersion promotes a beta to its base and bumps a stable per --bump", () => {
  expect(nextVersion({ current: "0.24.10-beta.7", target: "stable" })).toBe("0.24.10");
  expect(nextVersion({ current: "0.24.10", target: "stable" })).toBe("0.24.11");
  expect(nextVersion({ current: "0.24.10", target: "stable", bump: "minor" })).toBe("0.25.0");
});

test("nextVersion refuses to reuse a base that already shipped", () => {
  // Guards the case where the manifest is beta but the base is already a tag:
  // guessing either way would produce a version nobody can publish.
  expect(() => nextVersion({ current: "0.24.10-beta.3", target: "beta", baseReleased: true })).toThrow(/already a released tag/);
  expect(nextVersion({ current: "0.24.10", target: "beta", newCycle: true, bump: "minor" })).toBe("0.25.0-beta.0");
});

test("precedingBeta walks one counter step back and stops at zero", () => {
  expect(precedingBeta("0.24.10-beta.3")).toBe("0.24.10-beta.2");
  expect(precedingBeta("0.24.10-beta.0")).toBeNull();
  expect(() => precedingBeta("0.24.10")).toThrow(/not a prerelease/);
});

test("packageForPath maps relay-web onto relay and ignores shipping-neutral paths", () => {
  expect(packageForPath("packages/relay-web/src/style.css")).toBe("relay");
  expect(packageForPath("packages/relay/src/server.ts")).toBe("relay");
  expect(packageForPath("src/transport/acpx-cli/acpx-cli-transport.ts")).toBe("core");
  expect(packageForPath("package.json")).toBe("core");
  expect(packageForPath("patches/acpx@0.19.5.patch")).toBe("core");
  expect(packageForPath("platform-packages/xacpx-rmux-bridge-linux-x64/package.json")).toBe("channel-relay");
  expect(packageForPath("packages/relay-protocol/src/dtos.ts")).toBe("relay-protocol");
  // weacpx-compat rides along with core; it has no independent release.
  expect(packageForPath("weacpx-compat/package.json")).toBeNull();
  // Nothing that ships bytes.
  expect(packageForPath("docs/config-reference.md")).toBeNull();
  expect(packageForPath("tests/unit/main.test.ts")).toBeNull();
  expect(packageForPath("scripts/release.mjs")).toBeNull();
  expect(packageForPath(".github/workflows/test.yml")).toBeNull();
});

test("detectChanged returns registry order, not path order", () => {
  const changed = detectChanged([
    "src/main.ts",
    "packages/relay-web/src/style.css",
    "packages/relay-protocol/src/dtos.ts",
  ]);
  expect(changed).toEqual(["relay-protocol", "relay", "core"]);
});

test("a core release pulls in every floor tracker, listed separately from real changes", () => {
  const { releases, floorTrackers } = expandReleaseSet({ changed: ["core"] });
  expect(releases).toEqual(["channel-relay", "core", "channel-feishu", "channel-discord"]);
  expect(floorTrackers).toEqual(["channel-relay", "channel-feishu", "channel-discord"]);
});

test("a relay-web change releases relay alone", () => {
  const { releases, floorTrackers } = expandReleaseSet({ changed: ["relay"] });
  expect(releases).toEqual(["relay"]);
  expect(floorTrackers).toEqual([]);
});

test("channel-yuanbao is never pulled in by a core release", () => {
  const { releases } = expandReleaseSet({ changed: ["core"] });
  expect(releases).not.toContain("channel-yuanbao");
  const files = collectEdits({
    releases,
    versions: { core: "0.24.10-beta.4" },
    previousVersions: { core: "0.24.10-beta.3" },
  }).flatMap((edit) => (edit.file ? [edit.file] : []));
  expect(files.some((file) => file.includes("yuanbao"))).toBe(false);
});

test("publishWaves orders protocol before relay/channel-relay before the independent packages", () => {
  const waves = publishWaves(["core", "relay-protocol", "relay", "channel-relay", "channel-discord"]);
  expect(waves).toEqual([
    ["relay-protocol"],
    ["relay", "channel-relay"],
    ["core", "channel-discord"],
  ]);
});

test("collectEdits derives the whole core floor set from one version", () => {
  const edits = collectEdits({
    releases: ["channel-relay", "core", "channel-feishu", "channel-discord"],
    versions: { core: "0.24.10-beta.4" },
    previousVersions: { core: "0.24.10-beta.3" },
  });
  const targets = edits.map((edit) => `${edit.file}|${(edit.path ?? []).join(".")}`);

  expect(targets).toContain(`${COMPAT_MANIFEST}|version`);
  expect(targets).toContain(`${COMPAT_MANIFEST}|dependencies.@ganglion/xacpx`);
  for (const id of ["channel-relay", "channel-feishu", "channel-discord"]) {
    expect(targets).toContain(`packages/${id}/package.json|peerDependencies.xacpx`);
    expect(targets).toContain(`packages/${id}/src/index.ts|`);
  }
  expect(targets).toContain("tests/unit/packages/package-metadata.test.ts|");
  expect(targets).toContain("tests/unit/packages/channel-relay/channel-relay-plugin.test.ts|");

  const peer = edits.find((edit) => edit.path?.join(".") === "peerDependencies.xacpx");
  expect(peer.from).toBe(">=0.24.10-beta.3");
  expect(peer.to).toBe(">=0.24.10-beta.4");
  const floor = edits.find((edit) => edit.file.endsWith("src/index.ts"));
  expect(floor.from).toBe('minXacpxVersion: "0.24.10-beta.3"');
  expect(floor.to).toBe('minXacpxVersion: "0.24.10-beta.4"');
});

test("collectEdits rewrites the protocol range in all three consumers with one version", () => {
  const edits = collectEdits({
    releases: ["relay-protocol"],
    versions: { "relay-protocol": "0.6.4-beta.2" },
    previousVersions: { "relay-protocol": "0.6.4-beta.1" },
  });
  const files = edits.filter((edit) => edit.path?.join(".") === "dependencies.@ganglion/xacpx-relay-protocol");
  expect(files.map((edit) => edit.file).sort()).toEqual([
    "packages/channel-relay/package.json",
    "packages/relay-web/package.json",
    "packages/relay/package.json",
  ]);
  for (const edit of files) expect(edit.to).toBe("^0.6.4-beta.2");
});

test("collectEdits asks for the bridge sync whenever channel-relay ships", () => {
  const edits = collectEdits({ releases: ["channel-relay"], versions: {}, previousVersions: {} });
  expect(edits.some((edit) => edit.kind === "script" && edit.script === "sync-rmux-bridge-versions.mjs")).toBe(true);
  const relayOnly = collectEdits({ releases: ["relay"], versions: {}, previousVersions: {} });
  expect(relayOnly.some((edit) => edit.kind === "script")).toBe(false);
});

function consistentManifests(core: string) {
  return {
    [COMPAT_MANIFEST]: { version: core, dependencies: { "@ganglion/xacpx": `^${core}` } },
    "packages/relay-protocol/package.json": { version: "0.6.4-beta.2" },
    "packages/relay/package.json": { dependencies: { "@ganglion/xacpx-relay-protocol": "^0.6.4-beta.2" } },
    "packages/relay-web/package.json": { dependencies: { "@ganglion/xacpx-relay-protocol": "^0.6.4-beta.2" } },
    "packages/channel-relay/package.json": {
      peerDependencies: { xacpx: `>=${core}` },
      dependencies: { "@ganglion/xacpx-relay-protocol": "^0.6.4-beta.2" },
    },
    "packages/channel-feishu/package.json": { peerDependencies: { xacpx: `>=${core}` } },
    "packages/channel-discord/package.json": { peerDependencies: { xacpx: `>=${core}` } },
    "channel-relay:minXacpxVersion": core,
    "channel-feishu:minXacpxVersion": core,
    "channel-discord:minXacpxVersion": core,
  };
}

const consistentVersions = { core: "0.24.10-beta.3", "relay-protocol": "0.6.4-beta.2" };

test("collectFloorViolations accepts a fully synced tree", () => {
  expect(collectFloorViolations({
    versions: consistentVersions,
    manifests: consistentManifests("0.24.10-beta.3"),
  })).toEqual([]);
});

test("collectFloorViolations reports a plugin peer floor that lagged core", () => {
  const manifests = consistentManifests("0.24.10-beta.3");
  manifests["packages/channel-discord/package.json"].peerDependencies.xacpx = ">=0.24.10-beta.2";
  const violations = collectFloorViolations({ versions: consistentVersions, manifests });
  expect(violations).toHaveLength(1);
  expect(violations[0]).toMatch(/channel-discord.*>=0\.24\.10-beta\.3/);
});

test("collectFloorViolations reports a stale protocol range and a stale compat shim", () => {
  const manifests = consistentManifests("0.24.10-beta.3");
  manifests["packages/relay-web/package.json"].dependencies["@ganglion/xacpx-relay-protocol"] = "^0.6.4-beta.1";
  manifests[COMPAT_MANIFEST].dependencies["@ganglion/xacpx"] = "^0.24.10-beta.2";
  const violations = collectFloorViolations({ versions: consistentVersions, manifests });
  expect(violations).toHaveLength(2);
  expect(violations.join("\n")).toMatch(/relay-web.*\^0\.6\.4-beta\.2/);
  expect(violations.join("\n")).toMatch(/weacpx-compat.*\^0\.24\.10-beta\.3/);
});

test("collectFloorViolations reports a drifted minXacpxVersion", () => {
  const manifests = consistentManifests("0.24.10-beta.3");
  manifests["channel-feishu:minXacpxVersion"] = "0.24.9-beta.0";
  const violations = collectFloorViolations({ versions: consistentVersions, manifests });
  expect(violations.join("\n")).toMatch(/channel-feishu: minXacpxVersion 0\.24\.9-beta\.0 != 0\.24\.10-beta\.3/);
});

test("tagFor uses the registry prefix with no separator", () => {
  expect(tagFor("core", "0.24.10-beta.4")).toBe("v0.24.10-beta.4");
  expect(tagFor("relay", "0.14.12-beta.5")).toBe("relay-v0.14.12-beta.5");
  expect(tagFor("channel-relay", "0.7.8-beta.4")).toBe("channel-relay-v0.7.8-beta.4");
});

test("every registry entry carries a complete tag prefix and manifest", () => {
  for (const pkg of PACKAGE_REGISTRY) {
    expect(pkg.tagPrefix.endsWith("-v") || pkg.tagPrefix === "v").toBe(true);
    expect(pkg.manifestPath.endsWith("package.json")).toBe(true);
    expect(pkg.sourcePaths.length).toBeGreaterThan(0);
    expect([1, 2, 3]).toContain(pkg.wave);
  }
});

test("renderChangelog labels core without a package prefix and others with one", () => {
  const rendered = renderChangelog({
    date: "2026-10-15",
    releases: [
      { id: "core", from: "0.24.10-beta.3", to: "0.24.10-beta.4", subjects: ["fix: a thing"] },
      { id: "relay", from: "0.14.12-beta.4", to: "0.14.12-beta.5", subjects: [] },
    ],
  });
  expect(rendered).toContain("## [0.24.10-beta.4] - 2026-10-15");
  expect(rendered).toContain("## [relay 0.14.12-beta.5] - 2026-10-15");
  expect(rendered).toContain("- a thing");
  // An empty subject list still produces a section rather than a bare heading.
  expect(rendered).toMatch(/## \[relay 0\.14\.12-beta\.5\][\s\S]*- /);
});

test("renderChangelog groups subjects into the file's own sections, in a fixed order", () => {
  const rendered = renderChangelog({
    date: "2026-10-16",
    releases: [{
      id: "relay",
      from: "0.14.12-beta.5",
      to: "0.14.12-beta.6",
      subjects: [
        "fix(relay-web): mount one TopicSwitcher (#436)",
        "feat(relay-web): unified dropdown (#434)",
        "test(relay-web): stop DesktopTab tests racing (#435)",
        "chore: bump a dev tool",
      ],
    }],
  });
  // Conventional-commit prefixes are the file's convention to drop; the PR
  // reference stays because entries in this file do cite them.
  expect(rendered).not.toContain("fix(relay-web):");
  expect(rendered).toContain("- mount one TopicSwitcher (#436)");
  expect(rendered.indexOf("### Added")).toBeLessThan(rendered.indexOf("### Changed"));
  expect(rendered.indexOf("### Changed")).toBeLessThan(rendered.indexOf("### Fixed"));
  expect(rendered.indexOf("### Fixed")).toBeLessThan(rendered.indexOf("### Tests"));
  expect(rendered).toContain("- bump a dev tool");
});

test("splitBullet strips only a real conventional-commit type", () => {
  expect(splitBullet("feat(relay-web)!: something")).toEqual({ section: "Added", text: "something" });
  expect(splitBullet("fix: another")).toEqual({ section: "Fixed", text: "another" });
  // A colon in prose is not a type: the first word must not be eaten.
  expect(splitBullet("Update README: clarify the install step")).toEqual({
    section: "Changed",
    text: "Update README: clarify the install step",
  });
});

test("spliceChangelog inserts a draft above the previous release", () => {
  const current = [
    "# Changelog",
    "## [relay 0.14.12-beta.4] - 2026-10-15",
    "",
    "### Fixed",
    "",
    "- Old entry.",
    "",
  ].join("\n");
  const next = spliceChangelog({
    current,
    releases: [{ id: "relay", from: "0.14.12-beta.4", to: "0.14.12-beta.5" }],
    date: "2026-10-16",
    draft: "## [relay 0.14.12-beta.5] - 2026-10-16\n\n- New entry.\n\n",
  });
  expect(next.indexOf("## [relay 0.14.12-beta.5]")).toBeLessThan(next.indexOf("## [relay 0.14.12-beta.4]"));
  expect(next).toContain("- Old entry.");
  expect(next.startsWith("# Changelog\n")).toBe(true);
});

test("spliceChangelog relabels the TOP [Unreleased] and keeps its prose", () => {
  const current = [
    "# Changelog",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Hand-written feature prose.",
    "",
    "## [relay 0.14.12-beta.4] - 2026-10-15",
    "",
    "- Previous release.",
    "",
  ].join("\n");
  const next = spliceChangelog({
    current,
    releases: [
      { id: "core", from: "0.24.10-beta.3", to: "0.24.10-beta.4" },
      { id: "relay", from: "0.14.12-beta.4", to: "0.14.12-beta.5" },
    ],
    date: "2026-10-16",
    draft: "IGNORED WHEN UNRELEASED EXISTS\n",
  });
  expect(next).toContain("## [0.24.10-beta.4] - 2026-10-16");
  expect(next).toContain("- Hand-written feature prose.");
  // The other released package still gets a section, after the authored one.
  expect(next).toContain("## [relay 0.14.12-beta.5] - 2026-10-16");
  expect(next.indexOf("## [0.24.10-beta.4]")).toBeLessThan(next.indexOf("## [relay 0.14.12-beta.5]"));
  expect(next.indexOf("## [relay 0.14.12-beta.5]")).toBeLessThan(next.indexOf("## [relay 0.14.12-beta.4]"));
  expect(next).toContain("- Previous release.");
  expect(next).not.toContain("IGNORED WHEN UNRELEASED EXISTS");
});

test("spliceChangelog ignores a historical [Unreleased] far down the file", () => {
  // The trap: this file really does carry old `## [Unreleased]` headings deep in
  // its history. Relabelling one would rewrite a shipped entry and orphan the
  // current cycle's prose.
  const current = [
    "# Changelog",
    "## [relay 0.14.12-beta.4] - 2026-10-15",
    "",
    "- Current top entry.",
    "",
    "## [0.24.10-beta.1] - 2026-10-14",
    "",
    "## [Unreleased]",
    "",
    "### Changed",
    "",
    "- An ancient, already-superseded section.",
    "",
  ].join("\n");
  const next = spliceChangelog({
    current,
    releases: [{ id: "relay", from: "0.14.12-beta.4", to: "0.14.12-beta.5" }],
    date: "2026-10-16",
    draft: "## [relay 0.14.12-beta.5] - 2026-10-16\n\n- New entry.\n\n",
  });
  // The stale heading survives untouched, and the draft lands at the top.
  expect(next).toContain("## [Unreleased]\n\n### Changed\n\n- An ancient, already-superseded section.");
  expect(next.indexOf("## [relay 0.14.12-beta.5]")).toBeLessThan(next.indexOf("## [relay 0.14.12-beta.4]"));
  expect(next).toContain("- Current top entry.");
});

test("spliceChangelog requires the canonical header and at least one release", () => {
  expect(() => spliceChangelog({ current: "no header\n", releases: [], date: "2026-10-16", draft: "" }))
    .toThrow(/does not start with/);
  expect(() => spliceChangelog({ current: "# Changelog\n", releases: [], date: "2026-10-16", draft: "" }))
    .toThrow(/at least one release/);
});

test("spliceChangelog with only [Unreleased] and one release leaves no stray blank run", () => {
  const current = "# Changelog\n## [Unreleased]\n\n### Fixed\n\n- Only entry.\n";
  const next = spliceChangelog({
    current,
    releases: [{ id: "relay", from: "0.14.12-beta.4", to: "0.14.12-beta.5" }],
    date: "2026-10-16",
    draft: "unused\n",
  });
  expect(next).toBe("# Changelog\n## [relay 0.14.12-beta.5] - 2026-10-16\n\n### Fixed\n\n- Only entry.\n");
  expect(next).not.toMatch(/\n{3,}/);
});
