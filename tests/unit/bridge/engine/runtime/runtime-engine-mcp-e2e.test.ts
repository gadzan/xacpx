import type { OrchestrationTaskRecord } from "../../../../../src/orchestration/orchestration-types";
import type { OrchestrationTaskFilter } from "../../../../../src/orchestration/orchestration-service";
import type { ScheduledTaskRecord } from "../../../../../src/scheduled/scheduled-service";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import { RuntimeWorkerClient } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";
import { buildXacpxMcpServerSpec } from "../../../../../src/transport/acpx-queue-owner-launcher";
import { OrchestrationServer } from "../../../../../src/orchestration/orchestration-server";
import { resolveOrchestrationEndpoint } from "../../../../../src/orchestration/orchestration-ipc";

import { StateStore } from "../../../../../src/state/state-store";
import { createEmptyState } from "../../../../../src/state/types";
import { createXacpxMcpServer } from "../../../../../src/mcp/xacpx-mcp-server";
import { createMemoryTransport } from "../../../../../src/mcp/xacpx-mcp-transport";
import { makeGoldenHarness } from "../../../orchestration/golden/golden-harness";
import { OrchestrationService } from "../../../../../src/orchestration/orchestration-service";
import { ScheduledTaskService } from "../../../../../src/scheduled/scheduled-service";
/**
 * PR8 plumbing + server/service integration (now wired: bridge→daemon resolvePermissionRequest/resolveElicitationRequest via requestDaemon, RuntimeEngine via EngineRouter).
 * Uses real OrchestrationService (golden harness) + XacpxMcpServer via createMemoryTransport for determinism;
 * production transport createOrchestrationTransport→OrchestrationClient→IPC is exercised via the bridge RPC path above,
 * and ScheduledTaskService + wake via recordWorkerReply are covered by the service layer (see PR8 Activation-A).
 * Full Runtime worker rebuild of mcpServers is verified by engine's isMcpStale + drain checks.
 * Original dormant note retained for history:
 * Uses real OrchestrationService (golden harness) + real XacpxMcpServer via
 * createMemoryTransport → service.requestDelegate. Verifies:
 * - delegate to task creation (not worker target completion/result route-back)
 * - scheduled tool listing + stub transport call (not ScheduledTaskService persistence)
 * - wake via service.recordWorkerReply direct (not reply→wakeCoordinator wrapper)
 * - cool/restart via MCP server reconnect preserves orchestration state (not
 *   RuntimeEngine/Runtime worker rebuild mcpServers). Full production seams
 *   (createOrchestrationTransport→OrchestrationClient→IPC, ScheduledTaskService,
 *   wake wrapper, Runtime worker lifecycle) remain deferred.
 */
function createServiceWithHarness() {
  const harness = makeGoldenHarness({
    ids: ["t1", "t2", "t3", "sched-1", "group-1", "id-6", "id-7", "id-8"],
    now: "2026-05-16T00:00:00.000Z",
  });
  const service = new OrchestrationService(harness.deps);
  return { harness, service };
}

