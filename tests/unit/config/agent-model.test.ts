import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../../../src/config/load-config";
import { ConfigStore } from "../../../src/config/config-store";

function baseRaw(agentExtra: Record<string, unknown>) {
  return {
    transport: { type: "acpx-cli", command: "acpx" },
    agents: { codex: { driver: "codex", ...agentExtra } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  };
}

test("parseConfig preserves an agent's model field", () => {
  const config = parseConfig(baseRaw({ model: "gpt-5.2[high]" }));
  expect(config.agents.codex.model).toBe("gpt-5.2[high]");
});

test("parseConfig drops a blank model", () => {
  const config = parseConfig(baseRaw({ model: "   " }));
  expect(config.agents.codex.model).toBeUndefined();
});

async function withStore(run: (store: ConfigStore, path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-agent-model-"));
  const path = join(dir, "config.json");
  await writeFile(path, `${JSON.stringify(baseRaw({}), null, 2)}\n`);
  try {
    await run(new ConfigStore(path), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("upsertAgent persists the model to disk and round-trips through load", async () => {
  await withStore(async (store, path) => {
    await store.load();
    await store.upsertAgent("codex", { driver: "codex", model: "gpt-5.2[high]" });
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.agents.codex.model).toBe("gpt-5.2[high]");
    const reloaded = await store.load();
    expect(reloaded.agents.codex.model).toBe("gpt-5.2[high]");
  });
});
