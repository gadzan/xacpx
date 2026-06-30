import { expect, test } from "bun:test";
import { resolveSpawnCommand } from "../../../src/process/spawn-command";

test("resolveSpawnCommand returns command and args unchanged for regular commands", () => {
  const result = resolveSpawnCommand("node", ["--version"]);
  expect(result.command).toBe("node");
  expect(result.args).toEqual(["--version"]);
});

test("resolveSpawnCommand returns command and args unchanged for commands without extensions", () => {
  const result = resolveSpawnCommand("npm", ["install"]);
  expect(result.command).toBe("npm");
  expect(result.args).toEqual(["install"]);
});

test("resolveSpawnCommand wraps .js files with process.execPath", () => {
  const result = resolveSpawnCommand("script.js", ["arg1"]);
  expect(result.command).toBe(process.execPath);
  expect(result.args[0]).toBe("script.js");
  expect(result.args[1]).toBe("arg1");
});

test("resolveSpawnCommand wraps .cjs files with process.execPath", () => {
  const result = resolveSpawnCommand("script.cjs", ["--flag"]);
  expect(result.command).toBe(process.execPath);
  expect(result.args[0]).toBe("script.cjs");
});

test("resolveSpawnCommand wraps .mjs files with process.execPath", () => {
  const result = resolveSpawnCommand("script.mjs", []);
  expect(result.command).toBe(process.execPath);
  expect(result.args[0]).toBe("script.mjs");
});

test("resolveSpawnCommand is case-insensitive for .js extension", () => {
  const result = resolveSpawnCommand("script.JS", []);
  expect(result.command).toBe(process.execPath);
});

test("resolveSpawnCommand passes multiple args through", () => {
  const result = resolveSpawnCommand("build.js", ["--input", "foo", "--output", "bar"]);
  expect(result.command).toBe(process.execPath);
  expect(result.args).toEqual(["build.js", "--input", "foo", "--output", "bar"]);
});

test("resolveSpawnCommand handles paths with directories", () => {
  const result = resolveSpawnCommand("scripts/setup.js", []);
  expect(result.command).toBe(process.execPath);
  expect(result.args[0]).toBe("scripts/setup.js");
});

test("resolveSpawnCommand preserves empty args array", () => {
  const result = resolveSpawnCommand("node", []);
  expect(result.command).toBe("node");
  expect(result.args).toEqual([]);
});

test("resolveSpawnCommand handles script file with no args", () => {
  const result = resolveSpawnCommand("script.js", []);
  expect(result.command).toBe(process.execPath);
  expect(result.args).toEqual(["script.js"]);
});