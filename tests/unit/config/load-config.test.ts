import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, parseConfig } from "../../../src/config/load-config";
import { resolveChannelOwnerIds, withEffectiveOwner } from "../../../src/commands/command-policy";

test("loads a valid config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          description: "backend repo",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.type).toBe("acpx-cli");
  expect(config.workspaces.backend.cwd).toBe("/tmp/backend");
  expect(config.transport.sessionInitTimeoutMs).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});

test("loads an explicit Claude settings policy and leaves the default implicit", () => {
  const explicit = parseConfig({
    transport: {},
    agents: { claude: { driver: "claude", settingsPolicy: "isolated" } },
    workspaces: {},
  });
  const implicit = parseConfig({
    transport: {},
    agents: { claude: { driver: "claude" } },
    workspaces: {},
  });

  expect(explicit.agents.claude.settingsPolicy).toBe("isolated");
  expect(implicit.agents.claude.settingsPolicy).toBeUndefined();
});

test("rejects an invalid Claude settings policy", () => {
  expect(() => parseConfig({
    transport: {},
    agents: { claude: { driver: "claude", settingsPolicy: "everything" } },
    workspaces: {},
  })).toThrow("settingsPolicy must be provider-only, isolated, or full-user");
});

test("loads a workspace without allowed_agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          description: "backend repo",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.workspaces.backend).toEqual({
    cwd: "/tmp/backend",
    description: "backend repo",
  });

  await rm(dir, { recursive: true, force: true });
});

test("defaults transport.type to acpx-bridge when omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.type).toBe("acpx-bridge");

  await rm(dir, { recursive: true, force: true });
});

test("loads an optional transport session init timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx", sessionInitTimeoutMs: 120000 },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.sessionInitTimeoutMs).toBe(120000);

  await rm(dir, { recursive: true, force: true });
});

test("defaults transport.queueOwnerTtlSeconds to 1800", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.queueOwnerTtlSeconds).toBe(1800);

  await rm(dir, { recursive: true, force: true });
});

test("loads an explicit transport.queueOwnerTtlSeconds (including 0 = forever)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx", queueOwnerTtlSeconds: 0 },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.queueOwnerTtlSeconds).toBe(0);

  await rm(dir, { recursive: true, force: true });
});

test("threads an explicit transport.preferLocalAgents through to the runtime config", async () => {
  // Regression: the loader validated preferLocalAgents but dropped it from the
  // returned transport object, so `preferLocalAgents: false` was a no-op and a
  // host with a native CLI installed always resolved to the local command.
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx", preferLocalAgents: false },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.preferLocalAgents).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("leaves transport.preferLocalAgents undefined when omitted (defaults to preferring local)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.preferLocalAgents).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});

test("parses exact managed adapter version overrides", async () => {
  const config = parseConfig({
    transport: { adapterVersions: { codex: "1.1.2", claude: "0.58.1" } },
    agents: {},
    workspaces: {},
  });
  expect(config.transport.adapterVersions).toEqual({ codex: "1.1.2", claude: "0.58.1" });
});

test("parses and normalizes a custom adapter registry", () => {
  const config = parseConfig({
    transport: { adapterRegistry: "https://npm.corp.example/repository/npm" },
    agents: {},
    workspaces: {},
  });
  expect(config.transport.adapterRegistry).toBe("https://npm.corp.example/repository/npm");
});

test("rejects unsafe adapter registry URLs", () => {
  for (const adapterRegistry of [
    "file:///tmp/npm",
    "https://user:secret@npm.example/",
    "https://npm.example/repository?token=secret",
  ]) {
    expect(() => parseConfig({
      transport: { adapterRegistry }, agents: {}, workspaces: {},
    })).toThrow("transport.adapterRegistry");
  }
});

test("rejects ranges and unknown managed adapter ids", async () => {
  expect(() => parseConfig({
    transport: { adapterVersions: { codex: "^1.1.2" } }, agents: {}, workspaces: {},
  })).toThrow("transport.adapterVersions.codex must be an exact semver version");
  expect(() => parseConfig({
    transport: { adapterVersions: { other: "1.0.0" } }, agents: {}, workspaces: {},
  })).toThrow("transport.adapterVersions contains unsupported adapter other");
});

test("rejects a negative transport.queueOwnerTtlSeconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx", queueOwnerTtlSeconds: -5 },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("transport.queueOwnerTtlSeconds");

  await rm(dir, { recursive: true, force: true });
});

