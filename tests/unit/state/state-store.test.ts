import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StateStore } from "../../../src/state/state-store";
import { createEmptyState } from "../../../src/state/types";

test("loads native session metadata and native session list cache records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {
        "project:codex": {
          alias: "project:codex",
          agent: "codex",
          workspace: "project",
          transport_session: "backend:project:codex",
          source: "agent-side",
          agent_session_id: "thread-1",
          agent_session_title: "Fix CI",
          agent_session_updated_at: "2026-05-26T10:00:00.000Z",
          attached_at: "2026-05-26T10:01:00.000Z",
          created_at: "2026-05-26T09:59:00.000Z",
          last_used_at: "2026-05-26T10:02:00.000Z",
        },
      },
      chat_contexts: {},
      native_session_lists: {
        "wx:user": {
          created_at: "2026-05-26T10:00:00.000Z",
          agent: "codex",
          workspace: "project",
          cwd: "/Users/example/project",
          sessions: [
            {
              session_id: "thread-1",
              cwd: "/Users/example/project",
              title: "Fix CI",
              updated_at: "2026-05-26T10:00:00.000Z",
            },
          ],
          next_cursor: null,
        },
      },
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    sessions: {
      "project:codex": {
        source: "agent-side",
        agent_session_id: "thread-1",
        agent_session_title: "Fix CI",
      },
    },
    native_session_lists: {
      "wx:user": {
        agent: "codex",
        workspace: "project",
        sessions: [
          {
            session_id: "thread-1",
            title: "Fix CI",
          },
        ],
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("load migrates legacy worker and external coordinator endpoint ids durably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const state = createEmptyState();
  state.orchestration.workerBindings.worker = {
    sourceHandle: "worker",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "codex",
  };
  state.orchestration.externalCoordinators.external = {
    coordinatorSession: "external",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
  await Bun.write(path, JSON.stringify(state));

  try {
    const store = new StateStore(path);
    const loaded = await store.load();
    const workerEndpointId = loaded.orchestration.workerBindings.worker?.agentEndpointId;
    const externalEndpointId = loaded.orchestration.externalCoordinators.external?.agentEndpointId;

    expect(workerEndpointId).toMatch(/^endpoint_[0-9a-f-]{36}$/);
    expect(externalEndpointId).toMatch(/^endpoint_[0-9a-f-]{36}$/);
    expect(store.lastLoadReport?.migrated).toEqual([
      {
        section: "orchestration.workerBindings",
        key: "worker",
        reason: expect.stringContaining("agentEndpointId"),
      },
      {
        section: "orchestration.workerBindings",
        key: "worker",
        reason: expect.stringContaining("transportEngine"),
      },
      {
        section: "orchestration.workerBindings",
        key: "worker",
        reason: expect.stringContaining("logicalSessionId"),
      },
      {
        section: "orchestration.externalCoordinators",
        key: "external",
        reason: expect.stringContaining("agentEndpointId"),
      },
    ]);

    const onDisk = JSON.parse(await readFile(path, "utf8")) as {
      orchestration: {
        workerBindings: Record<string, { agentEndpointId?: string }>;
        externalCoordinators: Record<string, { agentEndpointId?: string }>;
      };
    };
    expect(onDisk.orchestration.workerBindings.worker?.agentEndpointId).toBe(workerEndpointId);
    expect(onDisk.orchestration.externalCoordinators.external?.agentEndpointId).toBe(externalEndpointId);

    const reloaded = await new StateStore(path).load();
    expect(reloaded.orchestration.workerBindings.worker?.agentEndpointId).toBe(workerEndpointId);
    expect(reloaded.orchestration.externalCoordinators.external?.agentEndpointId).toBe(externalEndpointId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("load migrates legacy worker bindings to cli engine and mints LID durably", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const state = createEmptyState();
  state.orchestration.workerBindings.worker = {
    sourceHandle: "worker",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "codex",
    agentEndpointId: "endpoint_legacy_worker",
  };
  await Bun.write(path, JSON.stringify(state));

  try {
    const store = new StateStore(path);
    const loaded = await store.load();
    const binding = loaded.orchestration.workerBindings.worker;
    // Fail-safe: legacy bindings never auto-upgrade to Runtime.
    expect(binding?.transportEngine).toBe("cli");
    expect(binding?.logicalSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const reasons = (store.lastLoadReport?.migrated ?? []).map((m) => m.reason);
    expect(reasons.some((r) => r.includes("transportEngine"))).toBe(true);
    expect(reasons.some((r) => r.includes("logicalSessionId"))).toBe(true);

    // Durable: restart sees the same identity, no re-migration.
    const onDisk = JSON.parse(await readFile(path, "utf8")) as {
      orchestration: { workerBindings: Record<string, { transportEngine?: string; logicalSessionId?: string }> };
    };
    expect(onDisk.orchestration.workerBindings.worker?.transportEngine).toBe("cli");
    expect(onDisk.orchestration.workerBindings.worker?.logicalSessionId).toBe(binding?.logicalSessionId);
    const reloaded = await new StateStore(path).load();
    expect(reloaded.orchestration.workerBindings.worker?.transportEngine).toBe("cli");
    expect(reloaded.orchestration.workerBindings.worker?.logicalSessionId).toBe(binding?.logicalSessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load quarantines worker bindings with present-but-invalid logicalSessionId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const state = createEmptyState();
  state.orchestration.workerBindings.bad = {
    sourceHandle: "bad",
    coordinatorSession: "coord",
    workspace: "project",
    targetAgent: "codex",
    agentEndpointId: "endpoint_bad",
    logicalSessionId: "garbage",
    transportEngine: "cli",
  };
  state.orchestration.workerBindings.empty = {
    sourceHandle: "empty",
    coordinatorSession: "coord",
    workspace: "project",
    targetAgent: "codex",
    agentEndpointId: "endpoint_empty",
    logicalSessionId: "",
    transportEngine: "cli",
  };
  await Bun.write(path, JSON.stringify(state));

  try {
    const store = new StateStore(path);
    const loaded = await store.load();
    // Corrupt identities are dropped, never silently re-minted (which would
    // switch the identity out from under queues/fences/affinity).
    expect(loaded.orchestration.workerBindings.bad).toBeUndefined();
    expect(loaded.orchestration.workerBindings.empty).toBeUndefined();
    expect(store.lastLoadReport?.dropped.map((d) => d.key).sort()).toEqual(["bad", "empty"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("load quarantines every current worker or external coordinator with a duplicate endpoint identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const state = createEmptyState();
  const worker = (sourceHandle: string, agentEndpointId: string) => ({
    sourceHandle,
    agentEndpointId,
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
  });
  const external = (coordinatorSession: string, agentEndpointId: string) => ({
    coordinatorSession,
    agentEndpointId,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  });

  state.orchestration.workerBindings = {
    "worker-a": worker("worker-a", "endpoint_duplicate_workers"),
    "worker-b": worker("worker-b", "endpoint_duplicate_workers"),
    "worker-cross": worker("worker-cross", "endpoint_duplicate_cross_section"),
    "worker-ok": worker("worker-ok", "endpoint_unique_worker"),
  };
  state.orchestration.externalCoordinators = {
    "external-cross": external("external-cross", "endpoint_duplicate_cross_section"),
    "external-a": external("external-a", "endpoint_duplicate_externals"),
    "external-b": external("external-b", "endpoint_duplicate_externals"),
    "external-ok": external("external-ok", "endpoint_unique_external"),
  };
  await Bun.write(path, JSON.stringify(state));

  try {
    const store = new StateStore(path, { now: () => new Date("2026-08-18T12:00:00.000Z") });
    const loaded = await store.load();

    expect(Object.keys(loaded.orchestration.workerBindings)).toEqual(["worker-ok"]);
    expect(Object.keys(loaded.orchestration.externalCoordinators)).toEqual(["external-ok"]);
    // worker-ok is a legacy binding without engine/LID: it is migrated
    // (fail-safe cli + stable LID), not quarantined.
    expect(store.lastLoadReport?.migrated ?? []).toEqual([
      {
        section: "orchestration.workerBindings",
        key: "worker-ok",
        reason: expect.stringContaining("transportEngine"),
      },
      {
        section: "orchestration.workerBindings",
        key: "worker-ok",
        reason: expect.stringContaining("logicalSessionId"),
      },
    ]);
    expect(store.lastLoadReport?.dropped).toHaveLength(6);
    expect(store.lastLoadReport?.dropped).toEqual(
      expect.arrayContaining([
        {
          section: "orchestration.workerBindings",
          key: "worker-a",
          reason: expect.stringContaining("endpoint_duplicate_workers"),
        },
        {
          section: "orchestration.workerBindings",
          key: "worker-b",
          reason: expect.stringContaining("endpoint_duplicate_workers"),
        },
        {
          section: "orchestration.workerBindings",
          key: "worker-cross",
          reason: expect.stringContaining("endpoint_duplicate_cross_section"),
        },
        {
          section: "orchestration.externalCoordinators",
          key: "external-cross",
          reason: expect.stringContaining("endpoint_duplicate_cross_section"),
        },
        {
          section: "orchestration.externalCoordinators",
          key: "external-a",
          reason: expect.stringContaining("endpoint_duplicate_externals"),
        },
        {
          section: "orchestration.externalCoordinators",
          key: "external-b",
          reason: expect.stringContaining("endpoint_duplicate_externals"),
        },
      ]),
    );
    expect(store.lastLoadReport?.quarantinePath).toBeDefined();
    await expect(stat(store.lastLoadReport!.quarantinePath!)).resolves.toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("defaults missing native session lists to an empty cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    native_session_lists: {},
  });

  await rm(dir, { recursive: true, force: true });
});

test("defaults a non-object native session list field to an empty cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      native_session_lists: "not-an-object",
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    native_session_lists: {},
  });

  await rm(dir, { recursive: true, force: true });
});

test("drops malformed native session list cache entries but keeps valid ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      native_session_lists: {
        "wx:good": {
          created_at: "2026-05-26T10:00:00.000Z",
          agent: "codex",
          cwd: "/Users/example/project",
          sessions: [{ session_id: "thread-1" }],
        },
        "wx:bad": {
          created_at: "2026-05-26T10:00:00.000Z",
          sessions: "not-an-array",
        },
      },
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
      },
    }),
  );

  const state = await store.load();
  expect(state.native_session_lists["wx:good"]).toBeDefined();
  expect(state.native_session_lists["wx:bad"]).toBeUndefined();

  await rm(dir, { recursive: true, force: true });
});

test("returns an empty state when the file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const store = new StateStore(join(dir, "state.json"));

  await expect(store.load()).resolves.toEqual({
    sessions: {},
    chat_contexts: {},
    native_session_lists: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {},
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("persists sessions and chat context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  const state = {
    sessions: {
      "api-fix": {
        alias: "api-fix",
        agent: "codex",
        workspace: "backend",
        transport_session: "backend:api-fix",
        logical_session_id: "33333333-3333-4333-8333-333333333333",
        transport_agent_command: "npx @zed-industries/codex-acp@^0.9.5",
        transport_engine: "cli",
        created_at: "2026-03-24T10:00:00.000Z",
        last_used_at: "2026-03-24T10:00:00.000Z",
      },
    },
    chat_contexts: {
      "wx:user": {
        current_session: "api-fix",
      },
    },
    scheduled_tasks: {},
    orchestration: {
      tasks: {
        "task-1": {
          taskId: "task-1",
          sourceHandle: "backend:main",
          sourceKind: "human",
          coordinatorSession: "backend:main",
          workerSession: "backend:claude-reviewer:feature-x",
          workspace: "backend",
          targetAgent: "claude",
          role: "reviewer",
          task: "审查当前方案风险",
          status: "running",
          summary: "正在审查当前方案风险",
          resultText: "",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:00:00.000Z",
          eventSeq: 2,
          events: [
            { seq: 1, at: "2026-04-13T10:00:00.000Z", type: "created", status: "running", message: "Task created" },
            { seq: 2, at: "2026-04-13T10:00:01.000Z", type: "progress", status: "running", summary: "正在审查当前方案风险" },
          ],
        },
      },
      workerBindings: {
        "backend:claude-reviewer:feature-x": {
          sourceHandle: "backend:claude-reviewer:feature-x",
          agentEndpointId: "endpoint_44444444-4444-4444-8444-444444444444",
          coordinatorSession: "backend:main",
          workspace: "backend",
          targetAgent: "claude",
          role: "reviewer",
        },
      },
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  };

  await store.save(state);
  await expect(store.load()).resolves.toEqual({
    ...state,
    native_session_lists: {},
    scheduled_tasks: {},
    orchestration: {
      ...state.orchestration,
      workerBindings: {
        "backend:claude-reviewer:feature-x": {
          ...state.orchestration.workerBindings["backend:claude-reviewer:feature-x"],
          // Load-time legacy migration (fail-safe cli, stable LID).
          transportEngine: "cli",
          logicalSessionId: expect.any(String),
        },
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("round-trips blocker-loop state records through load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  const state = {
    sessions: {},
    chat_contexts: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {
        "task-1": {
          taskId: "task-1",
          sourceHandle: "backend:main",
          sourceKind: "worker",
          coordinatorSession: "backend:main",
          workerSession: "backend:claude:backend:main",
          workspace: "backend",
          targetAgent: "claude",
          task: "继续处理数据库方案",
          status: "blocked",
          summary: "等待数据库方案确认",
          resultText: "",
          createdAt: "2026-04-21T10:00:00.000Z",
          updatedAt: "2026-04-21T10:01:00.000Z",
          openQuestion: {
            questionId: "question-1",
            question: "继续 SQLite 还是切 Postgres？",
            whyBlocked: "schema choice affects follow-up work",
            whatIsNeeded: "database decision",
            askedAt: "2026-04-21T10:00:30.000Z",
            status: "open",
            packageId: "package-1",
          },
        },
        "task-2": {
          taskId: "task-2",
          sourceHandle: "backend:main",
          sourceKind: "coordinator",
          coordinatorSession: "backend:main",
          workerSession: "backend:claude:backend:main",
          workspace: "backend",
          targetAgent: "claude",
          task: "确认误路由结果",
          status: "completed",
          summary: "等待 coordinator 判定",
          resultText: "result payload",
          createdAt: "2026-04-21T10:02:00.000Z",
          updatedAt: "2026-04-21T10:03:00.000Z",
          reviewPending: {
            reviewId: "review-1",
            reason: "misrouted_answer",
            createdAt: "2026-04-21T10:03:00.000Z",
            resultId: "result-1",
            resultText: "result payload",
          },
        },
        "task-3": {
          taskId: "task-3",
          sourceHandle: "backend:main",
          sourceKind: "coordinator",
          coordinatorSession: "backend:main",
          workerSession: "backend:claude:backend:main",
          workspace: "backend",
          targetAgent: "claude",
          task: "处理纠正中的 task",
          status: "running",
          summary: "等待纠正结果",
          resultText: "",
          createdAt: "2026-04-21T10:04:00.000Z",
          updatedAt: "2026-04-21T10:05:00.000Z",
          correctionPending: {
            requestedAt: "2026-04-21T10:05:00.000Z",
            reason: "misrouted_answer",
          },
        },
      },
      workerBindings: {
        "backend:claude:backend:main": {
          sourceHandle: "backend:claude:backend:main",
          agentEndpointId: "endpoint_55555555-5555-4555-8555-555555555555",
          coordinatorSession: "backend:main",
          workspace: "backend",
          targetAgent: "claude",
        },
      },
      groups: {},
      humanQuestionPackages: {
        "package-1": {
          packageId: "package-1",
          coordinatorSession: "backend:main",
          status: "active",
          createdAt: "2026-04-21T10:00:00.000Z",
          updatedAt: "2026-04-21T10:05:00.000Z",
          initialTaskIds: ["task-1"],
          openTaskIds: ["task-1"],
          resolvedTaskIds: ["task-3"],
          messages: [
            {
              messageId: "message-1",
              kind: "initial",
              promptText: "请确认数据库方案和文件写入边界",
              createdAt: "2026-04-21T10:00:00.000Z",
              deliveredAt: "2026-04-21T10:00:10.000Z",
              deliveredChatKey: "wx:user-1",
              deliveryAccountId: "account-1",
            },
          ],
          awaitingReplyMessageId: "message-1",
        },
      },
      coordinatorQuestionState: {
        "backend:main": {
          activePackageId: "package-1",
          queuedQuestions: [
            {
              taskId: "task-3",
              questionId: "question-3",
              enqueuedAt: "2026-04-21T10:05:00.000Z",
            },
          ],
        },
      },
      coordinatorRoutes: {
        "backend:main": {
          coordinatorSession: "backend:main",
          chatKey: "wx:user-1",
          accountId: "account-1",
          replyContextToken: "reply-token-1",
          updatedAt: "2026-04-21T10:05:00.000Z",
        },
      },
      externalCoordinators: {},
    },
  };

  await store.save(state);
  await expect(store.load()).resolves.toEqual({
    ...state,
    native_session_lists: {},
    orchestration: {
      ...state.orchestration,
      workerBindings: {
        "backend:claude:backend:main": {
          ...state.orchestration.workerBindings["backend:claude:backend:main"],
          // Load-time legacy migration (fail-safe cli, stable LID).
          transportEngine: "cli",
          logicalSessionId: expect.any(String),
        },
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("loads orchestration task records with coordinator injection metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:worker",
            workspace: "backend",
            targetAgent: "claude",
            task: "inject result back to coordinator",
            status: "completed",
            summary: "worker result injected",
            resultText: "done",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            coordinatorInjectedAt: "2026-04-13T10:06:00.000Z",
          },
        },
        workerBindings: {},
        groups: {},
      },
    }),
  );

  await expect(store.load()).resolves.toEqual({
    sessions: {},
    chat_contexts: {},
    native_session_lists: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {
        "task-1": {
          taskId: "task-1",
          sourceHandle: "backend:main",
          sourceKind: "coordinator",
          coordinatorSession: "backend:main",
          workerSession: "backend:worker",
          workspace: "backend",
          targetAgent: "claude",
          task: "inject result back to coordinator",
          status: "completed",
          summary: "worker result injected",
          resultText: "done",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:05:00.000Z",
          coordinatorInjectedAt: "2026-04-13T10:06:00.000Z",
        },
      },
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("loads orchestration groups and grouped tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review api",
            groupId: "group-review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:05:00.000Z",
          },
        },
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:05:00.000Z",
          },
        },
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    orchestration: {
      tasks: {
        "task-1": {
          groupId: "group-review",
        },
      },
      groups: {
        "group-review": {
          title: "review",
        },
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("loads orchestration task records with reliability metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "wx:user",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:worker",
            workspace: "backend",
            targetAgent: "claude",
            task: "keep track of reliability metadata",
            status: "running",
            summary: "waiting",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            cancelRequestedAt: "2026-04-13T10:01:00.000Z",
            cancelCompletedAt: "2026-04-13T10:02:00.000Z",
            lastCancelError: "transport busy",
            noticePending: true,
            noticeSentAt: "2026-04-13T10:03:00.000Z",
            lastNoticeError: "wechat disconnected",
            injectionPending: true,
            injectionAppliedAt: "2026-04-13T10:04:00.000Z",
            lastInjectionError: "coordinator busy",
          },
        },
        workerBindings: {},
        groups: {},
      },
    }),
  );

  await expect(store.load()).resolves.toEqual({
    sessions: {},
    chat_contexts: {},
    native_session_lists: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {
        "task-1": {
          taskId: "task-1",
          sourceHandle: "wx:user",
          sourceKind: "human",
          coordinatorSession: "backend:main",
          workerSession: "backend:worker",
          workspace: "backend",
          targetAgent: "claude",
          task: "keep track of reliability metadata",
          status: "running",
          summary: "waiting",
          resultText: "",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:05:00.000Z",
          cancelRequestedAt: "2026-04-13T10:01:00.000Z",
          cancelCompletedAt: "2026-04-13T10:02:00.000Z",
          lastCancelError: "transport busy",
          noticePending: true,
          noticeSentAt: "2026-04-13T10:03:00.000Z",
          lastNoticeError: "wechat disconnected",
          injectionPending: true,
          injectionAppliedAt: "2026-04-13T10:04:00.000Z",
          lastInjectionError: "coordinator busy",
        },
      },
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("treats an empty state file as empty state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(path, "");
  await expect(store.load()).resolves.toEqual({
    sessions: {},
    chat_contexts: {},
    native_session_lists: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {},
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  });

  await rm(dir, { recursive: true, force: true });
});


test("resets a non-object sessions field to empty and reports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(path, JSON.stringify({ sessions: [], chat_contexts: {} }));

  const state = await store.load();
  expect(state.sessions).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "sessions", key: "", reason: expect.stringContaining("not an object") },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("resets a non-object chat_contexts field to empty and reports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(path, JSON.stringify({ sessions: {}, chat_contexts: [] }));

  const state = await store.load();
  expect(state.chat_contexts).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "chat_contexts", key: "", reason: expect.stringContaining("not an object") },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("loads older states without orchestration as empty orchestration state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
    }),
  );

  await expect(store.load()).resolves.toEqual({
    sessions: {},
    chat_contexts: {},
    native_session_lists: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {},
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  });

  await rm(dir, { recursive: true, force: true });
});


test("loads older orchestration state without external coordinators as empty external coordinators", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.externalCoordinators).toEqual({});

  await rm(dir, { recursive: true, force: true });
});

