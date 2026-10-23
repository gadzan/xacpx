import { expect, test, beforeAll, afterAll } from "bun:test";

import { checkOrchestrationHealth } from "../../../src/doctor/checks/orchestration-health";
import { createEmptyState } from "../../../src/state/types";
import { setLocale } from "../../../src/i18n";

beforeAll(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

test("reports pass when no orchestration activity", async () => {
  const result = await checkOrchestrationHealth({
    loadState: async () => createEmptyState(),
    now: () => new Date("2026-04-18T10:10:00.000Z"),
    heartbeatThresholdSeconds: 300,
  });
  expect(result.id).toBe("orchestration");
  expect(result.severity).toBe("pass");
  expect(result.summary).toBe("orchestration state healthy");
});

test("reports warn when there are stuck running tasks", async () => {
  const result = await checkOrchestrationHealth({
    loadState: async () => ({
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "t-stuck": {
            taskId: "t-stuck",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T09:00:00.000Z",
            updatedAt: "2026-04-18T09:00:00.000Z",
          },
        },
        workerBindings: {},
        groups: {},
      },
    }),
    now: () => new Date("2026-04-18T10:10:00.000Z"),
    heartbeatThresholdSeconds: 300,
  });
  expect(result.severity).toBe("warn");
  expect(result.summary).toContain("1");
  expect(result.details?.some((line) => line.includes("t-stuck"))).toBe(true);
  expect(result.suggestions ?? []).toContain("查看 /tasks --stuck 定位卡住的任务");
});

test("reports sessions and cwd-less bindings that reference a missing workspace", async () => {
  const state = createEmptyState();
  state.sessions["dangling"] = {
    alias: "dangling",
    agent: "claude",
    workspace: "gone",
    transport_session: "gone:dangling",
    source: "xacpx",
    created_at: "2026-04-18T09:00:00.000Z",
    last_used_at: "2026-04-18T09:00:00.000Z",
  };
  state.orchestration.workerBindings["dangling:claude"] = {
    sourceHandle: "dangling:claude",
    coordinatorSession: "backend:main",
    workspace: "gone",
    targetAgent: "claude",
  };
  // A pathless binding carries its own cwd; a removed workspace registration
  // must not be reported as a dangling reference.
  state.orchestration.workerBindings["pathless:claude"] = {
    sourceHandle: "pathless:claude",
    coordinatorSession: "backend:main",
    workspace: "gone",
    cwd: "/repo/pathless",
    targetAgent: "claude",
  };
  // Blank cwd is not a pathless target: it has no physical path of its own.
  state.orchestration.workerBindings["blank-cwd:claude"] = {
    sourceHandle: "blank-cwd:claude",
    coordinatorSession: "backend:main",
    workspace: "gone",
    cwd: "  ",
    targetAgent: "claude",
  };

  const result = await checkOrchestrationHealth({
    loadState: async () => state,
    now: () => new Date("2026-04-18T10:10:00.000Z"),
    heartbeatThresholdSeconds: 300,
    workspaces: { backend: { cwd: "/tmp/backend" } },
  });

  expect(result.severity).toBe("warn");
  expect(result.summary).toContain("3 missing-workspace refs");
  expect(result.details?.some((line) => line.includes("dangling -> gone"))).toBe(true);
  expect(result.details?.some((line) => line.includes("dangling:claude -> gone"))).toBe(true);
  expect(result.details?.some((line) => line.includes("worker binding references missing workspace: blank-cwd:claude"))).toBe(true);
  expect(result.details?.some((line) => line.includes("worker binding references missing workspace: pathless:claude"))).toBe(false);
  expect(result.suggestions ?? []).toContain(
    "有会话或 worker binding 引用了已缺失的 workspace：请在 config.json 恢复该 workspace，或移除受影响的会话/binding",
  );
});

test("reports warn when notices or injections are stuck or workerBindings are orphaned", async () => {
  const result = await checkOrchestrationHealth({
    loadState: async () => ({
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "t-notice": {
            taskId: "t-notice",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-18T09:00:00.000Z",
            updatedAt: "2026-04-18T09:00:00.000Z",
            noticePending: true,
            lastNoticeError: "send failed",
          },
          "t-injection": {
            taskId: "t-injection",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "failed",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T09:00:00.000Z",
            updatedAt: "2026-04-18T09:00:00.000Z",
            injectionPending: true,
            lastInjectionError: "inject failed",
          },
        },
        workerBindings: {
          "backend:claude:orphan": {
            sourceHandle: "backend:claude:orphan",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
        groups: {},
      },
    }),
    now: () => new Date("2026-04-18T10:10:00.000Z"),
    heartbeatThresholdSeconds: 300,
  });
  expect(result.severity).toBe("warn");
  expect(result.details?.some((line) => line.includes("notice"))).toBe(true);
  expect(result.details?.some((line) => line.includes("injection"))).toBe(true);
  expect(result.details?.some((line) => line.includes("orphan"))).toBe(true);
});