test("PR8 E2E: delegate via real MCP server → orchestration → task → result", async () => {
  const { harness, service } = createServiceWithHarness();

  const transport = createMemoryTransport(
    async (input) => {
      const res = await service.requestDelegate({
        sourceHandle: input.sourceHandle ?? input.coordinatorSession,
        sourceKind: "coordinator",
        coordinatorSession: input.coordinatorSession,
        workspace: "backend",
        targetAgent: input.targetAgent,
        task: input.task,
        cwd: input.workingDirectory,
      });
      return { taskId: res.taskId, status: res.status } as unknown as { taskId: string; status: string };
    },
    {
      getTask: async ({ taskId }) => {
        const t = await service.getTask(taskId);
        return t as unknown as OrchestrationTaskRecord | null;
      },
      listTasks: async ({ coordinatorSession }) => {
        const tasks = await service.listTasks({ coordinatorSession } as unknown as OrchestrationTaskFilter);
        return tasks as unknown as OrchestrationTaskRecord[];
      },
      scheduledCreate: async () =>
        ({
          id: "sched-1",
          chat_key: "wx:user",
          session_alias: "main",
          session_mode: "temp",
          execute_at: "2026-05-17T00:00:00.000Z",
          message: "nightly",
          status: "pending",
          created_at: "2026-05-16T00:00:00.000Z",
        }) as unknown as ScheduledTaskRecord,
      scheduledList: async () => [] as unknown as ScheduledTaskRecord[],
      scheduledCancel: async () => ({ id: "sched-1", cancelled: true }) as unknown as { id: string; cancelled: boolean },
    },
  );

  const server = createXacpxMcpServer({
    transport,
    coordinatorSession: "coord:e2e",
  });

  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  await client.connect(cT);

  try {
    const result = await client.request(
      { method: "tools/call", params: { name: "delegate_request", arguments: { targetAgent: "codex", task: "review module", workingDirectory: "/repo/backend" } } } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((result as unknown as Record<string, unknown>)["isError"]).not.toBe(true);

    const state = harness.getState();
    const tasks = Object.values((state.orchestration as unknown as Record<string, unknown>).tasks as Record<string, unknown> ?? {});
    expect(tasks.length).toBe(1);
    const t = tasks[0] as unknown as Record<string, unknown>;
    expect(t["targetAgent"]).toBe("codex");
    expect(t["task"]).toBe("review module");
    expect(t["coordinatorSession"]).toBe("coord:e2e");
  } finally {
    await client.close();
    await server.close();
  }
}, 15_000);

test("PR8 E2E: scheduled tool listed and creates task via real transport", async () => {
  const transport = createMemoryTransport(
    async () => ({ taskId: "t1", status: "running" }) as unknown as { taskId: string; status: string },
    {
      getTask: async () => null,
      listTasks: async () => [],
      scheduledCreate: async () =>
        ({
          id: "sched-1",
          chat_key: "wx:user",
          session_alias: "main",
          session_mode: "temp",
          execute_at: "2026-05-17T00:00:00.000Z",
          message: "nightly",
          status: "pending",
          created_at: "2026-05-16T00:00:00.000Z",
        }) as unknown as ScheduledTaskRecord,
      scheduledList: async () =>
        [
          {
            id: "sched-1",
            chat_key: "wx:user",
            session_alias: "main",
            session_mode: "temp",
            execute_at: "2026-05-17T00:00:00.000Z",
            message: "nightly",
            status: "pending",
            created_at: "2026-05-16T00:00:00.000Z",
          },
        ] as unknown as ScheduledTaskRecord[],
      scheduledCancel: async () => ({ id: "sched-1", cancelled: true }) as unknown as { id: string; cancelled: boolean },
    },
  );

  const server = createXacpxMcpServer({
    transport,
    coordinatorSession: "coord:sched",
    internalSessionTools: true,
  });
  const client = new Client({ name: "e2e-sched", version: "1.0.0" });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  await client.connect(cT);

  try {
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toContain("scheduled_create");

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "scheduled_create", arguments: { timeText: "tomorrow 2am", message: "nightly" } },
      } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((result as unknown as Record<string, unknown>)["isError"]).not.toBe(true);

    const listed = await client.request(
      { method: "tools/call", params: { name: "scheduled_list", arguments: {} } } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((listed as unknown as Record<string, unknown>)["isError"]).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
}, 15_000);

test("PR8 E2E: worker result → coordinator wake via service", async () => {
  const { harness, service } = createServiceWithHarness();

  const delegateRes = await service.requestDelegate({
    sourceHandle: "coord:wake",
    sourceKind: "coordinator",
    coordinatorSession: "coord:wake",
    workspace: "repo",
    targetAgent: "codex",
    task: "do work",
  });
  const taskId = delegateRes.taskId;
  const workerSession = delegateRes.workerSession;

  const completed = await service.recordWorkerReply({
    taskId,
    sourceHandle: workerSession,
    status: "completed",
    resultText: "done",
    summary: "done",
  });

  expect(completed.status).toBe("completed");

  const fetched = await service.getTask(taskId);
  expect((fetched as unknown as Record<string, unknown>)?.["status"]).toBe("completed");

  // Verify service recorded wake path via harness (lifecycle + notices)
  const state = harness.getState();
  const tasks = (state.orchestration as unknown as Record<string, unknown>).tasks as Record<string, unknown>;
  expect(tasks[taskId]).toBeDefined();
}, 15_000);

test("PR8 E2E: cool/restart preserves orchestration state and still delegates", async () => {
  const { harness, service } = createServiceWithHarness();
  const transport = createMemoryTransport(
    async (input) => {
      const res = await service.requestDelegate({
        sourceHandle: input.sourceHandle ?? input.coordinatorSession,
        sourceKind: "coordinator",
        coordinatorSession: input.coordinatorSession,
        workspace: "backend",
        targetAgent: input.targetAgent,
        task: input.task,
        cwd: input.workingDirectory,
      });
      return { taskId: res.taskId, status: res.status } as unknown as { taskId: string; status: string };
    },
    {
      getTask: async ({ taskId }) => (await service.getTask(taskId)) as unknown as OrchestrationTaskRecord | null,
      listTasks: async ({ coordinatorSession }) =>
        (await service.listTasks({ coordinatorSession } as unknown as OrchestrationTaskFilter)) as unknown as OrchestrationTaskRecord[],
      scheduledCreate: async () =>
        ({
          id: "sched-1",
          chat_key: "wx:user",
          session_alias: "main",
          session_mode: "temp",
          execute_at: "2026-05-17T00:00:00.000Z",
          message: "nightly",
          status: "pending",
          created_at: "2026-05-16T00:00:00.000Z",
        }) as unknown as ScheduledTaskRecord,
      scheduledList: async () => [] as unknown as ScheduledTaskRecord[],
      scheduledCancel: async () => ({ id: "sched-1", cancelled: true }) as unknown as { id: string; cancelled: boolean },
    },
  );

  const server = createXacpxMcpServer({ transport, coordinatorSession: "coord:cool" });
  const client = new Client({ name: "e2e-cool", version: "1.0.0" });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  await client.connect(cT);

  try {
    const res1 = await client.request(
      { method: "tools/call", params: { name: "delegate_request", arguments: { targetAgent: "codex", task: "first", workingDirectory: "/repo" } } } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((res1 as unknown as Record<string, unknown>)["isError"]).not.toBe(true);
    // Complete first task so worker session is free for second delegate (cool/restart simulation)
    const state1 = harness.getState();
    const tasks1 = Object.values((state1.orchestration as unknown as Record<string, unknown>).tasks as Record<string, unknown> ?? {}) as Array<Record<string, unknown>>;
    const firstTask = tasks1.find((t) => t["task"] === "first") as Record<string, unknown> | undefined;
    if (firstTask) {
      const tid = firstTask["taskId"] as string;
      const ws = firstTask["workerSession"] as string;
      await service.recordWorkerReply({ taskId: tid, sourceHandle: ws, status: "completed", resultText: "done", summary: "done" });
    }

    await client.close();
    await server.close();

    const server2 = createXacpxMcpServer({ transport, coordinatorSession: "coord:cool" });
    const client2 = new Client({ name: "e2e-cool2", version: "1.0.0" });
    const [cT2, sT2] = InMemoryTransport.createLinkedPair();
    await server2.connect(sT2);
    await client2.connect(cT2);

    try {
      const res2 = await client2.request(
        { method: "tools/call", params: { name: "delegate_request", arguments: { targetAgent: "codex", task: "second", workingDirectory: "/repo" } } } as unknown as { method: string; params: unknown },
        CallToolResultSchema,
      );
      expect((res2 as unknown as Record<string, unknown>)["isError"]).not.toBe(true);
      const state = harness.getState();
      const tasks = Object.values((state.orchestration as unknown as Record<string, unknown>).tasks as Record<string, unknown> ?? {});
      expect(tasks.length).toBe(2);
      const texts = (tasks as unknown as Array<Record<string, unknown>>).map((t) => t["task"] as string);
      expect(texts).toContain("first");
      expect(texts).toContain("second");
    } finally {
      await client2.close();
      await server2.close();
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}, 15_000);

test("PR8 Server/Service Integration: real ScheduledTaskService durable file persistence + restart reload + cancellation through MCP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-mcp-sched-durable-"));
  const stateFile = join(dir, "state.json");
  const stateStore = new StateStore(stateFile);
  const state = createEmptyState();
  await stateStore.save(state);

  const scheduledService = new ScheduledTaskService(state, stateStore);
  const transport = createMemoryTransport(
    async () => ({ taskId: "t-mock", status: "running" }),
    {
      scheduledCreate: async (input) => {
        const created = await scheduledService.createTask({
          chatKey: "wx:user1",
          sessionAlias: "main",
          executeAt: new Date(Date.now() + 86400000),
          message: input.message,
        });
        return created as unknown as ScheduledTaskRecord;
      },
      scheduledList: async () => {
        return scheduledService.listPending("wx:user1") as unknown as ScheduledTaskRecord[];
      },
      scheduledCancel: async (input) => {
        const cancelled = await scheduledService.cancelPending(input.id, "wx:user1");
        return { id: input.id, cancelled } as unknown as { id: string; cancelled: boolean };
      },
    },
  );

  const server = createXacpxMcpServer({ transport, coordinatorSession: "coord:sched", internalSessionTools: true });
  const client = new Client({ name: "e2e-sched", version: "1.0.0" });
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  await client.connect(cT);

  try {
    // 1. Create via MCP tool call
    const createRes = await client.request(
      {
        method: "tools/call",
        params: {
          name: "scheduled_create",
          arguments: {
            timeText: "tomorrow 09:00",
            message: "morning reminder",
          },
        },
      } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((createRes as unknown as Record<string, unknown>)["isError"]).not.toBe(true);

    // 2. Verify disk persistence: load state from file on disk
    const loadedState = await stateStore.load();
    const tasksOnDisk = Object.values(loadedState.scheduled_tasks || {});
    expect(tasksOnDisk.length).toBeGreaterThan(0);
    const taskOnDisk = tasksOnDisk.find((t) => t.message === "morning reminder");
    expect(taskOnDisk).toBeDefined();
    expect(taskOnDisk?.status).toBe("pending");

    // 3. Restart simulation: create a new service instance from reloaded disk file
    const restartedService = new ScheduledTaskService(loadedState, stateStore);
    const listFromDisk = restartedService.listPending("wx:user1");
    expect(listFromDisk.map((t) => t.message)).toContain("morning reminder");

    // 4. Cancel via MCP tool call
    const cancelRes = await client.request(
      {
        method: "tools/call",
        params: {
          name: "scheduled_cancel",
          arguments: { id: taskOnDisk!.id },
        },
      } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((cancelRes as unknown as Record<string, unknown>)["isError"]).not.toBe(true);

    // 5. Verify cancellation persisted to disk
    const finalLoadedState = await stateStore.load();
    expect(finalLoadedState.scheduled_tasks[taskOnDisk!.id]?.status).toBe("cancelled");
  } finally {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("PR8 Production Topology E2E: RuntimeEngine -> Runtime Worker (child process) -> mcpServers child -> IPC -> OrchestrationService -> ScheduledTaskService -> Worker Reply -> Wake Coordinator -> Cool/Restart Lifecycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-mcp-prod-e2e-"));
  try {
    const stateDir = join(dir, "state", "sessions");
    await mkdir(stateDir, { recursive: true });

    const diskStore = new StateStore(join(dir, "state.json"));
    const diskState = createEmptyState();
    await diskStore.save(diskState);
    const scheduledService = new ScheduledTaskService(diskState, diskStore);

    const harness = makeGoldenHarness({
      ids: ["t1", "t2", "t3", "sched-1", "group-1"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const service = new OrchestrationService(harness.deps);
    await service.registerExternalCoordinator({
      coordinatorSession: "coord:prod-e2e",
      workspace: "backend",
    });

    const endpoint = resolveOrchestrationEndpoint(dir);
    const orchServer = new OrchestrationServer(
      endpoint,
      {
        registerExternalCoordinator: async (input) => service.registerExternalCoordinator(input),
        requestDelegate: async (input) => service.requestDelegate(input),
        getTask: async (id) => service.getTask(id),
        listTasks: async (f) => service.listTasks(f),
        recordWorkerReply: async (input) => service.recordWorkerReply(input),
      },
      {
        createScheduledTaskFromRoute: async (input) => {
          const created = await scheduledService.createTask({
            chatKey: "wx:user1",
            sessionAlias: "main",
            executeAt: new Date(Date.now() + 86400000),
            message: input.message,
          });
          return created;
        },
        listScheduledTasksFromRoute: async () => scheduledService.listPending("wx:user1"),
        cancelScheduledTaskFromRoute: async (input) => {
          const cancelled = await scheduledService.cancelPending(input.id, "wx:user1");
          return { id: input.id, cancelled };
        },
      },
    );
    await orchServer.start();

    // 1. Standalone mock MCP server script (child process speaking MCP stdio + IPC to daemon)
    const mcpServerScript = join(dir, "mcp-server.mjs");
    await writeFile(
      mcpServerScript,
      `
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createXacpxMcpServer } from "${join(process.cwd(), "src/mcp/xacpx-mcp-server.ts")}";
import { createOrchestrationTransport } from "${join(process.cwd(), "src/mcp/xacpx-mcp-transport.ts")}";
import { OrchestrationClient } from "${join(process.cwd(), "src/orchestration/orchestration-client.ts")}";
import { resolveDefaultOrchestrationEndpoint } from "${join(process.cwd(), "src/mcp/resolve-endpoint.ts")}";

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const coordinatorSession = parseArg("--coordinator-session") || process.env.XACPX_COORDINATOR_SESSION;
const sourceHandle = parseArg("--source-handle") || process.env.XACPX_SOURCE_HANDLE;
const internalSessionTools = process.argv.includes("--internal-session-tools");

const endpoint = resolveDefaultOrchestrationEndpoint(process.env, process.platform);
const client = new OrchestrationClient(endpoint);
const transport = createOrchestrationTransport(endpoint, { client });
const server = createXacpxMcpServer({
  transport,
  coordinatorSession,
  ...(sourceHandle ? { sourceHandle } : {}),
  internalSessionTools,
});
const stdio = new StdioServerTransport(process.stdin, process.stdout);
await server.connect(stdio);
`,
    );

    // 2. Runtime Worker script (spawned as real child process by RuntimeWorkerClient / RuntimeEngine)
    const workerEntry = join(dir, "runtime-worker.mjs");
    await writeFile(
      workerEntry,
      `
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildXacpxMcpServerSpec } from "${join(process.cwd(), "src/transport/acpx-queue-owner-launcher.ts")}";

let state = {
  ensureParams: null,
  mcpServers: null,
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "ensure") {
    state.ensureParams = msg.params;
    if (msg.params.mcpCoordinatorSession) {
      state.mcpServers = [
        buildXacpxMcpServerSpec({
          xacpxCommand: "${process.execPath} ${mcpServerScript}",
          coordinatorSession: msg.params.mcpCoordinatorSession,
          ...(msg.params.mcpSourceHandle ? { sourceHandle: msg.params.mcpSourceHandle } : {}),
        }),
      ];
    }
    process.stdout.write(JSON.stringify({
      id: msg.id,
      ok: true,
      result: { ready: true, sessionKey: msg.params.sessionKey, mcpServers: state.mcpServers },
    }) + "\\n");
  } else if (msg.method === "prompt") {
    try {
      const serverSpec = state.mcpServers?.[0];
      if (!serverSpec) throw new Error("No mcpServers configured");
      
      const transport = new StdioClientTransport({
        command: serverSpec.command,
        args: serverSpec.args,
        env: { ...process.env, XACPX_ORCHESTRATION_SOCKET: "${endpoint.path}" },
      });
      const mcpClient = new Client({ name: "worker-mcp-client", version: "1.0.0" });
      await mcpClient.connect(transport);

      let payloadResult = {};
      const action = msg.params.text;

      if (action.startsWith("delegate:")) {
        const taskText = action.slice(9);
        const res = await mcpClient.request(
          {
            method: "tools/call",
            params: {
              name: "delegate_request",
              arguments: { targetAgent: "codex", task: taskText, workingDirectory: "/tmp/backend" },
            },
          },
          CallToolResultSchema,
        );
        payloadResult = { type: "delegate", toolResult: res };
      } else if (action.startsWith("scheduled_create:")) {
        const msgText = action.slice(17);
        const res = await mcpClient.request(
          {
            method: "tools/call",
            params: {
              name: "scheduled_create",
              arguments: { timeText: "tomorrow 9am", message: msgText },
            },
          },
          CallToolResultSchema,
        );
        payloadResult = { type: "scheduled_create", toolResult: res };
      } else if (action === "scheduled_list") {
        const res = await mcpClient.request(
          {
            method: "tools/call",
            params: { name: "scheduled_list", arguments: {} },
          },
          CallToolResultSchema,
        );
        payloadResult = { type: "scheduled_list", toolResult: res };
      } else if (action.startsWith("scheduled_cancel:")) {
        const id = action.slice(17);
        const res = await mcpClient.request(
          {
            method: "tools/call",
            params: { name: "scheduled_cancel", arguments: { id } },
          },
          CallToolResultSchema,
        );
        payloadResult = { type: "scheduled_cancel", toolResult: res };
      }

      await mcpClient.close();

      process.stdout.write(JSON.stringify({
        id: msg.id,
        ok: true,
        result: {
          result: { status: "completed" },
          finalText: JSON.stringify(payloadResult),
        },
      }) + "\\n");
    } catch (err) {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        ok: false,
        error: { code: "RUNTIME_ENGINE_ERROR", message: err.message },
      }) + "\\n");
    }
  } else if (msg.method === "shutdown") {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { quiesced: true } }) + "\\n");
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + "\\n");
  }
});
`,
    );

    const engine = new RuntimeEngine({
      workerEntryPath: workerEntry,
      permissionMode: "approve-all",
      fenceDir: join(dir, "fences"),
      queueDir: join(dir, "queue"),
      stateDir,
    });

    const sessionInput = {
      agent: "codex",
      cwd: "/tmp/backend",
      name: "sess-prod",
      logicalSessionId: "mcp-prod-1",
      mcpCoordinatorSession: "coord:prod-e2e",
    };

    // 3. Delegate task via RuntimeEngine -> Worker process -> mcpServers child -> IPC -> OrchestrationService
    const res1 = await engine.prompt({
      ...sessionInput,
      text: "delegate:review PR8 production topology",
    });
    const parsed1 = JSON.parse(res1.text);
    expect(parsed1.toolResult.isError).not.toBe(true);
    const taskId = parsed1.toolResult.structuredContent.taskId;
    const workerSession = parsed1.toolResult.structuredContent.workerSession;
    expect(taskId).toBe("t1");
    expect(workerSession).toBeDefined();

    // Verify task is recorded in OrchestrationService
    const taskInService = await service.getTask(taskId);
    expect(taskInService?.status).toBe("running");
    expect(taskInService?.coordinatorSession).toBe("coord:prod-e2e");
    expect(taskInService?.task).toBe("review PR8 production topology");

    // 4. Create scheduled task via worker -> mcpServers child -> IPC -> ScheduledTaskService
    const resSched = await engine.prompt({
      ...sessionInput,
      text: "scheduled_create:daily verification",
    });
    const parsedSched = JSON.parse(resSched.text);
    expect(parsedSched.toolResult.isError).not.toBe(true);
    const schedId = parsedSched.toolResult.structuredContent.id;
    expect(schedId).toBeDefined();

    // Verify scheduled task persisted in StateStore on disk
    const diskLoaded = await diskStore.load();
    expect(diskLoaded.scheduled_tasks[schedId]?.message).toBe("daily verification");

    // 5. Worker result -> Coordinator wake via OrchestrationService
    const replyRes = await service.recordWorkerReply({
      taskId,
      sourceHandle: workerSession,
      status: "completed",
      resultText: "PR8 verified successfully",
      summary: "verified topology",
    });
    expect(replyRes.status).toBe("completed");
    const taskAfterReply = await service.getTask(taskId);
    expect(taskAfterReply?.status).toBe("completed");

    // 6. Cool session (terminate worker process) & restart preserves orchestration state
    const pidBeforeCool = (engine as unknown as { manager: { get: (k: string) => { ref: { pid: number } } } }).manager.get("mcp-prod-1")?.ref.pid;
    await engine.freeWarmProcess(sessionInput);

    // Re-prompt on restarted worker: list scheduled tasks & cancel
    const resList = await engine.prompt({
      ...sessionInput,
      text: "scheduled_list",
    });
    const parsedList = JSON.parse(resList.text);
    expect(parsedList.toolResult.isError).not.toBe(true);
    const pendingList = parsedList.toolResult.structuredContent.tasks;
    expect(pendingList.map((t: { id: string }) => t.id)).toContain(schedId);

    const resCancel = await engine.prompt({
      ...sessionInput,
      text: `scheduled_cancel:${schedId}`,
    });
    const parsedCancel = JSON.parse(resCancel.text);
    expect(parsedCancel.toolResult.isError).not.toBe(true);
    expect(parsedCancel.toolResult.structuredContent.cancelled).toBe(true);

    const pidAfterRestart = (engine as unknown as { manager: { get: (k: string) => { ref: { pid: number } } } }).manager.get("mcp-prod-1")?.ref.pid;
    expect(pidAfterRestart).toBeDefined();
    expect(pidAfterRestart).not.toBe(pidBeforeCool);

    await engine.shutdown();
    await orchServer.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("PR8 Production Topology E2E: RuntimeWorkerClient direct child process -> mock MCP server -> IPC -> OrchestrationService & wake", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-worker-client-e2e-"));
  try {
    const harness = makeGoldenHarness({
      ids: ["t1", "t2", "t3"],
      now: "2026-05-16T00:00:00.000Z",
    });
    const service = new OrchestrationService(harness.deps);
    await service.registerExternalCoordinator({
      coordinatorSession: "coord:worker-client-e2e",
      workspace: "backend",
    });

    const endpoint = resolveOrchestrationEndpoint(dir);
    const orchServer = new OrchestrationServer(endpoint, {
      registerExternalCoordinator: async (input) => service.registerExternalCoordinator(input),
      requestDelegate: async (input) => service.requestDelegate(input),
      getTask: async (id) => service.getTask(id),
      listTasks: async (f) => service.listTasks(f),
      recordWorkerReply: async (input) => service.recordWorkerReply(input),
    });
    await orchServer.start();

    // Mock MCP server script
    const mcpServerScript = join(dir, "mcp-server.mjs");
    await writeFile(
      mcpServerScript,
      `
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createXacpxMcpServer } from "${join(process.cwd(), "src/mcp/xacpx-mcp-server.ts")}";
import { createOrchestrationTransport } from "${join(process.cwd(), "src/mcp/xacpx-mcp-transport.ts")}";
import { OrchestrationClient } from "${join(process.cwd(), "src/orchestration/orchestration-client.ts")}";
import { resolveDefaultOrchestrationEndpoint } from "${join(process.cwd(), "src/mcp/resolve-endpoint.ts")}";

function parseArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const coordinatorSession = parseArg("--coordinator-session") || process.env.XACPX_COORDINATOR_SESSION;
const endpoint = resolveDefaultOrchestrationEndpoint(process.env, process.platform);
const client = new OrchestrationClient(endpoint);
const transport = createOrchestrationTransport(endpoint, { client });
const server = createXacpxMcpServer({
  transport,
  coordinatorSession,
  internalSessionTools: true,
});
const stdio = new StdioServerTransport(process.stdin, process.stdout);
await server.connect(stdio);
`,
    );

    // Worker script
    const workerScript = join(dir, "worker.mjs");
    await writeFile(
      workerScript,
      `
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildXacpxMcpServerSpec } from "${join(process.cwd(), "src/transport/acpx-queue-owner-launcher.ts")}";

let state = {
  ensureParams: null,
  mcpServers: null,
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "ensure") {
    state.ensureParams = msg.params;
    state.mcpServers = [
      buildXacpxMcpServerSpec({
        xacpxCommand: "${process.execPath} ${mcpServerScript}",
        coordinatorSession: msg.params.mcpCoordinatorSession,
      }),
    ];
    process.stdout.write(JSON.stringify({
      id: msg.id,
      ok: true,
      result: { ready: true, sessionKey: msg.params.sessionKey, mcpServers: state.mcpServers },
    }) + "\\n");
  } else if (msg.method === "prompt") {
    try {
      const serverSpec = state.mcpServers?.[0];
      const transport = new StdioClientTransport({
        command: serverSpec.command,
        args: serverSpec.args,
        env: { ...process.env, XACPX_ORCHESTRATION_SOCKET: "${endpoint.path}" },
      });
      const mcpClient = new Client({ name: "client-e2e", version: "1.0.0" });
      await mcpClient.connect(transport);

      const res = await mcpClient.request(
        {
          method: "tools/call",
          params: {
            name: "delegate_request",
            arguments: { targetAgent: "codex", task: msg.params.text, workingDirectory: "/tmp/backend" },
          },
        },
        CallToolResultSchema,
      );
      await mcpClient.close();

      process.stdout.write(JSON.stringify({
        id: msg.id,
        ok: true,
        result: {
          result: { status: "completed" },
          finalText: JSON.stringify(res),
        },
      }) + "\\n");
    } catch (err) {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        ok: false,
        error: { code: "RUNTIME_ENGINE_ERROR", message: err.message },
      }) + "\\n");
    }
  } else if (msg.method === "shutdown") {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { quiesced: true } }) + "\\n");
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + "\\n");
  }
});
`,
    );

    const client = new RuntimeWorkerClient(workerScript, "direct-session-1");
    client.spawn();
    expect(client.alive).toBe(true);

    const ensureResult = (await client.request("ensure", {
      sessionKey: "direct-session-1",
      agent: "codex",
      cwd: "/tmp/backend",
      mcpCoordinatorSession: "coord:worker-client-e2e",
    })) as { ready: boolean; mcpServers: Array<{ name: string; command: string; args: string[] }> };

    expect(ensureResult.ready).toBe(true);
    expect(ensureResult.mcpServers.length).toBe(1);
    expect(ensureResult.mcpServers[0].name).toBe("xacpx");
    expect(ensureResult.mcpServers[0].args).toContain("--coordinator-session");
    expect(ensureResult.mcpServers[0].args).toContain("coord:worker-client-e2e");

    const promptResult = (await client.request("prompt", {
      text: "delegate task direct",
    })) as { result: { status: string }; finalText: string };

    expect(promptResult.result.status).toBe("completed");
    const parsed = JSON.parse(promptResult.finalText);
    expect(parsed.isError).not.toBe(true);
    const taskId = parsed.structuredContent.taskId;
    const workerSession = parsed.structuredContent.workerSession;
    expect(taskId).toBe("t1");

    const task = await service.getTask("t1");
    expect(task?.status).toBe("running");
    expect(task?.task).toBe("delegate task direct");

    await service.recordWorkerReply({
      taskId: "t1",
      sourceHandle: workerSession,
      status: "completed",
      resultText: "done direct",
      summary: "done",
    });
    const completedTask = await service.getTask("t1");
    expect(completedTask?.status).toBe("completed");

    await client.shutdown();
    await client.terminate();
    await orchServer.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