test("threads an explicit transport.turnIdleTimeoutSeconds through (including 0 = disabled)", async () => {
  // Regression: the loader whitelists transport fields into a new object, so an
  // un-copied turnIdleTimeoutSeconds would be dropped and the watchdog knob would be dead.
  for (const value of [0, 300]) {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
    const path = join(dir, "config.json");

    await writeFile(
      path,
      JSON.stringify({
        transport: { type: "acpx-cli", command: "acpx", turnIdleTimeoutSeconds: value },
        agents: { codex: { driver: "codex" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    const config = await loadConfig(path);
    expect(config.transport.turnIdleTimeoutSeconds).toBe(value);

    await rm(dir, { recursive: true, force: true });
  }
});

test("leaves transport.turnIdleTimeoutSeconds undefined when omitted (resolver owns the default)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.turnIdleTimeoutSeconds).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});

test("rejects a negative transport.turnIdleTimeoutSeconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx", turnIdleTimeoutSeconds: -5 },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("transport.turnIdleTimeoutSeconds");

  await rm(dir, { recursive: true, force: true });
});

test("defaults transport permission policy to approve-all and deny", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.permissionMode).toBe("approve-all");
  expect(config.transport.nonInteractivePermissions).toBe("deny");

  await rm(dir, { recursive: true, force: true });
});

test("loads explicit transport permission policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        command: "acpx",
        permissionMode: "approve-reads",
        nonInteractivePermissions: "deny",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.transport.permissionMode).toBe("approve-reads");
  expect(config.transport.nonInteractivePermissions).toBe("deny");

  await rm(dir, { recursive: true, force: true });
});

test("loads optional transport.permissionPolicy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
        permissionPolicy: "C:/policies/weacpx-policy.json",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect((config.transport as unknown as { permissionPolicy?: string }).permissionPolicy).toBe("C:/policies/weacpx-policy.json");

  await rm(dir, { recursive: true, force: true });
});

test("rejects empty transport.permissionPolicy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
        permissionPolicy: "   ",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("transport.permissionPolicy must be a non-empty string");

  await rm(dir, { recursive: true, force: true });
});

test("rejects allow for explicit non-interactive permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: {
        type: "acpx-bridge",
        command: "acpx",
        permissionMode: "approve-all",
        nonInteractivePermissions: "allow",
      },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("transport.nonInteractivePermissions must be deny or fail");

  await rm(dir, { recursive: true, force: true });
});

test("loads an optional raw agent command for non-codex agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        custom: {
          driver: "custom",
          command: "npx some-agent",
        },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.agents.custom?.command).toBe("npx some-agent");

  await rm(dir, { recursive: true, force: true });
});

test("defaults logging to bounded info mode when omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.logging).toEqual({
    level: "info",
    maxSizeBytes: 2 * 1024 * 1024,
    maxFiles: 5,
    retentionDays: 7,
    perf: {
      enabled: false,
      maxSizeBytes: 5 * 1024 * 1024,
      maxFiles: 3,
      retentionDays: 7,
    },
  });
  expect(config.channel).toEqual({
    type: "weixin",
    replyMode: "verbose",
  });
  expect(config.orchestration).toEqual({
    maxPendingAgentRequestsPerCoordinator: 3,
    allowWorkerChainedRequests: false,
    allowedAgentRequestTargets: [],
    allowedAgentRequestRoles: [],
    progressHeartbeatSeconds: 300,
    maxParallelTasksPerAgent: 3,
  });

  await rm(dir, { recursive: true, force: true });
});

test("loads explicit orchestration guardrail overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 5,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: ["claude", "codex"],
        allowedAgentRequestRoles: ["reviewer", "planner"],
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.orchestration).toEqual({
    maxPendingAgentRequestsPerCoordinator: 5,
    allowWorkerChainedRequests: true,
    allowedAgentRequestTargets: ["claude", "codex"],
    allowedAgentRequestRoles: ["reviewer", "planner"],
    progressHeartbeatSeconds: 300,
    maxParallelTasksPerAgent: 3,
  });

  await rm(dir, { recursive: true, force: true });
});

test("defaults orchestration guardrails when omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.orchestration).toEqual({
    maxPendingAgentRequestsPerCoordinator: 3,
    allowWorkerChainedRequests: false,
    allowedAgentRequestTargets: [],
    allowedAgentRequestRoles: [],
    progressHeartbeatSeconds: 300,
    maxParallelTasksPerAgent: 3,
  });

  await rm(dir, { recursive: true, force: true });
});

