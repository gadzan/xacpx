import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectProblems,
  expectedVersion,
  inspectPlatformPackage,
  platformPackageName,
} from "../../../scripts/ensure-rmux-platform.mjs";

function makeRepo(options: { relayVersion?: string; pin?: string; platform?: Record<string, unknown> | null }) {
  const root = mkdtempSync(join(tmpdir(), "rmux-ensure-"));
  mkdirSync(join(root, "packages", "channel-relay"), { recursive: true });
  writeFileSync(
    join(root, "packages", "channel-relay", "package.json"),
    JSON.stringify({
      version: options.relayVersion ?? "1.2.3",
      optionalDependencies: options.pin === undefined ? {} : { [platformPackageName("win32", "x64")]: options.pin },
    }),
  );
  if (options.platform !== null && options.platform !== undefined) {
    const dir = join(root, "node_modules", ...platformPackageName("win32", "x64").split("/"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: options.platform.version }));
    for (const file of (options.platform.files as string[] | undefined) ?? []) {
      writeFileSync(join(dir, "bin", file), "");
    }
  }
  return root;
}

const NAME = platformPackageName("win32", "x64");

test("platform package names match what the runtime resolver looks for", () => {
  // The resolver builds @ganglion/xacpx-rmux-bridge-<os>-<arch>; an install under any
  // other name would be invisible to it.
  expect(platformPackageName("win32", "x64")).toBe("@ganglion/xacpx-rmux-bridge-win32-x64");
  expect(platformPackageName("linux", "arm64")).toBe("@ganglion/xacpx-rmux-bridge-linux-arm64");
  expect(platformPackageName("darwin", "x64")).toBe("@ganglion/xacpx-rmux-bridge-darwin-x64");
});

test("the wanted version is the pin channel-relay ships, so the two cannot drift", () => {
  const root = makeRepo({ relayVersion: "9.9.9", pin: "0.7.10-beta.0" });
  try {
    expect(expectedVersion(root, NAME)).toBe("0.7.10-beta.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing platform package is reported", () => {
  const root = makeRepo({ platform: null });
  try {
    expect(inspectPlatformPackage(root, NAME, "win32").present).toBe(false);
    expect(collectProblems(root, NAME, "win32").join("\n")).toContain("is not installed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package without its dedicated daemon counts as unusable", () => {
  // This is the shape that shipped as 0.7.8: a bridge binary with no rmux-daemon
  // beside it. The runtime refuses it rather than fall back to a PATH daemon, so the
  // check has to refuse it too — an install that "succeeds" is not the same as working.
  const root = makeRepo({
    pin: "0.7.10-beta.0",
    platform: { version: "0.7.10-beta.0", files: ["xacpx-rmux-bridge.exe"] },
  });
  try {
    const state = inspectPlatformPackage(root, NAME, "win32");
    expect(state.present).toBe(true);
    expect(state.bridge).toBe(true);
    expect(state.daemon).toBe(false);
    expect(state.complete).toBe(false);
    expect(collectProblems(root, NAME, "win32").join("\n")).toContain("dedicated rmux-daemon");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a complete package at the pinned version has nothing to report", () => {
  const root = makeRepo({
    pin: "0.7.10-beta.0",
    platform: { version: "0.7.10-beta.0", files: ["xacpx-rmux-bridge.exe", "rmux-daemon.exe"] },
  });
  try {
    expect(collectProblems(root, NAME, "win32")).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale version is reported even when the files are present", () => {
  const root = makeRepo({
    pin: "0.7.10-beta.0",
    platform: { version: "0.7.8", files: ["xacpx-rmux-bridge.exe", "rmux-daemon.exe"] },
  });
  try {
    expect(collectProblems(root, NAME, "win32").join("\n")).toContain("expected 0.7.10-beta.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
