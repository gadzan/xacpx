import { expect, test, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../../../src/config/config-store";
import { AsyncMutex } from "../../../../src/orchestration/async-mutex";
import { handleConfigSet } from "../../../../src/commands/handlers/config-handler";
import { setLocale } from "../../../../src/i18n";

beforeEach(() => setLocale("zh"));

async function makeContext() {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-config-handler-"));
  const configPath = join(dir, "config.json");
  const store = new ConfigStore(configPath);
  await store.updateTransport({ type: "acpx-cli" });
  await store.updateChannel({ type: "weixin", replyMode: "verbose" });
  await store.replaceChannels([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "feishu", type: "feishu", enabled: true },
  ]);
  const config = await store.load();
  const replaced: any[] = [];
  return {
    configPath,
    replaced,
    context: {
      config,
      configStore: store,
      transport: {},
      replaceConfig: (c: any) => {
        replaced.push(c);
      },
      configMutationMutex: new AsyncMutex(),
    } as any,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("/config set channels.feishu.replyMode final writes the per-channel default", async () => {
  const { context, configPath, replaced, cleanup } = await makeContext();
  try {
    const result = await handleConfigSet(context, "channels.feishu.replyMode", "final");
    expect(result.text).not.toContain("不支持");
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.channels.find((c: any) => c.id === "feishu").replyMode).toBe("final");
    expect(saved.channels.find((c: any) => c.id === "weixin").replyMode).toBeUndefined();
    // Success path must also swap the in-memory runtime config, not just persist to disk.
    expect(replaced.length).toBe(1);
    expect(replaced[0].channels.find((c: any) => c.id === "feishu").replyMode).toBe("final");
  } finally {
    await cleanup();
  }
});

test("/config set rejects an invalid replyMode value", async () => {
  const { context, configPath, cleanup } = await makeContext();
  try {
    const before = await readFile(configPath, "utf8");
    const result = await handleConfigSet(context, "channels.feishu.replyMode", "loud");
    expect(result.text).toContain("stream");
    expect(await readFile(configPath, "utf8")).toBe(before);
  } finally {
    await cleanup();
  }
});

test("/config set rejects an unknown channel id", async () => {
  const { context, configPath, cleanup } = await makeContext();
  try {
    const before = await readFile(configPath, "utf8");
    const result = await handleConfigSet(context, "channels.nope.replyMode", "final");
    expect(result.text).toContain("nope");
    expect(await readFile(configPath, "utf8")).toBe(before);
  } finally {
    await cleanup();
  }
});
