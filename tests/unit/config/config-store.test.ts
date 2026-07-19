import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

import { ConfigStore } from "../../../src/config/config-store";

async function makeConfigFile(content: unknown): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-store-"));
  const path = join(dir, "config.json");
  await writeFile(path, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  return { dir, path };
}

async function readRaw(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test("loads config from disk", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge", command: "acpx" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });

  const store = new ConfigStore(path);
  const config = await store.load();

  expect(config.transport.type).toBe("acpx-bridge");
  expect(config.workspaces.backend).toEqual({ cwd: "/tmp/backend" });

  await rm(dir, { recursive: true, force: true });
});

test("unknown top-level and nested keys survive a mutation round-trip", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    myCustomTopLevel: { anything: true },
    channel: { type: "weixin", replyMode: "verbose", myNote: "hand-written" },
  });

  const store = new ConfigStore(path);
  await store.upsertWorkspace("frontend", "/tmp/frontend");

  const saved = await readRaw(path);
  expect(saved.myCustomTopLevel).toEqual({ anything: true });
  expect((saved.channel as Record<string, unknown>).myNote).toBe("hand-written");
  expect((saved.workspaces as Record<string, unknown>).frontend).toEqual({ cwd: "/tmp/frontend" });

  await rm(dir, { recursive: true, force: true });
});

test("a literal ~ workspace cwd survives adding another workspace", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: { home: { cwd: "~", description: "home directory" } },
  });

  const store = new ConfigStore(path);
  const config = await store.upsertWorkspace("notes", "~/notes");

  const saved = await readRaw(path);
  const workspaces = saved.workspaces as Record<string, Record<string, unknown>>;
  // Existing literal `~` untouched; the new workspace stores the user's raw input.
  expect(workspaces.home).toEqual({ cwd: "~", description: "home directory" });
  expect(workspaces.notes).toEqual({ cwd: "~/notes" });

  // The returned read model expands `~` for runtime use.
  expect(config.workspaces.home?.cwd).toBe(homedir());
  expect(config.workspaces.notes?.cwd).toBe(`${homedir()}/notes`);

  await rm(dir, { recursive: true, force: true });
});

test("defaults absent from the file stay absent after a mutation", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });

  const store = new ConfigStore(path);
  const config = await store.upsertAgent("claude", { driver: "claude" });

  const saved = await readRaw(path);
  const transport = saved.transport as Record<string, unknown>;
  expect(transport).toEqual({ type: "acpx-bridge" });
  expect(transport.queueOwnerTtlSeconds).toBeUndefined();
  expect(transport.permissionMode).toBeUndefined();
  expect(saved.logging).toBeUndefined();
  expect(saved.orchestration).toBeUndefined();

  // The read model still materializes defaults.
  expect(config.transport.permissionMode).toBe("approve-all");
  expect(config.transport.queueOwnerTtlSeconds).toBe(1800);

  await rm(dir, { recursive: true, force: true });
});

test("workspaces.*.allowed_agents survives an unrelated mutation", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex"] } },
  });

  const store = new ConfigStore(path);
  await store.upsertWorkspace("frontend", "/tmp/frontend");

  const saved = await readRaw(path);
  const workspaces = saved.workspaces as Record<string, Record<string, unknown>>;
  expect(workspaces.backend).toEqual({ cwd: "/tmp/backend", allowed_agents: ["codex"] });

  await rm(dir, { recursive: true, force: true });
});

test("invalid JSON file fails the mutation with a clear error and leaves the file untouched", async () => {
  const broken = '{ "transport": { "type": "acpx-bridge" ,, }';
  const { dir, path } = await makeConfigFile(broken);

  const store = new ConfigStore(path);
  await expect(store.upsertWorkspace("frontend", "/tmp/frontend")).rejects.toThrow(/not valid JSON/);

  expect(await readFile(path, "utf8")).toBe(broken);

  await rm(dir, { recursive: true, force: true });
});

test("mutating a missing file seeds the required sections so the written file round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-store-"));
  const path = join(dir, "config.json");

  const store = new ConfigStore(path);
  const config = await store.upsertWorkspace("backend", "/tmp/backend");

  const saved = await readRaw(path);
  // The required sections are present on disk so a subsequent load() succeeds.
  expect(saved).toEqual({ transport: {}, agents: {}, workspaces: { backend: { cwd: "/tmp/backend" } } });
  expect(config.workspaces.backend).toEqual({ cwd: "/tmp/backend" });
  expect(config.transport.type).toBe("acpx-bridge");

  // Round-trip: reloading the freshly-written file must not throw.
  const reloaded = await new ConfigStore(path).load();
  expect(reloaded.workspaces.backend).toEqual({ cwd: "/tmp/backend" });

  await rm(dir, { recursive: true, force: true });
});

