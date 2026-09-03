import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import { OrchestrationServer } from "../../../../../src/orchestration/orchestration-server";
import { resolveOrchestrationEndpoint } from "../../../../../src/orchestration/orchestration-ipc";
import { StateStore } from "../../../../../src/state/state-store";
import { createEmptyState } from "../../../../../src/state/types";
import { createConfig } from "../../../commands/command-router-test-support";
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
  const initialState = createEmptyState();
  initialState.orchestration.workerBindings["src-real"] = {
    sourceHandle: "src-real",
    coordinatorSession: "coord:real-worker",
    workspace: "backend",
    targetAgent: "mock",
  };
  const baseConfig = createConfig();
  const config = {
    ...baseConfig,
    orchestration: {
      ...baseConfig.orchestration,
      allowWorkerChainedRequests: true,
    },
  };
  const harness = makeGoldenHarness({ config, initialState, ids: ["t-real-1", "t-real-2"], now: "2026-05-16T00:00:00.000Z" });
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
  const originalOrchSocket = process.env.XACPX_ORCHESTRATION_SOCKET;
  const originalCliCommand = process.env.XACPX_CLI_COMMAND;
  process.env.XACPX_ORCHESTRATION_SOCKET = endpoint.path;
  process.env.XACPX_CLI_COMMAND = `${process.execPath} ${join(process.cwd(), "src/cli.ts")}`;

  try {
    const MOCK_DELEGATE_AGENT = join(process.cwd(), "tests/fixtures/mock-acp-delegate-agent.mjs");
    const engine = new RuntimeEngine({
      workerEntryPath: workerFile,
      permissionMode: "approve-all",
      stateDir,
      queueDir: join(dir, "queue"),
      fenceDir: join(dir, "fences"),
      idleTtlMs: 60_000,
    });
    // Real worker prompt with coordinator identity (exercises buildRuntimeMcpServers path)
    const base = {
      agent: "mock",
      acpxAgent: "mock",
      agentArgv: [process.execPath, MOCK_DELEGATE_AGENT],
      cwd: dir,
      name: "real-worker-sess",
      logicalSessionId: "real-worker-1",
      mcpCoordinatorSession: "coord:real-worker",
      mcpSourceHandle: "src-real",
    };

    // Prompt triggers mock-acp-delegate-agent to connect to supplied mcpServers (xacpx mcp-stdio)
    // and invoke delegate_request tool against OrchestrationServer
    const reply = await engine.prompt({ ...base, text: "delegate:real-worker-task" });
    expect(reply.text).toBeDefined();
    expect(reply.text).toContain("delegated:real-worker-task");
    // Assert OrchestrationService task lands via the agent-driven MCP call
    const tasks = await service.listTasks({ coordinatorSession: "coord:real-worker" });
    expect(tasks.some((t) => t.task === "real-worker-task")).toBe(true);

    // Assert cool/restart still works
    const reply2 = await engine.prompt({ ...base, text: "second-prompt" });
    expect(reply2.text).toBeDefined();
    expect(reply2.text).toContain("reply=second-prompt");

    await engine.shutdown();
  } finally {
    if (originalOrchSocket !== undefined) {
      process.env.XACPX_ORCHESTRATION_SOCKET = originalOrchSocket;
    } else {
      delete process.env.XACPX_ORCHESTRATION_SOCKET;
    }
    if (originalCliCommand !== undefined) {
      process.env.XACPX_CLI_COMMAND = originalCliCommand;
    } else {
      delete process.env.XACPX_CLI_COMMAND;
    }
    await orchServer.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
