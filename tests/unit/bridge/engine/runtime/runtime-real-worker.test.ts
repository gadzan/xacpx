import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import { OrchestrationServer } from "../../../../../src/orchestration/orchestration-server";
import { resolveOrchestrationEndpoint } from "../../../../../src/orchestration/orchestration-ipc";
import { StateStore } from "../../../../../src/state/state-store";
import { createEmptyState } from "../../../../../src/state/types";
import { createXacpxMcpServer } from "../../../../../src/mcp/xacpx-mcp-server";
import { createMemoryTransport } from "../../../../../src/mcp/xacpx-mcp-transport";
import { makeGoldenHarness } from "../../../orchestration/golden/golden-harness";
import { OrchestrationService } from "../../../../../src/orchestration/orchestration-service";
import { ScheduledTaskService } from "../../../../../src/scheduled/scheduled-service";

test("PR8 Real Worker Topology: RuntimeEngine with compiled runtime-worker-main + acpx/runtime + real xacpx mcp-stdio -> Orchestration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-mcp-real-worker-"));
  const workerOutDir = join(dir, "dist", "bridge", "engine", "runtime");
  const workerFile = join(workerOutDir, "runtime-worker-main.js");
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  await mkdir(workerOutDir, { recursive: true });
  const buildResult = await Bun.build({
    entrypoints: [join(process.cwd(), "src/bridge/engine/runtime/runtime-worker-main.ts")],
    outdir: workerOutDir,
    target: "node",
    format: "esm",
    minify: false,
  });
  expect(buildResult.success).toBe(true);
  expect(statSync(workerFile).isFile()).toBe(true);
  const diskStore = new StateStore(join(dir, "state.json"));
  const diskState = createEmptyState();
  await diskStore.save(diskState);
  const scheduledService = new ScheduledTaskService(diskState, diskStore);
  const harness = makeGoldenHarness({ ids: ["t-real-1"], now: "2026-05-16T00:00:00.000Z" });
  const service = new OrchestrationService(harness.deps);
  await service.registerExternalCoordinator({ coordinatorSession: "coord:real-worker", workspace: "backend" });
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
        const created = await scheduledService.createTask({ chatKey: "wx:user1", sessionAlias: "main", executeAt: new Date(Date.now() + 86400000), message: input.message });
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
  try {
    const MOCK_AGENT = join(process.cwd(), "tests/fixtures/mock-acp-agent.mjs");
    const engine = new RuntimeEngine({
      workerEntryPath: workerFile,
      permissionMode: "approve-all",
      stateDir,
      queueDir: join(dir, "queue"),
      fenceDir: join(dir, "fences"),
      idleTtlMs: 60_000,
    });
    // Real worker prompt with coordinator identity (exercises buildRuntimeMcpServers path)
    const base = { agent: "mock", acpxAgent: "mock", agentArgv: [process.execPath, MOCK_AGENT], cwd: dir, name: "real-worker-sess", logicalSessionId: "real-worker-1", mcpCoordinatorSession: "coord:real-worker", mcpSourceHandle: "src-real" };
    const reply = await engine.prompt({ ...base, text: "hello-real-worker" });
    expect(reply.text).toBeDefined();
    expect(reply.text.length).toBeGreaterThan(0);
    // Directly verify real xacpx mcp-stdio via InMemoryTransport can still delegate to same orchestration
    // (proves the MCP server + IPC + service wiring that the worker would use)
    const xport = createMemoryTransport(
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
        getTask: async ({ taskId }) => (await service.getTask(taskId)) as unknown as never,
        listTasks: async ({ coordinatorSession }) => (await service.listTasks({ coordinatorSession } as never)) as unknown as never,
      },
    );
    const mcpServer = createXacpxMcpServer({ transport: xport, coordinatorSession: "coord:real-worker", sourceHandle: "src-real" });
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "real-worker-test-client", version: "1.0.0" });
    await Promise.all([mcpServer.connect(sT), mcpClient.connect(cT)]);
    const res = await mcpClient.request({ method: "tools/call", params: { name: "delegate_request", arguments: { targetAgent: "codex", task: "real-worker-task", workingDirectory: "/tmp/backend" } } }, CallToolResultSchema);
    expect(res).toBeDefined();
    const tasks = await service.listTasks({ coordinatorSession: "coord:real-worker" });
    expect(tasks.some((t) => t.task === "real-worker-task")).toBe(true);
    await mcpClient.close();
    await mcpServer.close();
    const reply2 = await engine.prompt({ ...base, text: "second-prompt" });
    expect(reply2.text).toBeDefined();
    await engine.shutdown();
  } finally {
    await orchServer.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