test("loads and validates external coordinator records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
            defaultTargetAgent: "codex",
          },
        },
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    orchestration: {
      externalCoordinators: {
        "codex:backend": {
          coordinatorSession: "codex:backend",
          workspace: "backend",
          createdAt: "2026-04-28T10:00:00.000Z",
          updatedAt: "2026-04-28T10:05:00.000Z",
          defaultTargetAgent: "codex",
        },
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("drops malformed external coordinator records and reports them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: 123,
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.externalCoordinators).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    {
      section: "orchestration.externalCoordinators",
      key: "codex:backend",
      reason: "malformed external coordinator record",
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("drops external coordinator records whose map key does not match coordinatorSession", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:other",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.externalCoordinators).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    {
      section: "orchestration.externalCoordinators",
      key: "codex:backend",
      reason: expect.stringContaining("does not match map key"),
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("repairs stable external coordinator handles that collide with reset-suffixed logical sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "codex:backend:reset-1700000000000",
          created_at: "2026-04-28T10:00:00.000Z",
          last_used_at: "2026-04-28T10:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  const state = await store.load();
  expect(state.sessions.main).toBeDefined();
  expect(state.orchestration.externalCoordinators).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    {
      section: "orchestration.externalCoordinators",
      key: "codex:backend",
      reason: expect.stringContaining("conflicts with a logical session"),
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("repairs external coordinator handles that collide with worker bindings in persisted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {
          "codex:backend": {
            sourceHandle: "codex:backend",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
          },
        },
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.workerBindings["codex:backend"]).toBeDefined();
  expect(state.orchestration.externalCoordinators).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    {
      section: "orchestration.externalCoordinators",
      key: "codex:backend",
      reason: expect.stringContaining("conflicts with a worker binding"),
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("repairs external coordinator handles that collide with active task worker sessions in persisted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "codex:backend",
            workspace: "backend",
            targetAgent: "codex",
            task: "review",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.tasks["task-1"]).toBeDefined();
  expect(state.orchestration.externalCoordinators).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    {
      section: "orchestration.externalCoordinators",
      key: "codex:backend",
      reason: expect.stringContaining("conflicts with an active task worker session"),
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("loads pathless external coordinators and cwd-bound task records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "external_codex:abcd1234",
            sourceKind: "coordinator",
            coordinatorSession: "external_codex:abcd1234",
            workerSession: "weacpx:claude:external_codex:abcd1234",
            workspace: "weacpx",
            cwd: "/repo/weacpx",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        workerBindings: {
          "weacpx:claude:external_codex:abcd1234": {
            sourceHandle: "weacpx:claude:external_codex:abcd1234",
            coordinatorSession: "external_codex:abcd1234",
            workspace: "weacpx",
            cwd: "/repo/weacpx",
            targetAgent: "claude",
          },
        },
        groups: {},
        externalCoordinators: {
          "external_codex:abcd1234": {
            coordinatorSession: "external_codex:abcd1234",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    orchestration: {
      tasks: {
        "task-1": { cwd: "/repo/weacpx" },
      },
      workerBindings: {
        "weacpx:claude:external_codex:abcd1234": { cwd: "/repo/weacpx" },
      },
      externalCoordinators: {
        "external_codex:abcd1234": {
          coordinatorSession: "external_codex:abcd1234",
        },
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("allows external coordinator handles that only match terminal task worker sessions in persisted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "codex:backend",
            workspace: "backend",
            targetAgent: "codex",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
      },
    }),
  );

  await expect(store.load()).resolves.toMatchObject({
    orchestration: {
      externalCoordinators: {
        "codex:backend": {
          workspace: "backend",
        },
      },
    },
  });

  await rm(dir, { recursive: true, force: true });
});

test("resets a non-object orchestration field to empty and reports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(path, JSON.stringify({ sessions: {}, chat_contexts: {}, orchestration: [] }));

  const state = await store.load();
  expect(state.orchestration.tasks).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "orchestration", key: "", reason: expect.stringContaining("not an object") },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("resets a non-object orchestration.tasks field to empty and reports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: [],
        workerBindings: {},
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.tasks).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "orchestration.tasks", key: "", reason: expect.stringContaining("not an object") },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("resets a non-object orchestration.workerBindings field to empty and reports it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: [],
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.workerBindings).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "orchestration.workerBindings", key: "", reason: expect.stringContaining("not an object") },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("drops malformed orchestration task entries and reports them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "not-a-status",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {},
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.tasks).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "orchestration.tasks", key: "task-1", reason: "malformed orchestration task record" },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("drops malformed orchestration worker binding entries and reports them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {
          "worker-1": {
            sourceHandle: "worker-1",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: 123,
          },
        },
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.workerBindings).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    {
      section: "orchestration.workerBindings",
      key: "worker-1",
      reason: "malformed orchestration worker binding record",
    },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("loads orchestration task records with progress metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "wx:user",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:worker",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:05:00.000Z",
            lastProgressAt: "2026-04-18T10:03:00.000Z",
            lastProgressSummary: "reading files",
          },
        },
        workerBindings: {},
      },
    }),
  );

  const state = await store.load();
  expect(state.orchestration.tasks["task-1"].lastProgressAt).toBe("2026-04-18T10:03:00.000Z");
  expect(state.orchestration.tasks["task-1"].lastProgressSummary).toBe("reading files");

  await rm(dir, { recursive: true, force: true });
});

