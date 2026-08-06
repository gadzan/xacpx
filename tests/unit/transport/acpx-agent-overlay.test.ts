import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acpxConfigPath,
  computeAgentOverlayEntries,
  ensureAgentOverlays,
  mergeAcpxAgentOverlayEntry,
  parseAgentOverlayEntries,
} from "../../../src/transport/acpx-agent-overlay";
import { deriveAgentAlias } from "../../../src/config/agent-launch";
import { withPrivateFileLock } from "../../../src/util/private-file";
import { parseConfig } from "../../../src/config/load-config";

const codexAlias = deriveAgentAlias("codex", [
  "npx",
  "-y",
  "--registry=https://registry.npmjs.org",
  "--@agentclientprotocol:registry=https://registry.npmjs.org",
  "@agentclientprotocol/codex-acp@1.1.9",
]);
const codexEntry = {
  alias: codexAlias,
  argv: [
    "npx",
    "-y",
    "--registry=https://registry.npmjs.org",
    "--@agentclientprotocol:registry=https://registry.npmjs.org",
    "@agentclientprotocol/codex-acp@1.1.9",
  ],
};

test("merge adds a missing alias with exact argv", () => {
  const { config, outcome } = mergeAcpxAgentOverlayEntry({ defaultAgent: "codex" }, codexEntry);
  expect(outcome).toBe("provisioned");
  expect((config.agents as Record<string, unknown>)[codexAlias]).toEqual({ argv: codexEntry.argv });
  expect(config.defaultAgent).toBe("codex");
});

test("merge is a no-op when the alias already has identical argv", () => {
  const raw = { agents: { [codexAlias]: { argv: codexEntry.argv } } };
  const { config, outcome } = mergeAcpxAgentOverlayEntry(raw, codexEntry);
  expect(outcome).toBe("noop");
  expect(config).toBe(raw);
});

test("merge rejects an existing alias with different argv and never overwrites", () => {
  const raw = { agents: { [codexAlias]: { argv: ["npx", "codex-acp@0.0.1"] } } };
  const { config, outcome } = mergeAcpxAgentOverlayEntry(raw, codexEntry);
  expect(outcome).toBe("rejected");
  expect((config.agents as Record<string, unknown>)[codexAlias]).toEqual({ argv: ["npx", "codex-acp@0.0.1"] });
});

test("merge rejects malformed configs", () => {
  expect(() => mergeAcpxAgentOverlayEntry("not-an-object", codexEntry)).toThrow(/must be a JSON object/);
  expect(() => mergeAcpxAgentOverlayEntry({ agents: [] }, codexEntry)).toThrow(/agents.*must be an object/);
});

test("merge rejects a non-object existing alias instead of overwriting it", () => {
  const { config, outcome } = mergeAcpxAgentOverlayEntry(
    { agents: { [codexAlias]: "claude" } },
    codexEntry,
  );
  expect(outcome).toBe("rejected");
  expect((config.agents as Record<string, unknown>)[codexAlias]).toBe("claude");
});

test("computeAgentOverlayEntries covers managed, hermes and user argv but skips bare built-ins", () => {
  const config = parseConfig({
    transport: { preferLocalAgents: false },
    agents: {
      codex: { driver: "codex" },
      claude: { driver: "claude" },
      pool: { driver: "pool" },
      zeroclaw: { driver: "zeroclaw" },
      custom: { driver: "custom", argv: ["C:\\Program Files\\agent.exe", "--acp"] },
    },
    workspaces: {},
  });
  const entries = computeAgentOverlayEntries(config);
  const aliases = entries.map((entry) => entry.alias);
  expect(aliases).not.toContain("pool");
  expect(aliases).not.toContain("zeroclaw");
  expect(aliases).toContain(codexAlias);
  expect(aliases).toContain(deriveAgentAlias("custom", ["C:\\Program Files\\agent.exe", "--acp"]));
  expect(new Set(aliases).size).toBe(aliases.length);
});

test("parseAgentOverlayEntries validates the bridge env payload", () => {
  expect(parseAgentOverlayEntries(JSON.stringify([codexEntry]))).toEqual([codexEntry]);
  expect(() => parseAgentOverlayEntries("not json")).toThrow(/not valid JSON/);
  expect(() => parseAgentOverlayEntries(JSON.stringify([{ alias: "", argv: ["x"] }])))
    .toThrow(/non-empty alias/);
  expect(() => parseAgentOverlayEntries(JSON.stringify([{ alias: "a", argv: [] }])))
    .toThrow(/non-empty string array/);
});