test("upsertAgent on a missing file produces a loadable config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-store-"));
  const path = join(dir, "config.json");

  const store = new ConfigStore(path);
  await store.upsertAgent("codex", { driver: "codex" });

  // The regression: the written doc lacked transport/workspaces and load() threw
  // "transport must be an object".
  const reloaded = await new ConfigStore(path).load();
  expect(reloaded.agents.codex).toEqual({ driver: "codex" });

  await rm(dir, { recursive: true, force: true });
});

test("raw mutators reject prototype-polluting keys and never touch Object.prototype", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });
  const before = await readFile(path, "utf8");
  const store = new ConfigStore(path);

  for (const key of ["__proto__", "constructor", "prototype"]) {
    // As the tail key.
    await expect(store.setRawValue(["transport", key], "x")).rejects.toThrow(/unsafe|prototype|__proto__|constructor/);
    // As an intermediate segment.
    await expect(store.setRawValue(["agents", key, "driver"], "EVIL")).rejects.toThrow(
      /unsafe|prototype|__proto__|constructor/,
    );
    await expect(store.unsetRawValue(["agents", key])).rejects.toThrow(/unsafe|prototype|__proto__|constructor/);
    // Targeted mutators that take an entry name.
    await expect(store.upsertAgent(key, { driver: "EVIL" })).rejects.toThrow(
      /unsafe|prototype|__proto__|constructor/,
    );
    await expect(store.upsertWorkspace(key, "/tmp/evil")).rejects.toThrow(
      /unsafe|prototype|__proto__|constructor/,
    );
  }

  // Object.prototype stays clean and the file is untouched.
  expect(({} as Record<string, unknown>).driver).toBeUndefined();
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(await readFile(path, "utf8")).toBe(before);

  await rm(dir, { recursive: true, force: true });
});

test("an invalid patched document is rejected before anything is written", async () => {
  const original = {
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  };
  const { dir, path } = await makeConfigFile(original);
  const before = await readFile(path, "utf8");

  const store = new ConfigStore(path);
  await expect(store.upsertWorkspace("bad", "")).rejects.toThrow(/cwd/);

  expect(await readFile(path, "utf8")).toBe(before);

  await rm(dir, { recursive: true, force: true });
});

test("upserts a workspace while preserving transport and agents", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge", command: "acpx" },
    agents: {
      codex: { driver: "codex", command: "./node_modules/.bin/codex-acp" },
      custom: { driver: "custom", command: "npx some-agent" },
    },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });

  const store = new ConfigStore(path);
  const config = await store.upsertWorkspace("frontend", "/tmp/frontend", "frontend repo");

  expect(config.workspaces.frontend).toEqual({
    cwd: "/tmp/frontend",
    description: "frontend repo",
  });

  const saved = await readRaw(path);
  // Raw agents keep their hand-written command strings (no driver-default expansion).
  expect((saved.agents as Record<string, unknown>).codex).toEqual({
    driver: "codex",
    command: "./node_modules/.bin/codex-acp",
  });
  expect((saved.transport as Record<string, unknown>)).toEqual({ type: "acpx-bridge", command: "acpx" });
  expect((saved.workspaces as Record<string, unknown>).frontend).toEqual({
    cwd: "/tmp/frontend",
    description: "frontend repo",
  });

  await rm(dir, { recursive: true, force: true });
});

test("removes a workspace and keeps the rest of the config intact", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-cli", command: "acpx" },
    agents: { claude: { driver: "claude" } },
    workspaces: {
      backend: { cwd: "/tmp/backend" },
      frontend: { cwd: "/tmp/frontend" },
    },
  });

  const store = new ConfigStore(path);
  const config = await store.removeWorkspace("backend");

  expect(config.workspaces).toEqual({ frontend: { cwd: "/tmp/frontend" } });

  const saved = await readRaw(path);
  expect(saved.workspaces).toEqual({ frontend: { cwd: "/tmp/frontend" } });
  expect(saved.transport).toEqual({ type: "acpx-cli", command: "acpx" });

  await rm(dir, { recursive: true, force: true });
});