test("recovers from malformed JSON by renaming the file aside and starting empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(path, "{not-json");

  const state = await store.load();
  expect(state.sessions).toEqual({});
  const report = store.lastLoadReport;
  expect(report?.corruptPath).toMatch(/state\.json\.corrupt-/);
  expect(report?.dropped[0]?.key).toBe(path);

  await rm(dir, { recursive: true, force: true });
});


test("saves state with owner-only file permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await store.save({
    sessions: {},
    chat_contexts: {},
    scheduled_tasks: {},
    orchestration: {
      tasks: {},
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  });

  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  }

  await rm(dir, { recursive: true, force: true });
});

test("drops malformed session records and reports them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  await Bun.write(
    path,
    JSON.stringify({
      sessions: {
        broken: {
          alias: "broken",
          agent: "codex",
          workspace: "backend",
          transport_session: 123,
          created_at: "2026-01-01T00:00:00.000Z",
          last_used_at: "2026-01-01T00:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        humanQuestionPackages: {},
        coordinatorQuestionState: {},
        coordinatorRoutes: {},
        externalCoordinators: {},
      },
    }),
  );

  const store = new StateStore(path);
  const state = await store.load();
  expect(state.sessions).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "sessions", key: "broken", reason: "malformed session record" },
  ]);
  await rm(dir, { recursive: true, force: true });
});

