import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../../../src/config/load-config";
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

test("parseConfig rejects invalid files.writeEnabled values", () => {
  const raw = { transport: {}, agents: {}, workspaces: {} };

  expect(() => parseConfig({ ...raw, files: true })).toThrow("files must be an object");
  expect(() => parseConfig({ ...raw, files: { writeEnabled: "true" } })).toThrow(
    "files.writeEnabled must be boolean",
  );
});
