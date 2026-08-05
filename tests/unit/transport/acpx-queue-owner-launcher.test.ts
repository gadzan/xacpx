import { expect, mock, test } from "bun:test";

import {
  buildXacpxMcpServerSpec,
  buildQueueOwnerPayload,
  AcpxQueueOwnerLauncher,
  type QueueOwnerSpawner,
  type QueueOwnerTerminator,
  type QueueOwnerAdapterContext,
} from "../../../src/transport/acpx-queue-owner-launcher";

const TOKEN = "11111111-1111-4111-8111-111111111111";
const MANAGED_COMMAND = '"C:/node.exe" "C:/runtime/adapters/codex/releases/1/node_modules/@agentclientprotocol/codex-acp/bin.js"';

function adapterContext(overrides: Partial<QueueOwnerAdapterContext> = {}): QueueOwnerAdapterContext {
  return {
    id: "codex",
    sessionKey: "logical",
    agentCommand: MANAGED_COMMAND,
    platform: "win32",
    prepare: async () => ({ agentCommand: MANAGED_COMMAND, generationId: "generation-1" }),
    isGenerationCurrent: async () => true,
    spawned: async () => {},
    cancel: async () => {},
    settle: async () => {},
    ...overrides,
  };
}

test("builds coordinator MCP server spec from a session identity", () => {
  expect(buildXacpxMcpServerSpec({
    xacpxCommand: "node ./dist/cli.js",
    coordinatorSession: "backend:main",
  })).toEqual({
    name: "xacpx",
    type: "stdio",
    command: "node",
    args: ["./dist/cli.js", "mcp-stdio", "--coordinator-session", "backend:main", "--internal-session-tools"],
  });
});

test("builds worker MCP server spec with source handle", () => {
  expect(buildXacpxMcpServerSpec({
    xacpxCommand: "node ./dist/cli.js",
    coordinatorSession: "backend:main",
    sourceHandle: "backend:claude:backend:main",
  })).toEqual({
    name: "xacpx",
    type: "stdio",
    command: "node",
    args: [
      "./dist/cli.js",
      "mcp-stdio",
      "--coordinator-session",
      "backend:main",
      "--source-handle",
      "backend:claude:backend:main",
    ],
  });
});

test("builds queue owner payload with MCP servers", () => {
  expect(buildQueueOwnerPayload({
    sessionId: "acpx-record-1",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    mcpServers: [{ name: "xacpx", type: "stdio", command: "node", args: ["cli.js"] }],
  })).toEqual({
    sessionId: "acpx-record-1",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    ttlMs: 300_000,
    maxQueueDepth: 16,
    mcpServers: [{ name: "xacpx", type: "stdio", command: "node", args: ["cli.js"] }],
  });
});

test("builds queue owner payload with prompt retries and session options", () => {
  expect(buildQueueOwnerPayload({
    sessionId: "acpx-record-1",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    promptRetries: 2,
    sessionOptions: {
      model: "gpt-5",
      allowedTools: ["delegate_request"],
      maxTurns: 20,
      systemPrompt: { append: "You are a helpful assistant." },
    },
    mcpServers: [{ name: "xacpx", type: "stdio", command: "node", args: ["cli.js"] }],
  })).toEqual({
    sessionId: "acpx-record-1",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    ttlMs: 300_000,
    maxQueueDepth: 16,
    promptRetries: 2,
    sessionOptions: {
      model: "gpt-5",
      allowedTools: ["delegate_request"],
      maxTurns: 20,
      systemPrompt: { append: "You are a helpful assistant." },
    },
    mcpServers: [{ name: "xacpx", type: "stdio", command: "node", args: ["cli.js"] }],
  });
});

test("terminates existing owner then starts acpx queue owner with payload", async () => {
  const spawns: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const spawnOwner: QueueOwnerSpawner = mock(async (command, args, options) => {
    spawns.push({ command, args, env: options.env });
  });
  const terminated: string[] = [];
  const terminateOwner: QueueOwnerTerminator = mock(async (sessionId) => {
    terminated.push(sessionId);
  });
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "E:/node/acpx/dist/cli.js",
    xacpxCommand: "node ./dist/cli.js",
    spawnOwner,
    terminateOwner,
  });

  await launcher.launch({
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });

  expect(terminated).toEqual(["acpx-record-1"]);
  expect(spawns).toHaveLength(1);
  expect(spawns[0].command).toBe(process.execPath);
  expect(spawns[0].args).toEqual(["E:/node/acpx/dist/cli.js", "__queue-owner"]);
  const payload = JSON.parse(spawns[0].env.ACPX_QUEUE_OWNER_PAYLOAD);
  expect(payload.sessionId).toBe("acpx-record-1");
  expect(payload.mcpServers[0]).toMatchObject({
    name: "xacpx",
    command: "node",
    args: ["./dist/cli.js", "mcp-stdio", "--coordinator-session", "backend:main", "--internal-session-tools"],
  });
});