test("updates transport keys without pinning unrelated defaults", async () => {
  const { dir, path } = await makeConfigFile({
    transport: {
      type: "acpx-cli",
      command: "custom-acpx",
      sessionInitTimeoutMs: 45000,
    },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });

  const store = new ConfigStore(path);
  const config = await store.updateTransport({ permissionMode: "approve-reads" });

  expect(config.transport).toMatchObject({
    type: "acpx-cli",
    command: "custom-acpx",
    sessionInitTimeoutMs: 45000,
    permissionMode: "approve-reads",
  });

  const saved = await readRaw(path);
  expect(saved.transport).toEqual({
    type: "acpx-cli",
    command: "custom-acpx",
    sessionInitTimeoutMs: 45000,
    permissionMode: "approve-reads",
  });

  await rm(dir, { recursive: true, force: true });
});

test("updateTransport deletes a key when its patch value is explicitly undefined", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge", command: "stale-acpx" },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  const store = new ConfigStore(path);
  await store.updateTransport({ command: undefined });

  const saved = await readRaw(path);
  expect(saved.transport).toEqual({ type: "acpx-bridge" });

  await rm(dir, { recursive: true, force: true });
});

test("replaces managed adapter versions atomically without touching other transport keys", async () => {
  const { dir, path } = await makeConfigFile({
    transport: {
      type: "acpx-bridge",
      command: "custom-acpx",
      adapterVersions: { codex: "1.0.0" },
      custom: true,
    },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  const store = new ConfigStore(path);
  const config = await store.replaceAdapterVersions({ codex: "1.1.2", claude: "0.58.1" });

  expect(config.transport.adapterVersions).toEqual({ codex: "1.1.2", claude: "0.58.1" });
  expect(await readRaw(path)).toMatchObject({
    transport: {
      type: "acpx-bridge",
      command: "custom-acpx",
      adapterVersions: { codex: "1.1.2", claude: "0.58.1" },
      custom: true,
    },
  });

  await store.replaceAdapterVersions({});
  expect((await readRaw(path)).transport).toEqual({
    type: "acpx-bridge",
    command: "custom-acpx",
    custom: true,
  });
  await rm(dir, { recursive: true, force: true });
});

test("updates channel reply mode while preserving channel ownerIds and unknown keys", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-cli" },
    channel: { type: "weixin", replyMode: "stream", ownerIds: ["wx-op"], custom: 1 },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });

  const store = new ConfigStore(path);
  const config = await store.updateChannel({ replyMode: "final" });

  expect(config.channel).toMatchObject({ type: "weixin", replyMode: "final" });

  const saved = await readRaw(path);
  expect(saved.channel).toEqual({ type: "weixin", replyMode: "final", ownerIds: ["wx-op"], custom: 1 });

  await rm(dir, { recursive: true, force: true });
});

test("replacePlugins only touches the plugins subtree", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: { home: { cwd: "~" } },
    plugins: [{ name: "@weacpx/channel-feishu", enabled: true }],
    extra: "kept",
  });

  const store = new ConfigStore(path);
  await store.replacePlugins([
    { name: "@weacpx/channel-feishu", version: "1.2.3", enabled: false },
  ]);

  const saved = await readRaw(path);
  expect(saved.plugins).toEqual([{ name: "@weacpx/channel-feishu", version: "1.2.3", enabled: false }]);
  expect(saved.extra).toBe("kept");
  expect((saved.workspaces as Record<string, Record<string, unknown>>).home?.cwd).toBe("~");

  await rm(dir, { recursive: true, force: true });
});

test("replaceChannels only touches the channels subtree (channel.ownerIds stays revocable)", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    channel: { type: "weixin", ownerIds: ["wx-op"] },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  const store = new ConfigStore(path);
  await store.replaceChannels([
    { id: "weixin", type: "weixin", enabled: true, replyMode: "final" },
  ]);

  const saved = await readRaw(path);
  expect(saved.channels).toEqual([{ id: "weixin", type: "weixin", enabled: true, replyMode: "final" }]);
  // channel.ownerIds is never baked into channels[] by a mutation.
  expect(saved.channel).toEqual({ type: "weixin", ownerIds: ["wx-op"] });

  await rm(dir, { recursive: true, force: true });
});

