import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensurePluginHome, normalizePluginHomeManifest, resolvePluginHome } from "../../../src/plugins/plugin-home.js";
import { coreHomeDir } from "../../../src/runtime/core-home.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PLUGIN_HOME = process.env.WEACPX_PLUGIN_HOME;

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_PLUGIN_HOME === undefined) delete process.env.WEACPX_PLUGIN_HOME;
  else process.env.WEACPX_PLUGIN_HOME = ORIGINAL_PLUGIN_HOME;
});

describe("resolvePluginHome", () => {
  beforeEach(() => {
    delete process.env.WEACPX_PLUGIN_HOME;
  });

  it("uses an explicit pluginHome when provided", () => {
    expect(resolvePluginHome({ pluginHome: "/custom/path" })).toBe("/custom/path");
  });

  it("uses WEACPX_PLUGIN_HOME env when set", () => {
    process.env.WEACPX_PLUGIN_HOME = "/env/path";
    expect(resolvePluginHome()).toBe("/env/path");
  });

  it("uses input.home + /.xacpx/plugins when provided", () => {
    expect(resolvePluginHome({ home: "/u/alice" })).toBe(join("/u/alice", ".xacpx", "plugins"));
  });

  it("uses process.env.HOME when no input given", () => {
    process.env.HOME = "/u/bob";
    expect(resolvePluginHome()).toBe(join("/u/bob", ".xacpx", "plugins"));
  });

  // homedir() is real, so route the expected base through coreHomeDir() — it
  // prefers ~/.xacpx but falls back to an existing legacy ~/.weacpx, which
  // would otherwise make this assertion machine-dependent. The point of this
  // test is the HOME-unset → homedir() fallback, not the directory name.
  it("falls back to homedir() when HOME env unset", () => {
    delete process.env.HOME;
    expect(resolvePluginHome()).toBe(join(coreHomeDir(homedir()), "plugins"));
  });

  // --- Regression: the bug that produced undefined/.xacpx/plugins/ in CWD ---

  it("treats input.home === 'undefined' string as missing and falls through", () => {
    process.env.HOME = "/u/carol";
    expect(resolvePluginHome({ home: "undefined" })).toBe(join("/u/carol", ".xacpx", "plugins"));
  });

  it("treats input.pluginHome === 'undefined' string as missing", () => {
    process.env.HOME = "/u/dave";
    expect(resolvePluginHome({ pluginHome: "undefined" })).toBe(join("/u/dave", ".xacpx", "plugins"));
  });

  it("treats WEACPX_PLUGIN_HOME === 'undefined' string as missing", () => {
    process.env.WEACPX_PLUGIN_HOME = "undefined";
    process.env.HOME = "/u/eve";
    expect(resolvePluginHome()).toBe(join("/u/eve", ".xacpx", "plugins"));
  });

  it("treats process.env.HOME === 'undefined' string as missing (the original bug)", () => {
    process.env.HOME = "undefined";
    expect(resolvePluginHome()).toBe(join(coreHomeDir(homedir()), "plugins"));
  });

  it("also treats 'null' string as missing", () => {
    process.env.HOME = "null";
    expect(resolvePluginHome()).toBe(join(coreHomeDir(homedir()), "plugins"));
  });
});

