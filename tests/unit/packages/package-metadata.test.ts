import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("root package publishes as xacpx and exposes plugin-api", () => {
  const pkg = readJson("package.json");

  expect(pkg.name).toBe("@ganglion/xacpx");
  expect(pkg.bin).toEqual({ xacpx: "./dist/cli.js" });
  expect(pkg.exports["./plugin-api"]).toEqual({
    types: "./dist/plugin-api.d.ts",
    default: "./dist/plugin-api.js",
  });
});

test("root package version is 0.24.10", () => {
  const pkg = readJson("package.json");

  expect(pkg.version).toBe("0.24.10");
});

test("first-party channel plugins peer depend on xacpx", () => {
  const feishu = readJson("packages/channel-feishu/package.json");
  const yuanbao = readJson("packages/channel-yuanbao/package.json");

  for (const pkg of [feishu, yuanbao]) {
    expect(pkg.peerDependencies.weacpx).toBeUndefined();
    expect(pkg.peerDependenciesMeta.xacpx.optional).toBe(true);
    expect(pkg.peerDependenciesMeta.weacpx).toBeUndefined();
    expect(pkg.publishConfig.access).toBe("public");
  }
  expect(feishu.peerDependencies.xacpx).toBe(">=0.24.10");
  expect(yuanbao.peerDependencies.xacpx).toBe(">=0.17.0");
});

test("plugins importing a runtime plugin-api export floor their peer above it", () => {
  // A plugin whose source statically imports a RUNTIME named export from
  // `xacpx/plugin-api` cannot be protected by `minXacpxVersion` alone: ESM
  // resolves named exports while linking, before the plugin's default export
  // runs, so the version check never gets a chance to refuse. The peer floor is
  // the only guard, which makes "does the source import one?" the thing to test.
  const root = readJson("package.json");
  const rootVersion = root.version as string;
  const consumers = [
    "packages/channel-feishu",
    "packages/channel-discord",
  ] as const;
  for (const dir of consumers) {
    const pkg = readJson(`${dir}/package.json`);
    const importsRuntimeExport = readFileSync(`${dir}/src/elicitation-limits.ts`, "utf8")
      .includes("satisfiesElicitationFormat");
    if (!importsRuntimeExport) continue;
    expect(pkg.peerDependencies.xacpx).toBe(`>=${rootVersion}`);
  }
});

test("deprecated weacpx compat shim forwards plugin-api to xacpx", () => {
  const root = readJson("package.json");
  const shim = readJson("weacpx-compat/package.json");

  expect(shim.name).toBe("weacpx");
  expect(shim.version).toBe(root.version);
  expect(shim.bin).toBeUndefined();
  expect(shim.dependencies["@ganglion/xacpx"]).toBe(`^${root.version}`);
  expect(shim.exports["./plugin-api"]).toEqual({
    types: "./plugin-api.d.ts",
    default: "./plugin-api.js",
  });
});

const RELAY_PROTOCOL = "@ganglion/xacpx-relay-protocol";
const RELAY_PROTOCOL_CONSUMERS = [
  "packages/channel-relay",
  "packages/relay",
] as const;

// The dashboard bundles the protocol into dist/ and publishes with no runtime
// dependencies, so its range lives in devDependencies.
const RELAY_PROTOCOL_DEV_CONSUMERS = ["packages/web"] as const;

function readJsonc(path: string) {
  return Bun.JSONC.parse(readFileSync(path, "utf8"));
}

test("relay-protocol workspace version and consumer deps match across manifests and lockfiles", () => {
  const protocol = readJson("packages/relay-protocol/package.json");
  expect(protocol.name).toBe(RELAY_PROTOCOL);
  expect(protocol.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const version = protocol.version as string;
  const range = `^${version}`;

  for (const dir of RELAY_PROTOCOL_CONSUMERS) {
    const pkg = readJson(`${dir}/package.json`);
    expect(pkg.dependencies[RELAY_PROTOCOL]).toBe(range);
  }
  for (const dir of RELAY_PROTOCOL_DEV_CONSUMERS) {
    const pkg = readJson(`${dir}/package.json`);
    expect(pkg.devDependencies[RELAY_PROTOCOL]).toBe(range);
    expect(pkg.dependencies ?? {}).not.toHaveProperty(RELAY_PROTOCOL);
  }

  const npmLock = readJson("package-lock.json");
  expect(npmLock.packages["packages/relay-protocol"].name).toBe(RELAY_PROTOCOL);
  expect(npmLock.packages["packages/relay-protocol"].version).toBe(version);
  for (const dir of RELAY_PROTOCOL_CONSUMERS) {
    expect(npmLock.packages[dir].dependencies[RELAY_PROTOCOL]).toBe(range);
  }
  for (const dir of RELAY_PROTOCOL_DEV_CONSUMERS) {
    expect(npmLock.packages[dir].devDependencies[RELAY_PROTOCOL]).toBe(range);
  }

  const bunLock = readJsonc("bun.lock");
  expect(bunLock.workspaces["packages/relay-protocol"].name).toBe(RELAY_PROTOCOL);
  expect(bunLock.workspaces["packages/relay-protocol"].version).toBe(version);
  for (const dir of RELAY_PROTOCOL_CONSUMERS) {
    expect(bunLock.workspaces[dir].dependencies[RELAY_PROTOCOL]).toBe(range);
  }
  for (const dir of RELAY_PROTOCOL_DEV_CONSUMERS) {
    expect(bunLock.workspaces[dir].devDependencies[RELAY_PROTOCOL]).toBe(range);
  }
});

test("the shared control bridge only type-imports the plugin API", () => {
  const files = ["control-bridge.ts", "relay-interaction.ts"];
  for (const file of files) {
    const source = readFileSync(`packages/control-bridge/src/${file}`, "utf8");
    const statements = source.split(";").filter((part) => part.includes('from "xacpx/plugin-api"'));
    expect(statements.every((statement) => statement.trimStart().startsWith("import type"))).toBe(true);
  }
});

test("relay and channel-relay install the shared control bridge", () => {
  const bridge = readJson("packages/control-bridge/package.json");
  const relay = readJson("packages/relay/package.json");
  const channel = readJson("packages/channel-relay/package.json");
  expect(bridge.name).toBe("@ganglion/xacpx-control-bridge");
  expect(bridge.version).toBe("0.1.0");
  expect(relay.dependencies["@ganglion/xacpx-control-bridge"]).toBe("^0.1.0");
  expect(channel.dependencies["@ganglion/xacpx-control-bridge"]).toBe("^0.1.0");
});

test("npm lockfile has no versionless installed package entries", () => {
  const lock = readJson("package-lock.json");
  const versionless = Object.entries(lock.packages as Record<string, { link?: boolean; version?: string }>)
    .filter(([path, entry]) => path.includes("node_modules/") && !entry.link
      && (typeof entry.version !== "string" || entry.version.length === 0))
    .map(([path]) => path);
  // npm's deduplication compares these versions even for optional, foreign-OS
  // dependencies. An { optional: true } placeholder crashes before tests start.
  expect(versionless).toEqual([]);
});

test("npm lockfile contains every pinned rmux-bridge optional package", () => {
  const relay = readJson("packages/channel-relay/package.json");
  const lock = readJson("package-lock.json");
  for (const [name, version] of Object.entries(relay.optionalDependencies)) {
    if (!name.startsWith("@ganglion/xacpx-rmux-bridge-")) continue;
    const entry = lock.packages[`node_modules/${name}`];
    expect(entry).toBeDefined();
    expect(entry.version).toBe(version);
    expect(entry.optional).toBe(true);
  }
});
