import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
        transport_agent_command: "npx @zed-industries/codex-acp@^0.9.5",
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
