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

test("root package version is 0.17.1", () => {
  const pkg = readJson("package.json");

  expect(pkg.version).toBe("0.17.1");
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
  expect(feishu.peerDependencies.xacpx).toBe(">=0.9.0-0");
  expect(yuanbao.peerDependencies.xacpx).toBe(">=0.17.0");
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