describe("normalizePluginHomeManifest", () => {
  it("collapses duplicate dependency keys (last value wins)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-norm-"));
    try {
      const manifest = join(dir, "package.json");
      // Simulates the corrupt state bun left on Windows: same package twice,
      // once as an npm version and once as a local path.
      await writeFile(
        manifest,
        '{\n  "private": true,\n  "type": "module",\n  "dependencies": {\n    "@scope/pkg": "0.2.1",\n    "@scope/pkg": "/local/path"\n  }\n}\n',
      );
      const changed = await normalizePluginHomeManifest(dir);
      expect(changed).toBe(true);
      const after = JSON.parse(await readFile(manifest, "utf8")) as { dependencies: Record<string, string> };
      expect(Object.keys(after.dependencies)).toEqual(["@scope/pkg"]);
      expect(after.dependencies["@scope/pkg"]).toBe("/local/path");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for a clean manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-norm-"));
    try {
      const manifest = join(dir, "package.json");
      await writeFile(
        manifest,
        JSON.stringify({ private: true, type: "module", dependencies: { "@scope/pkg": "0.2.1" } }, null, 2) + "\n",
      );
      expect(await normalizePluginHomeManifest(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns false when no manifest exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-norm-"));
    try {
      expect(await normalizePluginHomeManifest(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an unparseable manifest untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-norm-"));
    try {
      const manifest = join(dir, "package.json");
      await writeFile(manifest, "{ not valid json ]");
      expect(await normalizePluginHomeManifest(dir)).toBe(false);
      expect(await readFile(manifest, "utf8")).toBe("{ not valid json ]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Regression: channel plugins are built with `--external weacpx`, so their
// `import { ... } from "weacpx/plugin-api"` (runtime VALUE import, e.g. the
// realtime-switching helpers in the Feishu channel) must resolve from the
// plugin home's node_modules at runtime. Before the shim, installing the
// Feishu plugin crashed with `Cannot find package 'weacpx'`. `ensurePluginHome`
// now lays down a `node_modules/weacpx/` shim that copies the running
// `dist/plugin-api.js` and exposes it via a relative `exports` map.
describe("ensurePluginHome — weacpx/plugin-api resolution shim", () => {
  it("creates a node_modules/weacpx shim with a relative ./plugin-api export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-shim-"));
    try {
      await ensurePluginHome(dir);
      const shimPkgPath = join(dir, "node_modules", "weacpx", "package.json");
      const pkg = JSON.parse(await readFile(shimPkgPath, "utf8")) as {
        name?: string;
        type?: string;
        exports?: Record<string, unknown>;
      };
      expect(pkg.name).toBe("weacpx");
      expect(pkg.type).toBe("module");
      // Node ESM rejects absolute paths / file:// URLs in `exports`; the target
      // MUST be a relative "./" path into the shim itself.
      expect(pkg.exports?.["./plugin-api"]).toBe("./plugin-api.js");
      // The runtime bundle must be copied in alongside the manifest.
      await access(join(dir, "node_modules", "weacpx", "plugin-api.js"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets a deeply-nested plugin module resolve the bare weacpx/plugin-api specifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-shim-"));
    try {
      await ensurePluginHome(dir);
      // Mirror the real install layout: the plugin's built entry lives at
      // node_modules/@scope/pkg/dist/index.mjs and imports the externalized
      // weacpx/plugin-api by bare specifier — Node/bun must walk up to the
      // sibling node_modules/weacpx shim to resolve it.
      const consumerDir = join(dir, "node_modules", "@scope", "demo-plugin", "dist");
      await mkdir(consumerDir, { recursive: true });
      const consumer = join(consumerDir, "index.mjs");
      await writeFile(
        consumer,
        [
          'import { createConversationExecutor, resolveTurnLane, toDisplaySessionAlias } from "weacpx/plugin-api";',
          "export const probe = {",
          "  createsExecutor: typeof createConversationExecutor === \"function\",",
          "  lane: resolveTurnLane(\"/ss backend\"),",
          "  display: typeof toDisplaySessionAlias === \"function\",",
          "};",
        ].join("\n"),
      );

      const mod = (await import(pathToFileURL(consumer).href)) as {
        probe: { createsExecutor: boolean; lane: string; display: boolean };
      };
      expect(mod.probe.createsExecutor).toBe(true);
      expect(mod.probe.display).toBe(true);
      expect(mod.probe.lane).toBe("control");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Rename forward-compat (0.7.x, ahead of the 0.8.0 weacpx→xacpx rename): a
  // matching shim is also written under the renamed core name `xacpx`, so a
  // plugin built against `xacpx/plugin-api` resolves even while the running
  // core is still `weacpx`. Together with the `weacpx` shim above, old and new
  // plugins coexist with no reinstall across the rename.
  it("also creates a node_modules/xacpx shim pointing at the same bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-shim-"));
    try {
      await ensurePluginHome(dir);
      const shimPkgPath = join(dir, "node_modules", "xacpx", "package.json");
      const pkg = JSON.parse(await readFile(shimPkgPath, "utf8")) as {
        name?: string;
        type?: string;
        exports?: Record<string, unknown>;
      };
      expect(pkg.name).toBe("xacpx");
      expect(pkg.type).toBe("module");
      expect(pkg.exports?.["./plugin-api"]).toBe("./plugin-api.js");
      await access(join(dir, "node_modules", "xacpx", "plugin-api.js"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets a plugin module resolve the bare xacpx/plugin-api specifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-shim-"));
    try {
      await ensurePluginHome(dir);
      const consumerDir = join(dir, "node_modules", "@scope", "demo-plugin", "dist");
      await mkdir(consumerDir, { recursive: true });
      const consumer = join(consumerDir, "index.mjs");
      await writeFile(
        consumer,
        [
          'import { createConversationExecutor, resolveTurnLane, toDisplaySessionAlias } from "xacpx/plugin-api";',
          "export const probe = {",
          "  createsExecutor: typeof createConversationExecutor === \"function\",",
          "  lane: resolveTurnLane(\"/ss backend\"),",
          "  display: typeof toDisplaySessionAlias === \"function\",",
          "};",
        ].join("\n"),
      );

      const mod = (await import(pathToFileURL(consumer).href)) as {
        probe: { createsExecutor: boolean; lane: string; display: boolean };
      };
      expect(mod.probe.createsExecutor).toBe(true);
      expect(mod.probe.display).toBe(true);
      expect(mod.probe.lane).toBe("control");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