test("set/get/unset raw values support rollback to the previous raw state", async () => {
  const initial = {
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: { home: { cwd: "~" } },
    handEdited: { keep: true },
  };
  const { dir, path } = await makeConfigFile(initial);
  const before = await readFile(path, "utf8");

  const store = new ConfigStore(path);

  const previous = await store.getRawValue(["transport", "permissionMode"]);
  expect(previous).toEqual({ present: false });

  await store.setRawValue(["transport", "permissionMode"], "deny-all");
  expect(await store.getRawValue(["transport", "permissionMode"])).toEqual({
    present: true,
    value: "deny-all",
  });

  // Roll back: the previous value was absent, so unset restores it.
  await store.unsetRawValue(["transport", "permissionMode"]);
  expect(await readFile(path, "utf8")).toBe(before);

  // Present-value rollback round-trips byte-equivalent too.
  const prevCwd = await store.getRawValue(["workspaces", "home", "cwd"]);
  expect(prevCwd).toEqual({ present: true, value: "~" });
  await store.setRawValue(["workspaces", "home", "cwd"], "/tmp/elsewhere");
  await store.setRawValue(["workspaces", "home", "cwd"], (prevCwd as { value: unknown }).value);
  expect(await readFile(path, "utf8")).toBe(before);

  await rm(dir, { recursive: true, force: true });
});

test("setRawValue addresses channels[] entries by id and can materialize a synthesized entry", async () => {
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    channel: { type: "weixin", ownerIds: ["wx-op"] },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  const store = new ConfigStore(path);
  await store.setRawValue(
    ["channels", { id: "weixin", createWith: { id: "weixin", type: "weixin", enabled: true } }, "replyMode"],
    "final",
  );

  const saved = await readRaw(path);
  expect(saved.channels).toEqual([{ id: "weixin", type: "weixin", enabled: true, replyMode: "final" }]);
  // ownerIds is NOT copied into the materialized entry.
  expect(saved.channel).toEqual({ type: "weixin", ownerIds: ["wx-op"] });

  // Existing entries are patched in place.
  await store.setRawValue(["channels", { id: "weixin" }, "replyMode"], "stream");
  const saved2 = await readRaw(path);
  expect(saved2.channels).toEqual([{ id: "weixin", type: "weixin", enabled: true, replyMode: "stream" }]);

  await rm(dir, { recursive: true, force: true });
});

test("writes with 2-space indent, trailing newline, and owner-only permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-store-"));
  const path = join(dir, "config.json");

  // Use an existing file so the assertion targets only the indent/newline/mode,
  // not the brand-new-file section seeding (covered by its own test).
  await writeFile(path, `${JSON.stringify({ transport: { type: "acpx-bridge" }, agents: {}, workspaces: {} })}\n`);

  const store = new ConfigStore(path);
  await store.upsertAgent("codex", { driver: "codex" });

  const text = await readFile(path, "utf8");
  expect(text).toBe(
    `${JSON.stringify({ transport: { type: "acpx-bridge" }, agents: { codex: { driver: "codex" } }, workspaces: {} }, null, 2)}\n`,
  );
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }

  await rm(dir, { recursive: true, force: true });
});

test("concurrent patchRaw mutations all land — lock spans read→patch→write", async () => {
  // Pre-fix, the proper-lockfile lock only covered the WRITE inside
  // writePrivateFileAtomic: concurrent mutations all read the same snapshot
  // and the last writer erased the others' keys (lost update).
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });
  const store = new ConfigStore(path);

  const names = ["w1", "w2", "w3", "w4", "w5"];
  await Promise.all(names.map((name) => store.upsertWorkspace(name, `/repo/${name}`)));

  const raw = await readRaw(path);
  const workspaces = raw.workspaces as Record<string, { cwd: string }>;
  expect(Object.keys(workspaces).sort()).toEqual(names);
  for (const name of names) {
    expect(workspaces[name]).toEqual({ cwd: `/repo/${name}` });
  }

  await rm(dir, { recursive: true, force: true });
});

test("concurrent mutations from two ConfigStore instances on the same file all land", async () => {
  // Same race across separate store instances (e.g. /pm set during /config
  // set in two processes) — the file lock, not instance state, must serialize.
  const { dir, path } = await makeConfigFile({
    transport: { type: "acpx-bridge" },
    agents: {},
    workspaces: {},
  });
  const storeA = new ConfigStore(path);
  const storeB = new ConfigStore(path);

  await Promise.all([
    storeA.upsertAgent("codex", { driver: "codex" }),
    storeB.upsertWorkspace("backend", "/repo/backend"),
  ]);

  const raw = await readRaw(path);
  expect((raw.agents as Record<string, unknown>).codex).toEqual({ driver: "codex" });
  expect((raw.workspaces as Record<string, unknown>).backend).toEqual({ cwd: "/repo/backend" });

  await rm(dir, { recursive: true, force: true });
});
