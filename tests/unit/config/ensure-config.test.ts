import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { expect, test, beforeEach, afterAll } from "bun:test";
import { setLocale } from "../../../src/i18n";

beforeEach(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

import { ensureConfigExists, normalizeDefaultConfigTemplate } from "../../../src/config/ensure-config";
import { loadConfig } from "../../../src/config/load-config";

const SHIPPED_CONFIG_EXAMPLE = fileURLToPath(new URL("../../../config.example.json", import.meta.url));

test("shipped config.example.json ships only the portable home workspace (safe to copy verbatim)", async () => {
  // config.example.json doubles as the seed template and the file users naturally
  // copy to ~/.weacpx/config.json. The only seeded workspace must be machine-portable
  // (`~`) — never an absolute placeholder that would leak the author's paths or break
  // on copy, which is exactly what happened to a real user on first use.
  const raw = JSON.parse(await readFile(SHIPPED_CONFIG_EXAMPLE, "utf8")) as {
    workspaces?: Record<string, { cwd?: string }>;
  };
  expect(Object.keys(raw.workspaces ?? {})).toEqual(["home"]);
  expect(raw.workspaces?.home?.cwd).toBe("~");
});

test("builds a slim raw seed: validated by the shared parser, no pinned defaults", () => {
  const seed = normalizeDefaultConfigTemplate({
    transport: { type: "acpx-bridge", sessionInitTimeoutMs: 120000, permissionMode: "approve-all" },
    logging: { level: "info", maxSizeBytes: 2097152 },
    agents: {
      codex: { driver: "codex" },
    },
    workspaces: {
      backend: { cwd: "/tmp/backend" },
    },
  });

  // The seed contains only what a working starter file needs. Loader-supplied
  // defaults (timeouts, permission modes, logging numbers) are never pinned so
  // future default changes reach existing installs.
  expect(seed).toEqual({
    transport: { type: "acpx-bridge" },
    channel: { type: "weixin", replyMode: "verbose" },
    agents: {
      codex: { driver: "codex" },
    },
    workspaces: { home: { cwd: "~", description: "home directory" } },
  });
});

test("rejects an invalid default config template", () => {
  expect(() =>
    normalizeDefaultConfigTemplate({
      transport: { type: "bogus" },
      agents: {
        codex: { driver: "codex" },
      },
      workspaces: {},
    })
  ).toThrow("transport.type must be acpx-cli or acpx-bridge");
});

test("ensureConfigExists falls back to the built-in default template when bundled template is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-ensure-config-"));
  const configPath = join(dir, "config.json");

  try {
    await ensureConfigExists(configPath, {
      readDefaultConfigTemplate: async () => {
        const error = new Error("missing template") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    const raw = JSON.parse(await readFile(configPath, "utf8")) as {
      transport: Record<string, unknown>;
      logging?: unknown;
    };
    expect(raw).toMatchObject({
      transport: {
        type: "acpx-bridge",
      },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: { home: { cwd: "~", description: "home directory" } },
    });
    // Defaults stay loader-side: the seed must not freeze them into the file.
    expect(raw.transport.permissionMode).toBeUndefined();
    expect(raw.transport.sessionInitTimeoutMs).toBeUndefined();
    expect(raw.logging).toBeUndefined();

    const parsed = await loadConfig(configPath);
    expect(parsed.transport.permissionMode).toBe("approve-all");
    expect(parsed.orchestration.progressHeartbeatSeconds).toBe(300);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ensureConfigExists normalizes injected default config templates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-ensure-config-"));
  const configPath = join(dir, "config.json");

  try {
    await ensureConfigExists(configPath, {
      readDefaultConfigTemplate: async () =>
        ({
          transport: { type: "acpx-bridge" },
          agents: { codex: { driver: "codex" } },
          workspaces: { backend: { cwd: "/tmp/backend" } },
        }) as never,
    });

    const parsed = await loadConfig(configPath);
    expect(parsed.transport).toMatchObject({
      type: "acpx-bridge",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    // The seed always injects only `home`, ignoring the template's own workspaces;
    // `~` is expanded to the real home dir on load (forward-slashed, the
    // canonical stored form).
    expect(parsed.workspaces).toEqual({
      home: { cwd: homedir().replaceAll("\\", "/"), description: "home directory" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
