import { expect, test } from "bun:test";
import { dirname, posix, resolve } from "node:path";

import { resolveAcpxCommand, resolveAcpxCommandMetadata } from "../../../src/config/resolve-acpx-command";

test("bundled executor metadata includes the installed package version and exact bin", () => {
  expect(resolveAcpxCommandMetadata({ platform: "linux",
    resolvePackageJson: () => "/project/node_modules/acpx/package.json",
    readPackageJson: () => ({ version: "0.16.0", bin: { acpx: "dist/cli.js" } }),
  })).toMatchObject({ command: "/project/node_modules/acpx/dist/cli.js", source: "bundled", packageVersion: "0.16.0" });
});

test("custom executor resolution never borrows the bundled package version", () => {
  const metadata = resolveAcpxCommandMetadata({ configuredCommand: "acpx",
    resolvePackageJson: () => { throw new Error("must not inspect bundled package"); } });
  expect(metadata).toMatchObject({ command: "acpx", source: "config" });
  expect(metadata.packageVersion).toBeUndefined();
});

test("PATH fallback has no trusted package version", () => {
  const metadata = resolveAcpxCommandMetadata({ resolvePackageJson: () => { throw new Error("package missing"); } });
  expect(metadata).toMatchObject({ command: "acpx", source: "PATH" });
  expect(metadata.packageVersion).toBeUndefined();
});

test("malformed bundled package version preserves ordinary resolution without attestation", () => {
  const metadata = resolveAcpxCommandMetadata({ platform: "linux",
    resolvePackageJson: () => "/project/node_modules/acpx/package.json",
    readPackageJson: () => ({ version: 16, bin: "dist/cli.js" }) as never });
  expect(metadata).toMatchObject({ command: "/project/node_modules/acpx/dist/cli.js", source: "bundled" });
  expect(metadata.packageVersion).toBeUndefined();
});

test("prefers an explicit transport command", () => {
  expect(
    resolveAcpxCommand({
      configuredCommand: "/custom/acpx",
      resolvePackageJson: () => {
        throw new Error("should not resolve package");
      },
      readPackageJson: () => {
        throw new Error("should not read package");
      },
    }),
  ).toBe("/custom/acpx");
});

test("resolves the local acpx bin from the installed package", () => {
  expect(
    resolveAcpxCommand({
      platform: "linux",
      resolvePackageJson: () => "/project/node_modules/acpx/package.json",
      readPackageJson: () => ({
        bin: {
          acpx: "bin/acpx.js",
        },
      }),
    }),
  ).toBe(posix.resolve(posix.dirname("/project/node_modules/acpx/package.json"), "bin/acpx.js"));
});

test("resolves the local acpx windows shim on win32", () => {
  expect(
    resolveAcpxCommand({
      platform: "win32",
      resolvePackageJson: () => "E:/project/node_modules/acpx/package.json",
      readPackageJson: () => ({
        bin: {
          acpx: "dist/cli.js",
        },
      }),
    }),
  ).toBe("E:\\project\\node_modules\\acpx\\dist\\cli.js");
});

test("falls back to PATH acpx when the package is not installed", () => {
  expect(
    resolveAcpxCommand({
      resolvePackageJson: () => {
        throw new Error("not found");
      },
      readPackageJson: () => {
        throw new Error("should not read package");
      },
    }),
  ).toBe("acpx");
});