test("drops malformed chat context records and reports them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {
        "wx:user": { current_session: 42 },
      },
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        humanQuestionPackages: {},
        coordinatorQuestionState: {},
        coordinatorRoutes: {},
        externalCoordinators: {},
      },
    }),
  );

  const store = new StateStore(path);
  const state = await store.load();
  expect(state.chat_contexts).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "chat_contexts", key: "wx:user", reason: "malformed chat context record" },
  ]);
  await rm(dir, { recursive: true, force: true });
});

test("round-trips a temp scheduled task with session_mode + agent/workspace snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  const state = {
    sessions: {},
    chat_contexts: {},
    scheduled_tasks: {
      tmp1: {
        id: "tmp1",
        chat_key: "weixin:user-1",
        session_alias: "backend:codex",
        session_mode: "temp",
        agent: "codex",
        workspace: "backend",
        execute_at: "2026-05-24T10:00:00.000Z",
        message: "检查 CI",
        status: "pending",
        created_at: "2026-05-24T09:00:00.000Z",
      },
    },
    orchestration: {
      tasks: {},
      workerBindings: {},
      groups: {},
      humanQuestionPackages: {},
      coordinatorQuestionState: {},
      coordinatorRoutes: {},
      externalCoordinators: {},
    },
  };

  await store.save(state);
  const loaded = await store.load();
  expect(loaded.scheduled_tasks.tmp1?.session_mode).toBe("temp");
  expect(loaded.scheduled_tasks.tmp1?.agent).toBe("codex");
  expect(loaded.scheduled_tasks.tmp1?.workspace).toBe("backend");

  await rm(dir, { recursive: true, force: true });
});

