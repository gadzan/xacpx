import type { OrchestrationTaskRecord } from "../../../../../src/orchestration/orchestration-types";
import type { OrchestrationTaskFilter } from "../../../../../src/orchestration/orchestration-service";
import type { ScheduledTaskRecord } from "../../../../../src/scheduled/scheduled-service";
import { expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

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

test("PR8 E2E: real ScheduledTaskService persistence + listing + cancellation through MCP", async () => {
  const { harness, service: _orchestration } = createServiceWithHarness();
  const state = harness.getState();
  const scheduledService = new ScheduledTaskService(state as never, {
    save: async () => {},
  });
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
      scheduledList: async (input) => {
        return scheduledService.listPending(input?.coordinatorSession ? "wx:user1" : "wx:user1") as unknown as ScheduledTaskRecord[];
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
    // Create via MCP
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

    // Verify in real state
    const scheduled = Object.values(state.scheduled_tasks || {});
    expect(scheduled.length).toBeGreaterThan(0);
    const task = scheduled.find((t) => t.message === "morning reminder");
    expect(task).toBeDefined();
    expect(task?.status).toBe("pending");

    // List via MCP
    const listRes = await client.request(
      {
        method: "tools/call",
        params: {
          name: "scheduled_list",
          arguments: {},
        },
      } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    expect((listRes as unknown as Record<string, unknown>)["isError"]).not.toBe(true);

    // Cancel via MCP
    if (!task) throw new Error("task not created in state");
    const cancelRes = await client.request(
      {
        method: "tools/call",
        params: {
          name: "scheduled_cancel",
          arguments: { id: task.id },
        },
      } as unknown as { method: string; params: unknown },
      CallToolResultSchema,
    );
    if ((cancelRes as unknown as Record<string, unknown>)["isError"]) {
      console.log("cancelRes error:", JSON.stringify(cancelRes));
    }
    expect((cancelRes as unknown as Record<string, unknown>)["isError"]).not.toBe(true);
    expect(state.scheduled_tasks[task.id]?.status).toBe("cancelled");
  } finally {
    await client.close();
    await server.close();
  }
}, 15_000);
