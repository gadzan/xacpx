import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/config-store";
import { loadConfig } from "../../src/config/load-config";
import { filesWriteEnabled, type AppConfig } from "../../src/config/types";
import { createFilesSettingsDep, type FilesSettingsDep } from "../../src/main";
import { AsyncMutex } from "../../src/orchestration/async-mutex";

interface Harness {
  config: AppConfig;
  dep: FilesSettingsDep;
  readSaved: () => Promise<Record<string, any>>;
  cleanup: () => Promise<void>;
}

async function setup(document: unknown): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-files-switch-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(document, null, 2));
  const store = new ConfigStore(path);
  const config = await loadConfig(path);
  return {
    config,
    dep: createFilesSettingsDep({
      config,
      configStore: store,
      configMutationMutex: new AsyncMutex(),
      // Production wiring: replaceRuntimeConfig()'s in-place assign, reached
      // through buildApp's publishLiveConfig.
      publishLiveConfig: (updated) => Object.assign(config, updated),
    }),
    readSaved: async () => JSON.parse(await readFile(path, "utf8")) as Record<string, any>,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

test("flipping the switch hot-applies to the live config the gate reads", async () => {
  const { config, dep, cleanup } = await setup({
    transport: { permissionMode: "approve-all" },
    agents: {},
    workspaces: {},
  });

  try {
    expect(filesWriteEnabled(config)).toBe(false);
    // The gate is a per-operation read of this object; nothing else runs here.
    expect(await dep.get()).toEqual({ enabled: false, restartRequired: false });

    expect(await dep.update(true)).toEqual({ enabled: true, restartRequired: false });
    expect(filesWriteEnabled(config)).toBe(true);
    expect(await dep.get()).toEqual({ enabled: true, restartRequired: false });

    expect(await dep.update(false)).toEqual({ enabled: false, restartRequired: false });
    expect(filesWriteEnabled(config)).toBe(false);
  } finally {
    await cleanup();
  }
});

test("the switch writes only files.writeEnabled", async () => {
  const { dep, readSaved, cleanup } = await setup({
    transport: { permissionMode: "approve-all" },
    agents: { codex: { driver: "codex" } },
    workspaces: { repo: { cwd: "/tmp/repo", description: "hand-written" } },
    files: { handNote: "keep me" },
    myCustomTopLevel: { anything: true },
  });

  try {
    await dep.update(true);
    const saved = await readSaved();
    expect(saved.files).toEqual({ handNote: "keep me", writeEnabled: true });
    expect(saved.myCustomTopLevel).toEqual({ anything: true });
    expect(saved.workspaces.repo.description).toBe("hand-written");
    expect(saved.transport.permissionMode).toBe("approve-all");
  } finally {
    await cleanup();
  }
});

test("get reports the live value, and a failed write leaves it unchanged", async () => {
  const { config, dep, cleanup } = await setup({
    transport: { permissionMode: "approve-all" },
    agents: {},
    workspaces: {},
  });

  try {
    // A value published by anything else (e.g. the config watcher after a
    // hand-edit) is what the panel must show, not what the disk said at boot.
    Object.assign(config, { files: { writeEnabled: true } });
    expect(await dep.get()).toEqual({ enabled: true, restartRequired: false });

    // A persistence failure must not publish: the gate keeps enforcing the
    // last successfully published value.
    const failing = createFilesSettingsDep({
      config,
      configStore: { setRawValue: async () => { throw new Error("disk full"); } },
      configMutationMutex: new AsyncMutex(),
      publishLiveConfig: (updated) => Object.assign(config, updated),
    });
    await expect(failing.update(false)).rejects.toThrow("disk full");
    expect(filesWriteEnabled(config)).toBe(true);
    expect(await dep.get()).toEqual({ enabled: true, restartRequired: false });
  } finally {
    await cleanup();
  }
});