test("drops scheduled tasks with an invalid session_mode and reports them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  await Bun.write(
    path,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      scheduled_tasks: {
        bad1: {
          id: "bad1",
          chat_key: "weixin:user-1",
          session_alias: "backend:codex",
          session_mode: "nonsense",
          execute_at: "2026-05-24T10:00:00.000Z",
          message: "检查 CI",
          status: "pending",
          created_at: "2026-05-24T09:00:00.000Z",
        },
      },
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        humanQuestionPackages: {},
        coordinatorQuestionState: {},
        coordinatorRoutes: {},
        externalCoordinators: {},
      },
    }),
  );

  const store = new StateStore(path);
  const state = await store.load();
  expect(state.scheduled_tasks).toEqual({});
  expect(store.lastLoadReport?.dropped).toEqual([
    { section: "scheduled_tasks", key: "bad1", reason: "malformed scheduled task record" },
  ]);
  await rm(dir, { recursive: true, force: true });
});

test("load keeps sessions with legacy source 'weacpx' and new source 'xacpx'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {
        "w:legacy": {
          alias: "w:legacy", agent: "codex", workspace: "w", transport_session: "w:legacy",
          source: "weacpx", created_at: "2026-01-01T00:00:00.000Z", last_used_at: "2026-01-01T00:00:00.000Z",
        },
        "w:fresh": {
          alias: "w:fresh", agent: "codex", workspace: "w", transport_session: "w:fresh",
          source: "xacpx", created_at: "2026-01-01T00:00:00.000Z", last_used_at: "2026-01-01T00:00:00.000Z",
        },
      },
      chat_contexts: {},
      orchestration: { tasks: {}, workerBindings: {}, groups: {} },
    }),
  );

  const state = await store.load();
  expect(state.sessions["w:legacy"]?.source).toBe("weacpx");
  expect(state.sessions["w:fresh"]?.source).toBe("xacpx");

  await rm(dir, { recursive: true, force: true });
});

