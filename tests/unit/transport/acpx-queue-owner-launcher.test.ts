import { expect, mock, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildXacpxMcpServerSpec,
  buildQueueOwnerPayload,
  AcpxQueueOwnerLauncher,
  type QueueOwnerSpawner,
  type QueueOwnerTerminator,
  type QueueOwnerAdapterContext,
  terminateAcpxQueueOwnerWithDeps,
  terminateAcpxQueueOwnerVerified,
  terminateAcpxQueueOwnerVerifiedWithDeps,
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

test("Windows cleanup ignores legacy sidecars and preserves lock evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-queue-owner-"));
  const lockPath = join(root, "owner.lock");
  const identityPath = `${lockPath}.identity`;
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 41 }), "utf8");
    await writeFile(identityPath, JSON.stringify({ pid: 41, creationDate: "1", executablePath: "C:\\node.exe" }), "utf8");
    let terminated = false;
    await terminateAcpxQueueOwnerWithDeps("record", {
      platform: "win32",
      lockPath,
      terminate: async () => { terminated = true; },
    });
    expect(terminated).toBe(false);
    expect(await readFile(lockPath, "utf8")).toContain('"pid":41');
    expect(await readFile(identityPath, "utf8")).toContain('"pid":41');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("reuses a live warm owner only when launch parameters are unchanged", async () => {
  const spawns: Array<{ command: string; args: string[] }> = [];
  const spawnOwner: QueueOwnerSpawner = mock(async (command, args) => {
    spawns.push({ command, args });
  });
  const terminated: string[] = [];
  const terminateOwner: QueueOwnerTerminator = mock(async (sessionId) => {
    terminated.push(sessionId);
    alive = false;
  });
  let alive = false;
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    xacpxCommand: "node ./dist/cli.js",
    spawnOwner: async (command, args, options) => {
      alive = true;
      await spawnOwner(command, args, options);
    },
    terminateOwner,
    isOwnerAlive: async () => alive,
  });

  const input = {
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all" as const,
    nonInteractivePermissions: "deny" as const,
  };

  // First launch spawns (and best-effort terminates any stale owner) and
  // records the parameter fingerprint.
  await launcher.launch(input);
  expect(spawns).toHaveLength(1);
  expect(terminated).toHaveLength(1);

  // Same parameters + live owner → reuse: no NEW terminate, no spawn.
  await launcher.launch(input);
  expect(spawns).toHaveLength(1);
  expect(terminated).toHaveLength(1);

  // Changed parameters → the old owner must be replaced, not reused.
  await launcher.launch({ ...input, coordinatorSession: "backend:other" });
  expect(terminated).toHaveLength(2);
  expect(spawns).toHaveLength(2);
});

test("a changed effective environment replaces the warm owner without exposing secrets in the fingerprint", async () => {
  const spawns: Array<Record<string, string>> = [];
  let alive = false;
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    spawnOwner: async (_command, _args, options) => {
      alive = true;
      spawns.push(options.env);
      return 100 + spawns.length;
    },
    terminateOwner: async () => { alive = false; },
    isOwnerAlive: async () => alive,
  });
  const input = {
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all" as const,
    nonInteractivePermissions: "deny" as const,
  };

  await launcher.launch({ ...input, env: { ANTHROPIC_AUTH_TOKEN: "secret-a", CLAUDE_CONFIG_DIR: "/isolated-a" } });
  await launcher.launch({ ...input, env: { ANTHROPIC_AUTH_TOKEN: "secret-b", CLAUDE_CONFIG_DIR: "/isolated-b" } });

  expect(spawns).toHaveLength(2);
  const fingerprints = [...(launcher as unknown as { lastLaunchFingerprint: Map<string, string> }).lastLaunchFingerprint.values()];
  expect(fingerprints.join(" ")).not.toContain("secret-b");
  expect(fingerprints.join(" ")).not.toContain("/isolated-b");
});