test("ensureAgentOverlays provisions missing aliases and preserves user config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    await mkdir(join(dir, ".acpx"), { recursive: true });
    await writeFile(join(dir, ".acpx", "config.json"), JSON.stringify({
      defaultAgent: "claude",
      auth: { token: "secret" },
      agents: { "user-agent": { argv: ["/usr/bin/my-agent", "--acp"] } },
    }), { flag: "wx" });
    const result = await ensureAgentOverlays([codexEntry], { home: dir });
    expect(result.outcomes[codexAlias]).toBe("provisioned");

    const written = JSON.parse(await readFile(join(dir, ".acpx", "config.json"), "utf8")) as Record<string, any>;
    expect(written.defaultAgent).toBe("claude");
    expect(written.auth).toEqual({ token: "secret" });
    expect(written.agents["user-agent"]).toEqual({ argv: ["/usr/bin/my-agent", "--acp"] });
    expect(written.agents[codexAlias]).toEqual({ argv: codexEntry.argv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays creates the file when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    const result = await ensureAgentOverlays([codexEntry], { home: dir });
    expect(result.outcomes[codexAlias]).toBe("provisioned");
    const written = JSON.parse(await readFile(join(dir, ".acpx", "config.json"), "utf8")) as Record<string, any>;
    expect(written.agents[codexAlias]).toEqual({ argv: codexEntry.argv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays is a no-op when aliases already match", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    await mkdir(join(dir, ".acpx"), { recursive: true });
    await writeFile(join(dir, ".acpx", "config.json"), JSON.stringify({
      agents: { [codexAlias]: { argv: codexEntry.argv } },
    }), { flag: "wx" });
    const result = await ensureAgentOverlays([codexEntry], { home: dir });
    expect(result.outcomes[codexAlias]).toBe("noop");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays fails closed on a conflicting alias and preserves the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    await mkdir(join(dir, ".acpx"), { recursive: true });
    await writeFile(join(dir, ".acpx", "config.json"), JSON.stringify({
      agents: { [codexAlias]: { argv: ["npx", "codex-acp@0.0.1"] } },
    }), { flag: "wx" });
    await expect(ensureAgentOverlays([codexEntry], { home: dir })).rejects.toThrow(
      /already exists with a different argv/,
    );
    const written = JSON.parse(await readFile(join(dir, ".acpx", "config.json"), "utf8")) as Record<string, any>;
    expect(written.agents[codexAlias]).toEqual({ argv: ["npx", "codex-acp@0.0.1"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays fails closed on corrupt JSON and preserves the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    await mkdir(join(dir, ".acpx"), { recursive: true });
    const configPath = join(dir, ".acpx", "config.json");
    await writeFile(configPath, "{ not json", { flag: "wx" });
    await expect(ensureAgentOverlays([codexEntry], { home: dir })).rejects.toThrow(/not valid JSON/);
    expect(await readFile(configPath, "utf8")).toBe("{ not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays detects a concurrent modification and merges against the fresh content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    await mkdir(join(dir, ".acpx"), { recursive: true });
    const configPath = join(dir, ".acpx", "config.json");
    await writeFile(configPath, "{}", { flag: "wx" });
    const result = await ensureAgentOverlays([codexEntry], {
      home: dir,
      lockFn: async (path, fn) => {
        // Simulate a non-cooperative writer racing us before the lock is taken.
        await writeFile(path, '{"defaultAgent":"claude"}');
        return await withPrivateFileLock(path, fn);
      },
    });
    expect(result.raced).toBe(true);
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    expect(written.defaultAgent).toBe("claude");
    expect(written.agents[codexAlias]).toEqual({ argv: codexEntry.argv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent writers serialize and both aliases survive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    const otherAlias = deriveAgentAlias("claude", [
      "npx",
      "-y",
      "--registry=https://registry.npmjs.org",
      "--@agentclientprotocol:registry=https://registry.npmjs.org",
      "@agentclientprotocol/claude-agent-acp@0.64.2",
    ]);
    const otherEntry = {
      alias: otherAlias,
      argv: [
        "npx",
        "-y",
        "--registry=https://registry.npmjs.org",
        "--@agentclientprotocol:registry=https://registry.npmjs.org",
        "@agentclientprotocol/claude-agent-acp@0.64.2",
      ],
    };
    await Promise.all([
      ensureAgentOverlays([codexEntry], { home: dir }),
      ensureAgentOverlays([otherEntry], { home: dir }),
    ]);
    const written = JSON.parse(await readFile(join(dir, ".acpx", "config.json"), "utf8")) as Record<string, any>;
    expect(written.agents[codexAlias]).toEqual({ argv: codexEntry.argv });
    expect(written.agents[otherAlias]).toEqual({ argv: otherEntry.argv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays preserves the mode of an existing config and uses 0600 for new files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    await mkdir(join(dir, ".acpx"), { recursive: true });
    const configPath = join(dir, ".acpx", "config.json");
    await writeFile(configPath, "{}", { flag: "wx" });
    await chmod(configPath, 0o644);
    await ensureAgentOverlays([codexEntry], { home: dir });
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureAgentOverlays retries transient Windows write errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-overlay-"));
  try {
    let attempts = 0;
    const result = await ensureAgentOverlays([codexEntry], {
      home: dir,
      platform: "win32",
      delay: async () => {},
      writeAtomicFn: async (path, content) => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("EPERM: rename failed") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        await writeFile(path, content);
      },
    });
    expect(result.outcomes[codexAlias]).toBe("provisioned");
    expect(attempts).toBe(2);
    const written = JSON.parse(await readFile(join(dir, ".acpx", "config.json"), "utf8")) as Record<string, any>;
    expect(written.agents[codexAlias]).toEqual({ argv: codexEntry.argv });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acpxConfigPath points at the user acpx config", () => {
  expect(acpxConfigPath("/home/alice")).toBe("/home/alice/.acpx/config.json");
});