// ── structured launch metadata ───────────────────────────────────────────────

test("round-trips transport_acpx_agent and transport_agent_argv", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const store = new StateStore(join(dir, "state.json"));
  const state = createEmptyState();
  state.sessions.demo = {
    alias: "demo",
    agent: "custom",
    workspace: "backend",
    transport_session: "backend:demo",
    transport_acpx_agent: "xacpx-managed-custom-abc123def456",
    transport_agent_argv: ["C:\\Program Files\\agent.exe", "--acp", ""],
    created_at: "2026-08-05T00:00:00.000Z",
    last_used_at: "2026-08-05T00:00:00.000Z",
  };
  await store.save(state);
  const loaded = await store.load();
  expect(loaded.sessions.demo.transport_acpx_agent).toBe("xacpx-managed-custom-abc123def456");
  expect(loaded.sessions.demo.transport_agent_argv).toEqual(["C:\\Program Files\\agent.exe", "--acp", ""]);
  await rm(dir, { recursive: true, force: true });
});

test("rejects a malformed transport_agent_argv and keeps the record loadable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const store = new StateStore(join(dir, "state.json"));
  const state = createEmptyState();
  state.sessions.demo = {
    alias: "demo",
    agent: "custom",
    workspace: "backend",
    transport_session: "backend:demo",
    transport_agent_argv: ["ok", 42],
    created_at: "2026-08-05T00:00:00.000Z",
    last_used_at: "2026-08-05T00:00:00.000Z",
  };
  await store.save(state);
  const loaded = await store.load();
  expect(loaded.sessions.demo).toBeUndefined();
  await rm(dir, { recursive: true, force: true });
});