test("forwards a configured ttlMs into the queue owner payload", async () => {
  const spawns: Array<{ env: Record<string, string> }> = [];
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    ttlMs: 1_800_000,
    spawnOwner: async (_command, _args, options) => {
      spawns.push({ env: options.env });
    },
    terminateOwner: async () => {},
  });

  await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });

  const payload = JSON.parse(spawns[0].env.ACPX_QUEUE_OWNER_PAYLOAD);
  expect(payload.ttlMs).toBe(1_800_000);
});

test("uses a filtered per-agent environment as authoritative for the queue owner", async () => {
  let spawnedEnv: Record<string, string> | undefined;
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    baseEnv: {
      BASE: "yes",
      ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1",
      ANTHROPIC_AUTH_TOKEN: "stale",
    },
    spawnOwner: async (_command, _args, options) => { spawnedEnv = options.env; },
    terminateOwner: async () => {},
  });

  await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    env: { ANTHROPIC_AUTH_TOKEN: "filtered", CLAUDE_CONFIG_DIR: "C:/original" },
  });

  expect(spawnedEnv).toEqual(expect.objectContaining({
    ANTHROPIC_AUTH_TOKEN: "filtered",
    CLAUDE_CONFIG_DIR: "C:/original",
  }));
  expect(spawnedEnv?.BASE).toBeUndefined();
  expect(spawnedEnv?.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBeUndefined();
});

test("forwards ttlMs of 0 (keep alive forever) into the queue owner payload", async () => {
  const spawns: Array<{ env: Record<string, string> }> = [];
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    ttlMs: 0,
    spawnOwner: async (_command, _args, options) => {
      spawns.push({ env: options.env });
    },
    terminateOwner: async () => {},
  });

  await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });

  const payload = JSON.parse(spawns[0].env.ACPX_QUEUE_OWNER_PAYLOAD);
  expect(payload.ttlMs).toBe(0);
});

test("cleans per-record launch locks after launch settles", async () => {
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    spawnOwner: async () => {},
    terminateOwner: async () => {},
  });

  for (let i = 0; i < 3; i++) {
    await launcher.launch({
      acpxRecordId: `record-${i}`,
      coordinatorSession: "backend:main",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
  }
  await Promise.resolve();

  const internals = launcher as unknown as { launchLocks: Map<string, Promise<void>> };
  expect(internals.launchLocks.size).toBe(0);
});

test("parses quoted weacpx command paths with spaces", () => {
  expect(buildXacpxMcpServerSpec({
    xacpxCommand: '"C:/Program Files/nodejs/node.exe" "E:/projects/weacpx/dist/cli.js"',
    coordinatorSession: "backend:main",
  })).toEqual({
    name: "xacpx",
    type: "stdio",
    command: "C:/Program Files/nodejs/node.exe",
    args: ["E:/projects/weacpx/dist/cli.js", "mcp-stdio", "--coordinator-session", "backend:main", "--internal-session-tools"],
  });
});

test("uses WEACPX_DAEMON_ARG0 as the default weacpx CLI command", async () => {
  const spawns: Array<{ env: Record<string, string> }> = [];
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    baseEnv: { WEACPX_DAEMON_ARG0: "E:/Program Files/weacpx/dist/cli.js" },
    spawnOwner: async (_command, _args, options) => {
      spawns.push({ env: options.env });
    },
    terminateOwner: async () => {},
  });

  await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });

  const payload = JSON.parse(spawns[0].env.ACPX_QUEUE_OWNER_PAYLOAD);
  expect(payload.mcpServers[0].command).toBe(process.execPath);
  expect(payload.mcpServers[0].args.slice(0, 2)).toEqual([
    "E:/Program Files/weacpx/dist/cli.js",
    "mcp-stdio",
  ]);
});

