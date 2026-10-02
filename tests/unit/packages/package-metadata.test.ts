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

test("root package version is 0.24.6-beta.0", () => {
  const pkg = readJson("package.json");

  expect(pkg.version).toBe("0.24.6-beta.0");
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
  expect(feishu.peerDependencies.xacpx).toBe(">=0.24.6-beta.0");
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
  "packages/relay-web",
] as const;

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

  const npmLock = readJson("package-lock.json");
  expect(npmLock.packages["packages/relay-protocol"].name).toBe(RELAY_PROTOCOL);
  expect(npmLock.packages["packages/relay-protocol"].version).toBe(version);
  for (const dir of RELAY_PROTOCOL_CONSUMERS) {
    expect(npmLock.packages[dir].dependencies[RELAY_PROTOCOL]).toBe(range);
  }

  const bunLock = readJsonc("bun.lock");
  expect(bunLock.workspaces["packages/relay-protocol"].name).toBe(RELAY_PROTOCOL);
  expect(bunLock.workspaces["packages/relay-protocol"].version).toBe(version);
  for (const dir of RELAY_PROTOCOL_CONSUMERS) {
    expect(bunLock.workspaces[dir].dependencies[RELAY_PROTOCOL]).toBe(range);
  }
});
