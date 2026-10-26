import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../../../src/config/load-config";
import { ConfigStore } from "../../../src/config/config-store";
import { filesWriteEnabled, type AppConfig } from "../../../src/config/types";

const base = {} as AppConfig; // helper only touches `.files`
test("filesWriteEnabled defaults to false when unset", () => {
  expect(filesWriteEnabled(base)).toBe(false);
});
test("filesWriteEnabled is true only when writeEnabled === true", () => {
  expect(filesWriteEnabled({ ...base, files: { writeEnabled: true } })).toBe(true);
  expect(filesWriteEnabled({ ...base, files: { writeEnabled: false } })).toBe(false);
});

test("loadConfig preserves files.writeEnabled for runtime Git mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-files-config-"));
  const path = join(dir, "config.json");

  try {
    await writeFile(path, JSON.stringify({
      transport: {},
      agents: {},
      workspaces: {},
      files: { writeEnabled: true },
    }));

    const config = await loadConfig(path);

    expect(config.files).toEqual({ writeEnabled: true });
    expect(filesWriteEnabled(config)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects files arrays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-files-config-"));
  const path = join(dir, "config.json");

  try {
    await writeFile(path, JSON.stringify({
      transport: {},
      agents: {},
      workspaces: {},
      files: [],
    }));

    await expect(loadConfig(path)).rejects.toThrow("files must be an object");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseConfig rejects invalid files.writeEnabled values", () => {
  const raw = { transport: {}, agents: {}, workspaces: {} };

  expect(() => parseConfig({ ...raw, files: true })).toThrow("files must be an object");
  expect(() => parseConfig({ ...raw, files: { writeEnabled: "true" } })).toThrow(
    "files.writeEnabled must be boolean",
  );
});

test("the write switch persists only files.writeEnabled and hot-applies to the live object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-files-config-"));
  const path = join(dir, "config.json");

  try {
    await writeFile(path, JSON.stringify({
      transport: { type: "acpx-bridge", permissionMode: "approve-all" },
      agents: {},
      workspaces: { repo: { cwd: "/tmp/repo", description: "hand-written" } },
      files: { handNote: "keep me" },
    }));

    const store = new ConfigStore(path);
    const live = await loadConfig(path);
    expect(filesWriteEnabled(live)).toBe(false);

    // Exactly what the instance dialog's switch does: raw patch, then publish
    // the parsed result onto the live config object the gate reads.
    const updated = await store.setRawValue(["files", "writeEnabled"], true);
    Object.assign(live, updated);

    expect(filesWriteEnabled(live)).toBe(true);
    const saved = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
    expect(saved.files).toEqual({ handNote: "keep me", writeEnabled: true });
    expect(saved.workspaces.repo.description).toBe("hand-written");
    expect(saved.transport.permissionMode).toBe("approve-all");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