test("uses one launch token for registration, argv, spawned ack, and owner settlement", async () => {
  const events: string[] = [];
  let spawnArgs: string[] = [];
  const context = adapterContext({
    prepare: async (token) => { events.push(`prepare:${token}`); return { agentCommand: MANAGED_COMMAND, generationId: "g" }; },
    isGenerationCurrent: async (generation) => { events.push(`fence:${generation}`); return true; },
    spawned: async (token) => { events.push(`spawned:${token}`); },
    settle: async (item) => { events.push(`settle:${item.intentToken}:${item.outcome}:${item.ownerPid}`); },
  });
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    uuid: () => TOKEN,
    spawnOwner: async (_command, args) => { events.push("spawn"); spawnArgs = args; return 700; },
    terminateOwner: async () => {},
    readOwnerPid: async () => 701,
  });
  await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentCommand: MANAGED_COMMAND,
    adapterContext: context,
  });
  expect(spawnArgs.slice(-2)).toEqual(["--xacpx-owner-token", TOKEN]);
  expect(events).toEqual([
    `prepare:${TOKEN}`,
    "fence:g",
    "spawn",
    `spawned:${TOKEN}`,
    `settle:${TOKEN}:owner-committed:701`,
  ]);
});

test("returns the durable adapter command selected during prepare for this launch", async () => {
  const preparedCommand = '"C:/node.exe" "C:/runtime/adapters/codex/releases/2/node_modules/@agentclientprotocol/codex-acp/bin.js"';
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    uuid: () => TOKEN,
    spawnOwner: async () => 700,
    terminateOwner: async () => {},
    readOwnerPid: async () => 701,
  });
  const result = await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentCommand: MANAGED_COMMAND,
    adapterContext: adapterContext({
      prepare: async () => ({ agentCommand: preparedCommand, generationId: "g" }),
    }),
  });
  expect(result.agentCommand).toBe(preparedCommand);
});

test("generation fencing cancels the registered intent and never spawns", async () => {
  const events: string[] = [];
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    uuid: () => TOKEN,
    spawnOwner: async () => { events.push("spawn"); return 700; },
    terminateOwner: async () => {},
  });
  await expect(launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentCommand: MANAGED_COMMAND,
    adapterContext: adapterContext({
      isGenerationCurrent: async () => false,
      cancel: async (token) => { events.push(`cancel:${token}`); },
    }),
  })).rejects.toThrow("generation changed");
  expect(events).toEqual([`cancel:${TOKEN}`]);
});

test("managed shape without context fails closed, and registration failure sends best-effort cancel", async () => {
  let spawns = 0;
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    uuid: () => TOKEN,
    spawnOwner: async () => { spawns += 1; return 700; },
    terminateOwner: async () => {},
  });
  const input = {
    acpxRecordId: "record-1",
    coordinatorSession: "main",
    permissionMode: "approve-all" as const,
    nonInteractivePermissions: "deny" as const,
    agentCommand: MANAGED_COMMAND,
  };
  await expect(launcher.launch(input)).rejects.toThrow("missing adapterContext");

  const canceled: string[] = [];
  await expect(launcher.launch({
    ...input,
    adapterContext: adapterContext({
      prepare: async () => { throw new Error("ack lost"); },
      cancel: async (token) => { canceled.push(token); },
    }),
  })).rejects.toThrow("ack lost");
  expect(canceled).toEqual([TOKEN]);
  expect(spawns).toBe(0);
});

test("readiness timeout preserves an alive or unknown launch but settles a confirmed exit", async () => {
  for (const status of ["alive", "unknown", "exited"] as const) {
    const settlements: string[] = [];
    const launcher = new AcpxQueueOwnerLauncher({
      acpxCommand: "acpx",
      uuid: () => TOKEN,
      spawnOwner: async () => 700,
      terminateOwner: async () => {},
      readOwnerPid: async () => undefined,
      handshakeTimeoutMs: 0,
      probeSpawnedProcess: async () => status,
    });
    await expect(launcher.launch({
      acpxRecordId: "record-1",
      coordinatorSession: "main",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      agentCommand: MANAGED_COMMAND,
      adapterContext: adapterContext({
        settle: async (item) => { settlements.push(item.outcome); },
      }),
    })).rejects.toThrow();
    expect(settlements).toEqual(status === "exited" ? ["launch-failed"] : []);
  }
});

test("Unix managed launch resolves before spawn without token state or token argv", async () => {
  const events: string[] = [];
  let args: string[] = [];
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    uuid: () => TOKEN,
    spawnOwner: async (_command, value) => { events.push("spawn"); args = value; return 700; },
    terminateOwner: async () => {},
  });
  await launcher.launch({
    acpxRecordId: "record-1",
    coordinatorSession: "main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    agentCommand: MANAGED_COMMAND,
    adapterContext: adapterContext({
      platform: "linux",
      prepare: async () => { events.push("resolve"); return { agentCommand: MANAGED_COMMAND }; },
      spawned: async () => { events.push("spawned"); },
      settle: async () => { events.push("settle"); },
    }),
  });
  expect(events).toEqual(["resolve", "spawn"]);
  expect(args).not.toContain("--xacpx-owner-token");
});