// ── logical_session_id migration ─────────────────────────────────────────────

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function legacySessionRecord(alias: string) {
  // Pre-migration shape: everything a valid session needs EXCEPT logical_session_id.
  return {
    alias,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:${alias}`,
    created_at: "2026-06-10T10:00:00.000Z",
    last_used_at: "2026-06-10T10:00:00.000Z",
  };
}

test("load migrates legacy sessions missing logical_session_id, persists them, and reports the migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {
        legacy: legacySessionRecord("legacy"),
        current: {
          ...legacySessionRecord("current"),
          logical_session_id: "11111111-1111-4111-8111-111111111111",
        },
      },
      chat_contexts: {},
    }),
  );

  const state = await store.load();
  const migratedId = state.sessions.legacy?.logical_session_id;
  expect(migratedId).toMatch(UUID_V4_PATTERN);
  // an existing valid id is never rewritten
  expect(state.sessions.current?.logical_session_id).toBe("11111111-1111-4111-8111-111111111111");

  // the report distinguishes a migration from a dropped corrupt record
  const report = store.lastLoadReport;
  expect(report?.dropped).toEqual([]);
  expect(report?.migrated).toEqual([
    { section: "sessions", key: "legacy", reason: expect.stringContaining("logical_session_id") },
    { section: "sessions", key: "legacy", reason: expect.stringContaining("transport_engine") },
    { section: "sessions", key: "current", reason: expect.stringContaining("transport_engine") },
  ]);

  // the migration is durable BEFORE load() returns: the file on disk already
  // carries the exact id that was handed to the caller
  const onDisk = JSON.parse(await readFile(path, "utf8")) as {
    sessions: Record<string, { logical_session_id?: string }>;
  };
  expect(onDisk.sessions.legacy?.logical_session_id).toBe(migratedId);

  await rm(dir, { recursive: true, force: true });
});

test("a second load keeps migrated logical_session_id values stable and reports nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");

  await Bun.write(
    path,
    JSON.stringify({
      sessions: { legacy: legacySessionRecord("legacy") },
      chat_contexts: {},
    }),
  );

  const firstId = (await new StateStore(path).load()).sessions.legacy?.logical_session_id;
  expect(firstId).toMatch(UUID_V4_PATTERN);

  const secondStore = new StateStore(path);
  const secondState = await secondStore.load();
  expect(secondState.sessions.legacy?.logical_session_id).toBe(firstId);
  expect(secondStore.lastLoadReport).toBeNull();

  await rm(dir, { recursive: true, force: true });
});

test("load rejects and does not publish temporary ids when the migration save fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const raw = JSON.stringify({
    sessions: { legacy: legacySessionRecord("legacy") },
    chat_contexts: {},
  });
  await Bun.write(path, raw);

  const store = new StateStore(path, {
    writeMigration: async () => {
      throw new Error("disk full");
    },
  });

  await expect(store.load()).rejects.toThrow("disk full");
  // no in-memory-only id was published and the file was left untouched
  expect(store.lastLoadReport).toBeNull();
  expect(await readFile(path, "utf8")).toBe(raw);

  await rm(dir, { recursive: true, force: true });
});

test("a present-but-invalid logical_session_id is quarantined, never migrated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const store = new StateStore(path);

  await Bun.write(
    path,
    JSON.stringify({
      sessions: {
        good: {
          ...legacySessionRecord("good"),
          logical_session_id: "22222222-2222-4222-8222-222222222222",
        },
        "bad-type": { ...legacySessionRecord("bad-type"), logical_session_id: 42 },
        "bad-shape": { ...legacySessionRecord("bad-shape"), logical_session_id: "not-a-uuid" },
        // a valid UUID but not v4: still not a logical_session_id
        "bad-version": {
          ...legacySessionRecord("bad-version"),
          logical_session_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        },
      },
      chat_contexts: {},
    }),
  );

  const state = await store.load();
  expect(state.sessions.good?.logical_session_id).toBe("22222222-2222-4222-8222-222222222222");
  expect(state.sessions["bad-type"]).toBeUndefined();
  expect(state.sessions["bad-shape"]).toBeUndefined();
  expect(state.sessions["bad-version"]).toBeUndefined();

  const report = store.lastLoadReport;
  expect(report?.dropped).toHaveLength(3);
  expect(report?.dropped.every((record) => record.reason === "malformed session record")).toBe(true);
  expect(report?.migrated).toEqual([
    { section: "sessions", key: "good", reason: expect.stringContaining("transport_engine") },
  ]);

  await rm(dir, { recursive: true, force: true });
});

test("inspect reports pending id migrations without writing anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-state-"));
  const path = join(dir, "state.json");
  const raw = JSON.stringify({
    sessions: { legacy: legacySessionRecord("legacy") },
    chat_contexts: {},
  });
  await Bun.write(path, raw);

  const store = new StateStore(path);
  const inspection = await store.inspect();

  // diagnostic callers get a fully-typed state (in-memory id)…
  expect(inspection.state.sessions.legacy?.logical_session_id).toMatch(UUID_V4_PATTERN);
  // …and can tell a pending migration apart from a dropped corrupt record
  expect(inspection.report?.dropped).toEqual([]);
  expect(inspection.report?.migrated).toEqual([
    { section: "sessions", key: "legacy", reason: expect.stringContaining("logical_session_id") },
    { section: "sessions", key: "legacy", reason: expect.stringContaining("transport_engine") },
  ]);
  // side-effect free: nothing persisted, no backup files
  expect(await readFile(path, "utf8")).toBe(raw);
  expect(await readdir(dir)).toEqual(["state.json"]);

  await rm(dir, { recursive: true, force: true });
});