test("loads explicit wechat reply mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      wechat: { replyMode: "final" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.channel).toEqual({ type: "weixin", replyMode: "final" });
  expect("wechat" in config).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("loads an explicit logging configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: {
        level: "debug",
        maxSizeBytes: 65536,
        maxFiles: 3,
        retentionDays: 2,
      },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.logging).toEqual({
    level: "debug",
    maxSizeBytes: 65536,
    maxFiles: 3,
    retentionDays: 2,
    perf: {
      enabled: false,
      maxSizeBytes: 5 * 1024 * 1024,
      maxFiles: 3,
      retentionDays: 7,
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("drops the legacy raw codex command so codex uses the built-in acpx alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: {
          driver: "codex",
          command: "./node_modules/.bin/codex-acp",
        },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const config = await loadConfig(path);
  expect(config.agents.codex).toEqual({ driver: "codex" });

  await rm(dir, { recursive: true, force: true });
});

test("throws when transport.type is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "nope" },
      agents: {},
      workspaces: {},
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("transport.type");
  await rm(dir, { recursive: true, force: true });
});

test("throws when transport.sessionInitTimeoutMs is not a positive number", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", sessionInitTimeoutMs: 0 },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("transport.sessionInitTimeoutMs");
  await rm(dir, { recursive: true, force: true });
});

test("loads explicit channel reply mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { type: "weixin", replyMode: "final" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  const config = await loadConfig(path);
  expect(config.channel).toEqual({ type: "weixin", replyMode: "final" });

  await rm(dir, { recursive: true, force: true });
});

test("defaults channel config when channel and legacy wechat are omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  const config = await loadConfig(path);
  expect(config.channel).toEqual({ type: "weixin", replyMode: "verbose" });

  await rm(dir, { recursive: true, force: true });
});

test("maps legacy wechat reply mode to channel config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      wechat: { replyMode: "stream" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  const config = await loadConfig(path);
  expect(config.channel).toEqual({ type: "weixin", replyMode: "stream" });
  expect("wechat" in config).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("prefers channel over legacy wechat when both are present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { type: "weixin", replyMode: "final" },
      wechat: { replyMode: "stream" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  const config = await loadConfig(path);
  expect(config.channel).toEqual({ type: "weixin", replyMode: "final" });

  await rm(dir, { recursive: true, force: true });
});

test("throws when channel is not an object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: "weixin",
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("channel must be an object");
  await rm(dir, { recursive: true, force: true });
});

test("throws when channel.type is not a string", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { type: 123, replyMode: "stream" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("channel.type must be a string");
  await rm(dir, { recursive: true, force: true });
});

test("throws when channel.replyMode is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { type: "weixin", replyMode: "chatty" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("channel.replyMode must be stream, final, or verbose");
  await rm(dir, { recursive: true, force: true });
});

test("throws when legacy wechat.replyMode is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      wechat: { replyMode: "chatty" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow("wechat.replyMode must be stream, final, or verbose");
  await rm(dir, { recursive: true, force: true });
});