test("a live owner with no recorded fingerprint fails closed when termination cannot be verified", async () => {
  const spawns: Array<{ command: string; args: string[] }> = [];
  const spawnOwner: QueueOwnerSpawner = mock(async (command, args) => {
    spawns.push({ command, args });
  });
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    xacpxCommand: "node ./dist/cli.js",
    spawnOwner,
    terminateOwner: async () => {},
    isOwnerAlive: async () => true, // owner exists but WE never spawned it
  });

  await expect(launcher.launch({
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  })).rejects.toThrow(/owner|terminat|live/i);

  expect(spawns).toHaveLength(0);
});

test("a failed Windows handshake never publishes a reusable launch fingerprint", async () => {
  let spawnCount = 0;
  let terminateCount = 0;
  let alive = false;
  const settlements: string[] = [];
  const launcher = new AcpxQueueOwnerLauncher({
    acpxCommand: "acpx",
    spawnOwner: async () => {
      spawnCount += 1;
      alive = true;
      return 200 + spawnCount;
    },
    terminateOwner: async () => {
      terminateCount += 1;
      alive = false;
    },
    isOwnerAlive: async () => alive,
    readOwnerPid: async () => spawnCount >= 2 ? 902 : undefined,
    probeSpawnedProcess: async () => "alive",
    handshakeTimeoutMs: 0,
    sleep: async () => {},
  });
  const adapter = adapterContext({
    settle: async ({ outcome }) => { settlements.push(outcome); },
  });
  const input = {
    acpxRecordId: "acpx-record-1",
    coordinatorSession: "backend:main",
    permissionMode: "approve-all" as const,
    nonInteractivePermissions: "deny" as const,
    agentCommand: MANAGED_COMMAND,
    adapterContext: adapter,
  };

  await expect(launcher.launch(input)).rejects.toThrow(/did not become ready/);
  alive = true; // The failed owner publishes its lock after the timed-out launch.
  await expect(launcher.launch(input)).resolves.toEqual({ agentCommand: MANAGED_COMMAND });

  expect(spawnCount).toBe(2);
  expect(terminateCount).toBe(2);
  expect(settlements).toEqual(["owner-committed"]);
});

test("verified termination is a no-op when no owner lock exists", async () => {
  await expect(terminateAcpxQueueOwnerVerified("no-such-session")).resolves.toBeUndefined();
});

test("verified termination waits for the lock to disappear after terminating", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-owner-verify-"));
  const lockPath = join(dir, "owner.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 99999999 }));
  await expect(terminateAcpxQueueOwnerVerifiedWithDeps("session-1", {
    lockPath,
    terminate: async () => {
      await rm(lockPath, { force: true });
    },
    delay: async () => {},
  })).resolves.toBeUndefined();
  await expect(access(lockPath)).rejects.toThrow();
  await rm(dir, { recursive: true, force: true });
});

test("verified termination fails closed when the owner cannot be terminated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-owner-verify-"));
  const lockPath = join(dir, "owner.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 99999999 }));
  // Simulate a terminator that never removes the lock (e.g. Windows no-op).
  await expect(terminateAcpxQueueOwnerVerifiedWithDeps("session-1", {
    lockPath,
    terminate: async () => {},
    delay: async () => {},
  })).rejects.toThrow(/could not be terminated safely/);
  await rm(dir, { recursive: true, force: true });
});

test("verified termination fails closed when the lock is unverifiable (non-ENOENT)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-owner-verify-"));
  const lockPath = join(dir, "owner.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 99999999 }));
  // access() raises EACCES: we cannot prove the lock is gone, so migration
  // must NOT proceed even though the terminator would remove the lock.
  await expect(terminateAcpxQueueOwnerVerifiedWithDeps("session-1", {
    lockPath,
    terminate: async () => { await rm(lockPath, { force: true }); },
    delay: async () => {},
    accessFn: async () => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    },
  })).rejects.toThrow(/cannot verify queue owner lock state/);
  await rm(dir, { recursive: true, force: true });
});