test("loads multiple enabled channel runtime configs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { replyMode: "final" },
      channels: [
        { id: "weixin", type: "weixin", enabled: true },
        {
          id: "feishu-main",
          type: "feishu",
          enabled: true,
          feishu: {
            appId: "cli_test",
            appSecret: "secret_test",
            domain: "feishu",
          },
        },
      ],
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  try {
    const config = await loadConfig(path);

    expect(config.channel.replyMode).toBe("final");
    expect(config.channels).toEqual([
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu-main",
        type: "feishu",
        enabled: true,
        options: {
          appId: "cli_test",
          appSecret: "secret_test",
          domain: "feishu",
        },
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps legacy channel.type to a single enabled runtime channel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { type: "weixin", replyMode: "verbose" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  try {
    const config = await loadConfig(path);

    expect(config.channel).toEqual({ type: "weixin", replyMode: "verbose" });
    expect(config.channels).toEqual([{ id: "weixin", type: "weixin", enabled: true }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects duplicate channel ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { replyMode: "final" },
      channels: [
        { id: "weixin", type: "weixin" },
        { id: "weixin", type: "weixin" },
      ],
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  try {
    await expect(loadConfig(path)).rejects.toThrow("channels ids must be unique");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fills logging.perf with defaults when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: {
        level: "info",
        maxSizeBytes: 2 * 1024 * 1024,
        maxFiles: 5,
        retentionDays: 7,
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  try {
    const config = await loadConfig(path);
    expect(config.logging.perf).toEqual({
      enabled: false,
      maxSizeBytes: 5 * 1024 * 1024,
      maxFiles: 3,
      retentionDays: 7,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preserves explicitly set logging.perf values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: {
        level: "info",
        perf: { enabled: true, maxSizeBytes: 1048576, maxFiles: 2, retentionDays: 3 },
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  try {
    const config = await loadConfig(path);
    expect(config.logging.perf.enabled).toBe(true);
    expect(config.logging.perf.maxSizeBytes).toBe(1048576);
    expect(config.logging.perf.maxFiles).toBe(2);
    expect(config.logging.perf.retentionDays).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects non-object logging.perf with clear error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: { perf: "not-an-object" },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  try {
    await expect(loadConfig(path)).rejects.toThrow("logging.perf must be an object");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects non-boolean logging.perf.enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: { perf: { enabled: "yes" } },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  try {
    await expect(loadConfig(path)).rejects.toThrow("logging.perf.enabled must be boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepts logging.perf.maxFiles=0 (no rotation)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: {
        level: "info",
        perf: { enabled: true, maxSizeBytes: 1048576, maxFiles: 0, retentionDays: 3 },
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  try {
    const config = await loadConfig(path);
    expect(config.logging.perf.maxFiles).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects negative logging.perf.maxFiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      logging: {
        level: "info",
        perf: { enabled: true, maxSizeBytes: 1048576, maxFiles: -1, retentionDays: 3 },
      },
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    }),
  );

  try {
    await expect(loadConfig(path)).rejects.toThrow("logging.perf.maxFiles must be non-negative");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestration.maxParallelTasksPerAgent defaults to 3", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  try {
    const config = await loadConfig(path);
    expect(config.orchestration.maxParallelTasksPerAgent).toBe(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestration.maxParallelTasksPerAgent accepts a positive override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
      orchestration: { maxParallelTasksPerAgent: 5 },
    }),
  );

  try {
    const config = await loadConfig(path);
    expect(config.orchestration.maxParallelTasksPerAgent).toBe(5);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function loadConfigWithMaxParallelTasksPerAgent(maxParallelTasksPerAgent: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
      orchestration: { maxParallelTasksPerAgent },
    }),
  );
  try {
    return await loadConfig(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("orchestration.maxParallelTasksPerAgent rejects non-positive / non-finite values", async () => {
  expect((await loadConfigWithMaxParallelTasksPerAgent(0)).orchestration.maxParallelTasksPerAgent).toBe(3);
  expect((await loadConfigWithMaxParallelTasksPerAgent(-1)).orchestration.maxParallelTasksPerAgent).toBe(3);
  expect((await loadConfigWithMaxParallelTasksPerAgent(Infinity)).orchestration.maxParallelTasksPerAgent).toBe(3);
  expect((await loadConfigWithMaxParallelTasksPerAgent(NaN)).orchestration.maxParallelTasksPerAgent).toBe(3);
});

test("orchestration.maxParallelTasksPerAgent floors a positive float to an integer", async () => {
  expect((await loadConfigWithMaxParallelTasksPerAgent(2.5)).orchestration.maxParallelTasksPerAgent).toBe(2);
});

test("parses a valid language field", () => {
  const cfg = parseConfig({
    transport: { type: "acpx-cli", command: "acpx" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    language: "zh",
  });
  expect(cfg.language).toBe("zh");
});

test("drops an invalid language field", () => {
  const cfg = parseConfig({
    transport: { type: "acpx-cli", command: "acpx" },
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    language: "fr",
  });
  expect(cfg.language).toBeUndefined();
});

test("normalizes legacy weacpx channel plugin package names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
      plugins: [
        { name: "@ganglion/weacpx-channel-feishu", version: "0.2.2", enabled: true },
        { name: "@ganglion/weacpx-channel-yuanbao", enabled: false },
      ],
    }),
  );

  const config = await loadConfig(path);

  expect(config.plugins).toEqual([
    { name: "@ganglion/xacpx-channel-feishu", version: "0.2.2", enabled: true },
    { name: "@ganglion/xacpx-channel-yuanbao", enabled: false },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("deduplicates legacy and canonical channel plugin package names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      agents: { codex: { driver: "codex" } },
      workspaces: {},
      plugins: [
        { name: "@ganglion/weacpx-channel-feishu", version: "0.2.2", enabled: true },
        { name: "@ganglion/xacpx-channel-feishu", enabled: true },
      ],
    }),
  );

  const config = await loadConfig(path);

  expect(config.plugins).toEqual([{ name: "@ganglion/xacpx-channel-feishu", enabled: true }]);

  await rm(dir, { recursive: true, force: true });
});

test("loads an explicit per-channel replyMode in channels[]", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channel: { type: "weixin", replyMode: "verbose" },
      channels: [
        { id: "weixin", type: "weixin", enabled: true, replyMode: "final" },
        { id: "feishu", type: "feishu", enabled: true },
      ],
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  const config = await loadConfig(path);
  expect(config.channels.find((c) => c.id === "weixin")?.replyMode).toBe("final");
  expect(config.channels.find((c) => c.id === "feishu")?.replyMode).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});

test("omitting channels[].replyMode leaves it undefined (backward compatible)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channels: [{ id: "weixin", type: "weixin", enabled: true }],
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  const config = await loadConfig(path);
  expect(config.channels[0]?.replyMode).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});

test("throws when channels[].replyMode is invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-config-"));
  const path = join(dir, "config.json");

  await writeFile(
    path,
    JSON.stringify({
      transport: { type: "acpx-bridge" },
      channels: [{ id: "weixin", type: "weixin", enabled: true, replyMode: "loud" }],
      agents: { codex: { driver: "codex" } },
      workspaces: {},
    }),
  );

  await expect(loadConfig(path)).rejects.toThrow(
    "channels[0].replyMode must be stream, final, or verbose",
  );

  await rm(dir, { recursive: true, force: true });
});

test("parses channel.ownerIds without copying it into the synthesized runtime channel", async () => {
  const config = parseConfig({
    transport: { type: "acpx-bridge" },
    channel: { type: "weixin", ownerIds: ["wx-op", " wx-op-2 "] },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  expect(config.channel.ownerIds).toEqual(["wx-op", "wx-op-2"]);
  // No parse-time copy: the policy resolver unions channel.ownerIds and
  // channels[].ownerIds live, and a baked copy would survive saves and make
  // a later revocation via channel.ownerIds silently ineffective.
  expect(config.channels).toEqual([{ id: "weixin", type: "weixin", enabled: true }]);
});

test("save/reload round-trip keeps ownerIds revocable via channel.ownerIds", async () => {
  const first = parseConfig({
    transport: { type: "acpx-bridge" },
    channel: { type: "weixin", ownerIds: ["wx-op"] },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  // A round-trip of the parsed object: the synthesized runtime channel carries
  // no baked ownerIds copy, so editing channel.ownerIds stays effective.
  const persisted = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
  expect((persisted.channels as Array<Record<string, unknown>>)[0]?.ownerIds).toBeUndefined();

  // Operator revokes by editing channel.ownerIds in the saved file.
  (persisted.channel as Record<string, unknown>).ownerIds = [];
  const reloaded = parseConfig(persisted);

  expect(resolveChannelOwnerIds(reloaded, "weixin")).toEqual([]);
  expect(
    withEffectiveOwner({ channel: "weixin", chatType: "group", senderId: "wx-op" }, reloaded),
  ).toMatchObject({ isOwner: false });
});

test("parses channels[].ownerIds", async () => {
  const config = parseConfig({
    transport: { type: "acpx-bridge" },
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      { id: "feishu", type: "feishu", enabled: true, ownerIds: ["ou-op"] },
    ],
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  expect(config.channels[0]?.ownerIds).toBeUndefined();
  expect(config.channels[1]?.ownerIds).toEqual(["ou-op"]);
});

test("leaves ownerIds undefined when omitted", async () => {
  const config = parseConfig({
    transport: { type: "acpx-bridge" },
    channel: { type: "weixin" },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  });

  expect(config.channel.ownerIds).toBeUndefined();
  expect(config.channels[0]?.ownerIds).toBeUndefined();
});

test("throws on invalid ownerIds shapes", async () => {
  const base = {
    transport: { type: "acpx-bridge" },
    agents: { codex: { driver: "codex" } },
    workspaces: {},
  };

  expect(() => parseConfig({ ...base, channel: { type: "weixin", ownerIds: "wx-op" } })).toThrow(
    "channel.ownerIds must be an array of non-empty strings",
  );
  expect(() => parseConfig({ ...base, channel: { type: "weixin", ownerIds: [1, 2] } })).toThrow(
    "channel.ownerIds must be an array of non-empty strings",
  );
  expect(() => parseConfig({ ...base, channel: { type: "weixin", ownerIds: ["", "wx"] } })).toThrow(
    "channel.ownerIds must be an array of non-empty strings",
  );
  expect(() =>
    parseConfig({
      ...base,
      channels: [{ id: "feishu", type: "feishu", enabled: true, ownerIds: [null] }],
    }),
  ).toThrow("channels[0].ownerIds must be an array of non-empty strings");
});
