import { expect, test, mock } from "bun:test";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/index";
import {
  createControlBridge,
  scheduledTaskToDto,
  subscribeControlEvents,
} from "../../../../packages/channel-relay/src/control-bridge";

const req = (type: string, payload: unknown): RelayEnvelope => ({
  protocolVersion: RELAY_PROTOCOL_VERSION,
  kind: "req",
  id: "r-1",
  type,
  payload,
});

function makeFakeControl(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => {
    (calls[name] ??= []).push(args);
  };
  const listeners: Array<(event: unknown) => void> = [];
  const control = {
    listSessions: () => [
      {
        alias: "a",
        agent: "claude",
        workspace: "/ws",
        transportSession: "t",
        running: false,
      },
    ],
    createSession: async (alias: string, agent: string, workspace: string) => {
      record("createSession", { alias, agent, workspace });
      return { alias, agent, workspace, transportSession: "t", running: false };
    },
    removeSession: async (alias: string) => {
      record("removeSession", alias);
      return { wasActive: false };
    },
    listAgents: () => [
      { name: "codex", driver: "codex" },
      { name: "claude", driver: "claude" },
    ],
    listWorkspaces: () => [{ name: "home", cwd: "/home", description: "h" }],
    createWorkspace: async (
      name: string,
      cwd: string,
      description?: string,
    ) => {
      record("createWorkspace", { name, cwd, description });
      return { name, cwd, ...(description ? { description } : {}) };
    },
    prompt: async (input: unknown) => {
      record("prompt", input);
      return { ok: true, text: "done" };
    },
    fsWrite: async (
      workspace: string,
      path: string,
      content: string,
      expected: unknown,
    ) => {
      record("fsWrite", { workspace, path, content, expected });
      return { path, mtimeMs: 2, size: content.length };
    },
    workspaceGitStatus: async (workspace: string) => ({
      workspace,
      branch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      worktree: { root: "/repo", linked: false },
      files: [],
      branches: [],
      worktrees: [],
    }),
    gitStage: async (workspace: string, paths: string[]) => {
      record("gitStage", { workspace, paths });
    },
    gitUnstage: async (workspace: string, paths: string[]) => {
      record("gitUnstage", { workspace, paths });
    },
    gitUntrack: async (workspace: string, paths: string[]) => {
      record("gitUntrack", { workspace, paths });
    },
    gitDiscard: async (workspace: string, paths: string[]) => {
      record("gitDiscard", { workspace, paths });
    },
    gitCommit: async (workspace: string, message: string) => {
      record("gitCommit", { workspace, message });
      return { hash: "abcdef123456", shortHash: "abcdef1", summary: message };
    },
    gitFetch: async (workspace: string, remote?: string) => {
      record("gitFetch", { workspace, remote });
    },
    gitPull: async (workspace: string) => {
      record("gitPull", { workspace });
    },
    gitPush: async (workspace: string, options?: unknown) => {
      record("gitPush", { workspace, options });
    },
    gitCheckout: async (workspace: string, options: unknown) => {
      record("gitCheckout", { workspace, options });
    },
    gitCreateWorktree: async (
      workspace: string,
      input: { workspaceName: string; branch: string },
    ) => {
      record("gitCreateWorktree", { workspace, input });
      return {
        worktree: { path: "/managed/wt", branch: input.branch, linked: true },
        workspace: { name: input.workspaceName, cwd: "/managed/wt" },
      };
    },
    cancelTurn: (chatKey: string, alias: string) => {
      record("cancelTurn", { chatKey, alias });
      return true;
    },
    cancelQueuedItem: (chatKey: string, alias: string, itemId: string) => {
      record("cancelQueuedItem", { chatKey, alias, itemId });
      return { cancelled: true };
    },
    executeCommand: async (input: unknown) => {
      record("executeCommand", input);
      return "output";
    },
    getSessionEffort: async () => ({
      current: "medium",
      available: ["low", "medium", "high"],
    }),
    setSessionEffort: async (
      _chatKey: string,
      _alias: string,
      effort: string,
    ) => ({ current: effort, applied: true }),
    listScheduledTasks: (chatKey: string) => [
      {
        id: "ab12",
        chat_key: chatKey,
        session_alias: "a",
        execute_at: "2026-06-14T10:00:00.000Z",
        message: "m",
        status: "pending",
        created_at: "2026-06-13T10:00:00.000Z",
      },
    ],
    createScheduledTask: async (input: {
      chatKey: string;
      executeAt: Date;
    }) => {
      record("createScheduledTask", input);
      return {
        id: "cd34",
        chat_key: input.chatKey,
        session_alias: "a",
        execute_at: input.executeAt.toISOString(),
        message: "m",
        status: "pending",
        created_at: "2026-06-13T10:00:00.000Z",
      };
    },
    cancelScheduledTask: async () => true,
    listOrchestrationTasks: async () => [
      {
        taskId: "t1",
        status: "running",
        targetAgent: "claude",
        workspace: "/ws",
        task: "do",
        summary: "s",
        createdAt: "x",
        updatedAt: "y",
        sourceHandle: "h",
        sourceKind: "human",
        coordinatorSession: "c",
        resultText: "",
      },
    ],
    getOrchestrationTask: async () => null,
    cancelOrchestrationTask: async () => ({
      taskId: "t1",
      status: "cancelled",
      targetAgent: "claude",
      workspace: "/ws",
      task: "do",
      summary: "s",
      createdAt: "x",
      updatedAt: "y",
      sourceHandle: "h",
      sourceKind: "human",
      coordinatorSession: "c",
      resultText: "",
    }),
    events: {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    },
    ...overrides,
  };
  return {
    control,
    calls,
    emit: (event: unknown) => listeners.forEach((l) => l(event)),
  };
}

async function dispatch(
  bridge: ReturnType<typeof createControlBridge>,
  envelope: RelayEnvelope,
): Promise<unknown> {
  return await new Promise((resolve) => bridge(envelope, resolve));
}

test("sessions.list / prompt / command.execute dispatch and shape results", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(bridge, req(MSG.sessionsList, { chatKey: "relay:acct" })),
  ).toEqual({
    sessions: [
      {
        alias: "a",
        agent: "claude",
        workspace: "/ws",
        transportSession: "t",
        running: false,
      },
    ],
  });
  const promptResult = await dispatch(
    bridge,
    req(MSG.prompt, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      text: "hi",
      senderId: "acct",
      isOwner: true,
    }),
  );
  expect(promptResult).toEqual({ ok: true, text: "done" });
  expect(calls.prompt?.[0]).toEqual({
    chatKey: "relay:acct",
    sessionAlias: "a",
    text: "hi",
    senderId: "acct",
    isOwner: true,
  });
  expect(
    await dispatch(
      bridge,
      req(MSG.commandExecute, {
        chatKey: "k",
        text: "/status",
        senderId: "acct",
      }),
    ),
  ).toEqual({ output: "output" });
});

test("sessions.list routes filter-only payloads to the paginated path and passes filters through", async () => {
  const paged: Array<Record<string, unknown>> = [];
  const { control } = makeFakeControl({
    listSessionsPage: (
      chatKey: string,
      offset: number | undefined,
      limit: number | undefined,
      includeArchived: boolean | undefined,
      filters: unknown,
    ) => {
      paged.push({ chatKey, offset, limit, includeArchived, filters });
      return { sessions: [], hasMore: false, nextOffset: 0 };
    },
  });
  const bridge = createControlBridge(control as never);

  // archivedOnly + workspace without offset/limit must still hit the paginated path.
  expect(
    await dispatch(
      bridge,
      req(MSG.sessionsList, {
        chatKey: "relay:acct",
        archivedOnly: true,
        workspace: "/ws",
        limit: 5,
      }),
    ),
  ).toEqual({ sessions: [], hasMore: false, nextOffset: 0 });
  expect(paged).toEqual([
    {
      chatKey: "relay:acct",
      offset: undefined,
      limit: 5,
      includeArchived: undefined,
      filters: { archivedOnly: true, workspace: "/ws", agent: undefined },
    },
  ]);

  // includeArchived alone also takes the paginated path (previously ignored without offset/limit).
  await dispatch(
    bridge,
    req(MSG.sessionsList, { chatKey: "relay:acct", includeArchived: true }),
  );
  expect(paged[1]).toMatchObject({
    includeArchived: true,
    filters: {
      archivedOnly: undefined,
      workspace: undefined,
      agent: undefined,
    },
  });

  // A bare payload keeps the full-list path.
  expect(
    await dispatch(bridge, req(MSG.sessionsList, { chatKey: "relay:acct" })),
  ).toEqual({
    sessions: [
      {
        alias: "a",
        agent: "claude",
        workspace: "/ws",
        transportSession: "t",
        running: false,
      },
    ],
  });
  expect(paged).toHaveLength(2);
});

test("queue.cancel dispatches to cancelQueuedItem and returns its result", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.queueCancel, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      itemId: "q1",
    }),
  );
  expect(result).toEqual({ cancelled: true });
  expect(calls.cancelQueuedItem?.[0]).toEqual({
    chatKey: "relay:acct",
    alias: "a",
    itemId: "q1",
  });
});

test("git.status dispatches through the structured ControlService method", async () => {
  const { control } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(bridge, req(MSG.gitStatus, { workspace: "project" })),
  ).toEqual({
    workspace: "project",
    branch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    worktree: { root: "/repo", linked: false },
    files: [],
    branches: [],
    worktrees: [],
  });
});

test("structured Git mutation RPCs dispatch without accepting raw commands", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);

  expect(
    await dispatch(
      bridge,
      req(MSG.gitStage, { workspace: "project", paths: ["a.ts"] }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitUnstage, { workspace: "project", paths: ["a.ts"] }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitUntrack, { workspace: "project", paths: ["a.ts"] }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitDiscard, { workspace: "project", paths: ["a.ts"] }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitCommit, { workspace: "project", message: "feat: x" }),
    ),
  ).toMatchObject({ shortHash: "abcdef1" });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitFetch, { workspace: "project", remote: "origin" }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(bridge, req(MSG.gitPull, { workspace: "project" })),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitPush, {
        workspace: "project",
        setUpstream: true,
        remote: "origin",
      }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitCheckout, {
        workspace: "project",
        branch: "feature",
        create: true,
        startPoint: "main",
      }),
    ),
  ).toEqual({ ok: true });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitWorktreeCreate, {
        workspace: "project",
        workspaceName: "project-feature",
        branch: "feature",
        createBranch: true,
      }),
    ),
  ).toMatchObject({ workspace: { name: "project-feature" } });

  expect(calls.gitStage?.[0]).toEqual({
    workspace: "project",
    paths: ["a.ts"],
  });
  expect(calls.gitUntrack?.[0]).toEqual({
    workspace: "project",
    paths: ["a.ts"],
  });
  expect(calls.gitDiscard?.[0]).toEqual({
    workspace: "project",
    paths: ["a.ts"],
  });
  expect(calls.gitPush?.[0]).toEqual({
    workspace: "project",
    options: { setUpstream: true, remote: "origin" },
  });
  expect(calls.gitCheckout?.[0]).toEqual({
    workspace: "project",
    options: { branch: "feature", create: true, startPoint: "main" },
  });
  expect(
    await dispatch(
      bridge,
      req(MSG.gitWorktreeCreate, {
        workspace: "project",
        workspaceName: "escape",
        branch: "feature",
        path: "/tmp/escape",
      }),
    ),
  ).toEqual({
    error: {
      code: "invalid-payload",
      message: `${MSG.gitWorktreeCreate}: malformed payload`,
    },
  });
});

test("session.model.set returns the authoritative reconciled model", async () => {
  const { control } = makeFakeControl({
    setSessionModel: async () => ({
      current: "provider/fallback-model",
      applied: false,
    }),
  });
  const bridge = createControlBridge(control as never);

  expect(
    await dispatch(
      bridge,
      req(MSG.sessionModelSet, {
        chatKey: "relay:acct",
        sessionAlias: "a",
        modelId: "requested-model",
      }),
    ),
  ).toEqual({ ok: false, current: "provider/fallback-model" });
});

test("session effort get/set dispatch through the structured control methods", async () => {
  const calls: unknown[][] = [];
  const { control } = makeFakeControl({
    getSessionEffort: async (...args: unknown[]) => {
      calls.push(["get", ...args]);
      return { current: "medium", available: ["low", "medium", "high"] };
    },
    setSessionEffort: async (...args: unknown[]) => {
      calls.push(["set", ...args]);
      return { current: "high", applied: true };
    },
  });
  const bridge = createControlBridge(control as never);

  await expect(
    dispatch(
      bridge,
      req(MSG.sessionEffortGet, {
        chatKey: "relay:acct",
        sessionAlias: "a",
      }),
    ),
  ).resolves.toEqual({
    current: "medium",
    available: ["low", "medium", "high"],
  });
  await expect(
    dispatch(
      bridge,
      req(MSG.sessionEffortSet, {
        chatKey: "relay:acct",
        sessionAlias: "a",
        effort: "high",
      }),
    ),
  ).resolves.toEqual({ ok: true, current: "high" });
  expect(calls).toEqual([
    ["get", "relay:acct", "a"],
    ["set", "relay:acct", "a", "high"],
  ]);
});

test("session.model.set uses the earlier of the Hub deadline and connector work budget", async () => {
  const calls: unknown[][] = [];
  const { control } = makeFakeControl({
    setSessionModel: async (...args: unknown[]) => {
      calls.push(args);
      return { current: "model-b", applied: true };
    },
  });
  const bridge = createControlBridge(
    control as never,
    { now: () => 5_000 } as never,
  );
  const envelope = {
    ...req(MSG.sessionModelSet, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      modelId: "model-b",
    }),
    requestDeadlineAt: 120_000,
    requestBudgetMs: 105_000,
  } as RelayEnvelope;

  await dispatch(bridge, envelope);

  expect(calls).toEqual([
    ["relay:acct", "a", "model-b", { deadlineAt: 110_000 }],
  ]);
});

test("session.model.set delivery delay cannot consume the Hub response reserve", async () => {
  const calls: unknown[][] = [];
  const { control } = makeFakeControl({
    setSessionModel: async (...args: unknown[]) => {
      calls.push(args);
      return { current: "model-b", applied: true };
    },
  });
  // Hub H=0, timeout=45s and reserve=15s: both wire fields carry a 30s
  // work allowance. Delivery at t=20s must retain the absolute t=30s cutoff,
  // rather than restart a fresh 30s budget at the connector.
  const bridge = createControlBridge(
    control as never,
    { now: () => 20_000 } as never,
  );
  await dispatch(bridge, {
    ...req(MSG.sessionModelSet, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      modelId: "model-b",
    }),
    requestDeadlineAt: 30_000,
    requestBudgetMs: 30_000,
  });

  expect(calls[0]?.[3]).toEqual({ deadlineAt: 30_000 });
});

test("session.model.set fails closed when an older Hub omits its request deadline", async () => {
  const calls: unknown[][] = [];
  const { control } = makeFakeControl({
    setSessionModel: async (...args: unknown[]) => {
      calls.push(args);
      return { current: "model-b", applied: true };
    },
  });
  const bridge = createControlBridge(
    control as never,
    { now: () => 5_000 } as never,
  );

  await dispatch(
    bridge,
    req(MSG.sessionModelSet, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      modelId: "model-b",
    }),
  );

  expect(calls[0]?.[3]).toEqual({ deadlineAt: 5_000 });
});

test("session.model.set fails closed when either Hub deadline field is missing", async () => {
  const deadlines: unknown[] = [];
  const { control } = makeFakeControl({
    setSessionModel: async (...args: unknown[]) => {
      deadlines.push(args[3]);
      return { current: "model-b", applied: true };
    },
  });
  const bridge = createControlBridge(
    control as never,
    { now: () => 5_000 } as never,
  );
  const payload = {
    chatKey: "relay:acct",
    sessionAlias: "a",
    modelId: "model-b",
  };

  await dispatch(bridge, {
    ...req(MSG.sessionModelSet, payload),
    requestDeadlineAt: 100_000,
  });
  await dispatch(bridge, {
    ...req(MSG.sessionModelSet, payload),
    requestBudgetMs: 95_000,
  });

  expect(deadlines).toEqual([{ deadlineAt: 5_000 }, { deadlineAt: 5_000 }]);
});

test("sessions.native.list lists, and sessions.create forwards agentSessionId for native resume", async () => {
  const created: unknown[] = [];
  const { control } = makeFakeControl({
    listNativeSessions: async (
      _chatKey: string,
      _agent: string,
      _workspace: string,
    ) => [
      {
        sessionId: "ses_1",
        title: "Old",
        updatedAt: "2026-06-10T00:00:00Z",
        cwd: "/ws",
      },
    ],
    createSession: async (
      chatKey: string,
      alias: string,
      agent: string,
      workspace: string,
      agentSessionId?: string,
    ) => {
      created.push({ chatKey, alias, agent, workspace, agentSessionId });
      return { alias, agent, workspace, transportSession: "t", running: false };
    },
  });
  const bridge = createControlBridge(control as never);

  expect(
    await dispatch(
      bridge,
      req(MSG.sessionsNativeList, {
        chatKey: "relay:acct",
        agent: "codex",
        workspace: "backend",
      }),
    ),
  ).toEqual({
    sessions: [
      {
        sessionId: "ses_1",
        title: "Old",
        updatedAt: "2026-06-10T00:00:00Z",
        cwd: "/ws",
      },
    ],
  });

  await dispatch(
    bridge,
    req(MSG.sessionsCreate, {
      chatKey: "relay:acct",
      alias: "resumed",
      agent: "codex",
      workspace: "backend",
      agentSessionId: "ses_1",
    }),
  );
  expect(created).toEqual([
    {
      chatKey: "relay:acct",
      alias: "resumed",
      agent: "codex",
      workspace: "backend",
      agentSessionId: "ses_1",
    },
  ]);
});

test("agentMessageDeliver fails closed with ROUTE_UNAVAILABLE when deliverAgentMessage is not implemented", async () => {
  const { control } = makeFakeControl();
  const bridge = createControlBridge(control as never);

  const res = await dispatch(
    bridge,
    req(MSG.agentMessageDeliver, {
      sourceNodeId: "node_a",
      sourceEndpointId: "ep_a",
      targetEndpointId: "ep_b",
      messageId: "msg_123",
      content: "hello",
      requestedMode: "auto",
      replyable: true,
    }),
  );

  expect(res).toEqual({
    error: {
      code: "ROUTE_UNAVAILABLE",
      message:
        "Remote agent message delivery is not implemented in this connector runtime",
    },
  });
});

test("scheduled list/create map records to camelCase DTOs; executeAt parsed to Date", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(bridge, req(MSG.scheduledList, { chatKey: "relay:acct" })),
  ).toEqual({
    tasks: [
      {
        id: "ab12",
        sessionAlias: "a",
        executeAt: "2026-06-14T10:00:00.000Z",
        message: "m",
        status: "pending",
        createdAt: "2026-06-13T10:00:00.000Z",
      },
    ],
  });
  await dispatch(
    bridge,
    req(MSG.scheduledCreate, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      executeAt: "2026-06-14T10:00:00.000Z",
      message: "m",
    }),
  );
  const createInput = calls.createScheduledTask?.[0] as { executeAt: Date };
  expect(createInput.executeAt instanceof Date).toBe(true);
});

test("returns bad-request for an invalid executeAt on scheduled.create", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(
      bridge,
      req(MSG.scheduledCreate, {
        chatKey: "relay:acct",
        sessionAlias: "a",
        executeAt: "not-a-date",
        message: "m",
      }),
    ),
  ).toEqual({
    error: {
      code: "bad-request",
      message: "executeAt is not a valid ISO timestamp",
    },
  });
  expect(calls.createScheduledTask).toBeUndefined(); // never forwarded to the control service
});

test("agents.list / workspaces.list / workspaces.create dispatch and shape results", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.agentsList, {}))).toEqual({
    agents: [
      { name: "codex", driver: "codex" },
      { name: "claude", driver: "claude" },
    ],
  });
  expect(await dispatch(bridge, req(MSG.workspacesList, {}))).toEqual({
    workspaces: [{ name: "home", cwd: "/home", description: "h" }],
  });
  expect(
    await dispatch(
      bridge,
      req(MSG.workspacesCreate, {
        name: "backend",
        cwd: "/srv/backend",
        description: "api",
      }),
    ),
  ).toEqual({
    workspace: { name: "backend", cwd: "/srv/backend", description: "api" },
  });
  expect(calls.createWorkspace?.[0]).toEqual({
    name: "backend",
    cwd: "/srv/backend",
    description: "api",
  });
});

test("workspaces.create rejects missing name or cwd with bad-request", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(
      bridge,
      req(MSG.workspacesCreate, { name: "  ", cwd: "/x" }),
    ),
  ).toEqual({
    error: {
      code: "bad-request",
      message: "workspace name and cwd are required",
    },
  });
  expect(
    await dispatch(bridge, req(MSG.workspacesCreate, { name: "x", cwd: "" })),
  ).toEqual({
    error: {
      code: "bad-request",
      message: "workspace name and cwd are required",
    },
  });
  expect(calls.createWorkspace).toBeUndefined();
});

test("agents.catalog returns the control catalog", async () => {
  const { control } = makeFakeControl({
    listAgentCatalog: () => [
      { driver: "gemini", configured: false, installed: "unknown" },
    ],
  });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.agentsCatalog, {}))).toEqual({
    agents: [{ driver: "gemini", configured: false, installed: "unknown" }],
  });
});

test("agents.create requires name and driver", async () => {
  const { control } = makeFakeControl({
    createAgent: async (name: string, driver: string) => ({ name, driver }),
  });
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(
      bridge,
      req(MSG.agentsCreate, { name: "", driver: "gemini" }),
    ),
  ).toMatchObject({
    error: { code: "bad-request" },
  });
  expect(
    await dispatch(
      bridge,
      req(MSG.agentsCreate, { name: "gemini", driver: "gemini" }),
    ),
  ).toEqual({
    agent: { name: "gemini", driver: "gemini" },
  });
});

test("agents.remove and workspaces.remove return ok", async () => {
  const removed: string[] = [];
  const { control } = makeFakeControl({
    removeAgent: async (name: string) => {
      removed.push(`a:${name}`);
    },
    removeWorkspace: async (name: string) => {
      removed.push(`w:${name}`);
    },
  });
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(bridge, req(MSG.agentsRemove, { name: "gemini" })),
  ).toEqual({ ok: true });
  expect(
    await dispatch(bridge, req(MSG.workspacesRemove, { name: "ws1" })),
  ).toEqual({ ok: true });
  expect(removed).toEqual(["a:gemini", "w:ws1"]);
});

test("control.upload dispatches to uploadFile and returns UploadResult", async () => {
  const uploadResult = {
    id: "u1",
    path: "/tmp/u1.png",
    filename: "photo.png",
    mimeType: "image/png",
    size: 1024,
  };
  const { control } = makeFakeControl({
    uploadFile: async (input: unknown) => uploadResult,
  });
  const bridge = createControlBridge(control as never);

  // happy path: all fields present → returns UploadResult
  expect(
    await dispatch(
      bridge,
      req(MSG.upload, {
        filename: "photo.png",
        content: "abc123",
        mimeType: "image/png",
      }),
    ),
  ).toEqual(uploadResult);

  // missing mimeType fails wire-shape validation (mimeType is a required field) → invalid-payload
  expect(
    await dispatch(
      bridge,
      req(MSG.upload, { filename: "photo.png", content: "abc123" }),
    ),
  ).toEqual({
    error: {
      code: "invalid-payload",
      message: expect.stringContaining(MSG.upload),
    },
  });
});

test("sessions.rename dispatches to setSessionDisplayName and returns ok", async () => {
  const calls: unknown[] = [];
  const { control } = makeFakeControl({
    setSessionDisplayName: async (
      chatKey: string,
      alias: string,
      displayName: string,
    ) => {
      calls.push([chatKey, alias, displayName]);
    },
  });
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.sessionsRename, {
      chatKey: "relay:acc",
      alias: "backend",
      displayName: "My label",
    }),
  );
  expect(result).toEqual({ ok: true });
  expect(calls).toEqual([["relay:acc", "backend", "My label"]]);
});

test("fs.search passes advanced search options through to control.searchWorkspace", async () => {
  const calls: unknown[] = [];
  const { control } = makeFakeControl({
    searchWorkspace: async (workspace: string, opts: unknown) => {
      calls.push([workspace, opts]);
      return { workspace, query: "x", matches: [], hits: [], truncated: false };
    },
  });
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.fsSearch, {
      workspace: "w",
      query: "x",
      mode: "content",
      regex: true,
      include: "**/*.ts",
      exclude: "dist/**",
      path: "src",
      matchCase: true,
      wholeWord: true,
    }),
  );
  expect(result).toEqual({
    workspace: "w",
    query: "x",
    matches: [],
    hits: [],
    truncated: false,
  });
  expect(calls).toEqual([
    [
      "w",
      {
        query: "x",
        mode: "content",
        matchCase: true,
        wholeWord: true,
        regex: true,
        include: "**/*.ts",
        exclude: "dist/**",
        path: "src",
      },
    ],
  ]);
});

test("fs.search rejects a missing workspace (required wire field) as invalid-payload", async () => {
  const { control, calls } = makeFakeControl({
    searchWorkspace: async (workspace: string, opts: unknown) => {
      calls.searchWorkspace ??= [];
      calls.searchWorkspace.push([workspace, opts]);
      return { workspace, query: "x", matches: [], hits: [], truncated: false };
    },
  });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.fsSearch, { query: "x" }))).toEqual({
    error: {
      code: "invalid-payload",
      message: expect.stringContaining(MSG.fsSearch),
    },
  });
  expect(calls.searchWorkspace).toBeUndefined();
});

test("sessions.rename returns bad-request when alias is missing", async () => {
  const { control } = makeFakeControl({
    setSessionDisplayName: async () => {},
  });
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(
      bridge,
      req(MSG.sessionsRename, {
        chatKey: "relay:acc",
        alias: "",
        displayName: "x",
      }),
    ),
  ).toEqual({
    error: { code: "bad-request", message: "alias is required" },
  });
});

test("unknown type and thrown errors become error payloads", async () => {
  const { control } = makeFakeControl();
  const broken = {
    ...control,
    listSessions: () => {
      throw new Error("boom");
    },
  };
  const bridge = createControlBridge(broken as never);
  expect(await dispatch(bridge, req("control.nope", {}))).toEqual({
    error: {
      code: "unknown-type",
      message: "unsupported rpc type: control.nope",
    },
  });
  expect(
    await dispatch(bridge, req(MSG.sessionsList, { chatKey: "relay:acct" })),
  ).toEqual({ error: { code: "internal", message: "boom" } });
});

test("subscribeControlEvents forwards events and unsubscribes", () => {
  const { control, emit } = makeFakeControl();
  const sent: Array<{ type: string; payload: unknown }> = [];
  subscribeControlEvents(control as never, (type, payload) =>
    sent.push({ type, payload }),
  );
  emit({ type: "sessions-changed" });
  expect(sent).toEqual([
    {
      type: MSG.instanceEvent,
      payload: { event: { type: "sessions-changed" } },
    },
  ]);
});

test("scheduledTaskToDto maps snake_case record", () => {
  expect(
    scheduledTaskToDto({
      id: "i",
      chat_key: "k",
      session_alias: "s",
      execute_at: "e",
      message: "m",
      status: "pending",
      created_at: "c",
    } as never),
  ).toEqual({
    id: "i",
    sessionAlias: "s",
    executeAt: "e",
    message: "m",
    status: "pending",
    createdAt: "c",
  });
});

test("scheduledTaskToDto carries terminal-run fields so the web shows Done/Failed", () => {
  expect(
    scheduledTaskToDto({
      id: "i",
      chat_key: "k",
      session_alias: "s",
      execute_at: "e",
      message: "m",
      status: "failed",
      created_at: "c",
      executed_at: undefined,
      failed_at: "f",
      last_error: "boom",
    } as never),
  ).toEqual({
    id: "i",
    sessionAlias: "s",
    executeAt: "e",
    message: "m",
    status: "failed",
    createdAt: "c",
    failedAt: "f",
    lastError: "boom",
  });
  expect(
    scheduledTaskToDto({
      id: "i",
      chat_key: "k",
      session_alias: "s",
      execute_at: "e",
      message: "m",
      status: "executed",
      created_at: "c",
      executed_at: "x",
    } as never),
  ).toEqual({
    id: "i",
    sessionAlias: "s",
    executeAt: "e",
    message: "m",
    status: "executed",
    createdAt: "c",
    executedAt: "x",
  });
});

import { createControlEventBus } from "../../../../src/control/control-event-bus";

test("subscribeControlEvents maps native session-history into persisted-shaped wire rows", () => {
  const events = createControlEventBus();
  const sent: Array<{ type: string; payload: any }> = [];
  const control = { events } as never;
  const stop = subscribeControlEvents(control, (type, payload) =>
    sent.push({ type, payload }),
  );

  events.emit({
    type: "session-history",
    chatKey: "relay:a",
    sessionAlias: "backend",
    messages: [
      { role: "user", text: "summarize" },
      {
        role: "agent",
        text: "it's a CLI",
        parts: [
          { kind: "reasoning", text: "thinking" },
          {
            kind: "tool",
            tool: {
              toolCallId: "t1",
              toolName: "Read",
              kind: "read",
              status: "success",
              rawInput: { path: "a.ts" },
            },
          },
          { kind: "text", text: "it's a CLI" },
        ],
      },
    ],
  } as never);
  stop();

  const ev = sent[0]!.payload.event;
  expect(ev.type).toBe("session-history");
  expect(ev.sessionAlias).toBe("backend");
  expect(ev.messages[0]).toEqual({ direction: "in", text: "summarize" });
  const agent = ev.messages[1];
  expect(agent.direction).toBe("out");
  expect(agent.text).toBe("it's a CLI");
  expect(agent.structured.parts.map((p: any) => p.type)).toEqual([
    "reasoning",
    "tool",
    "text",
  ]);
  expect(agent.structured.toolSteps[0]).toMatchObject({
    toolCallId: "t1",
    kind: "read",
  });
  expect(agent.structured.reasoning).toBe("thinking");
});

test("subscribeControlEvents normalizes tool-event into a step DTO", () => {
  const events = createControlEventBus();
  const sent: Array<{ type: string; payload: any }> = [];
  const control = { events } as never;
  const stop = subscribeControlEvents(control, (type, payload) =>
    sent.push({ type, payload }),
  );

  events.emit({ type: "turn-started", chatKey: "c", sessionAlias: "s" });
  events.emit({
    type: "tool-event",
    chatKey: "c",
    sessionAlias: "s",
    event: {
      toolCallId: "t1",
      toolName: "Bash",
      kind: "execute",
      status: "success",
      rawInput: { command: "ls" },
    },
  });
  stop();

  expect(sent[0].payload.event).toEqual({
    type: "turn-started",
    chatKey: "c",
    sessionAlias: "s",
  });
  const tool = sent[1].payload.event;
  expect(tool.type).toBe("tool-event");
  expect(tool.step).toMatchObject({
    toolCallId: "t1",
    kind: "execute",
    title: "ls",
    detail: { type: "command", command: "ls" },
  });
  expect(tool.event).toBeUndefined();
});

test("terminal.attach RPC forwards to attachTerminal and returns its result", async () => {
  const { control } = makeFakeControl({
    attachTerminal: mock((id: string) => ({
      ok: true,
      buffer: "SCROLL",
      lastSeq: 3,
    })),
  });
  const bridge = createControlBridge(control as never);
  expect(
    await dispatch(bridge, req(MSG.terminalAttach, { terminalId: "t1" })),
  ).toEqual({ ok: true, buffer: "SCROLL", lastSeq: 3 });
  expect(
    (control.attachTerminal as ReturnType<typeof mock>).mock.calls[0],
  ).toEqual(["t1"]);
});

test("terminal.attach RPC without terminalId is rejected as invalid-payload (terminalId is a required wire field)", async () => {
  const { control } = makeFakeControl({
    attachTerminal: mock(() => ({ ok: false })),
  });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.terminalAttach, {}))).toEqual({
    error: {
      code: "invalid-payload",
      message: expect.stringContaining(MSG.terminalAttach),
    },
  });
  expect(
    (control.attachTerminal as ReturnType<typeof mock>).mock.calls.length,
  ).toBe(0);
});

test("boundary A: malformed fsWrite is rejected and never touches the filesystem", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  // missing `content` and `expected` → invalid shape
  const result = await dispatch(
    bridge,
    req(MSG.fsWrite, { workspace: "home", path: "a.txt" }),
  );
  expect(result).toEqual({
    error: {
      code: "invalid-payload",
      message: expect.stringContaining(MSG.fsWrite),
    },
  });
  expect(calls.fsWrite).toBeUndefined();
});

test("boundary A: malformed prompt is rejected and control.prompt is never called", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.prompt, {
      chatKey: "relay:a1",
      sessionAlias: "s" /* no text/senderId */,
    }),
  );
  expect(result).toEqual({
    error: {
      code: "invalid-payload",
      message: expect.stringContaining(MSG.prompt),
    },
  });
  expect(calls.prompt).toBeUndefined();
});

test("boundary A: a well-formed prompt still dispatches to control.prompt", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  const result = await dispatch(
    bridge,
    req(MSG.prompt, {
      chatKey: "relay:a1",
      sessionAlias: "s",
      text: "hi",
      senderId: "u",
    }),
  );
  expect(result).toEqual({ ok: true, text: "done" });
  expect(calls.prompt?.length).toBe(1);
});

// ── connector-side RPC dispatch timeout ──────────────────────────────────────

type ArmedTimer = { fn: () => void; ms: number };

function makeTimerSeams() {
  const armed: ArmedTimer[] = [];
  const cleared: unknown[] = [];
  return {
    armed,
    cleared,
    setTimeoutFn: (fn: () => void, ms: number) => {
      const timer = { fn, ms };
      armed.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer: unknown) => {
      cleared.push(timer);
    },
  };
}

test("a hung control call responds with a timeout errorPayload instead of hanging the hub pending entry", async () => {
  const seams = makeTimerSeams();
  const { control } = makeFakeControl({
    // Never settles — equivalent to a wedged transport underneath the control API.
    removeSession: () => new Promise(() => {}),
  });
  const bridge = createControlBridge(control as never, seams);

  const responses: unknown[] = [];
  bridge(
    req(MSG.sessionsRemove, { chatKey: "relay:acct", alias: "a" }),
    (payload) => responses.push(payload),
  );

  expect(seams.armed).toHaveLength(1);
  expect(seams.armed[0]!.ms).toBe(60_000);

  seams.armed[0]!.fn();
  expect(responses).toEqual([
    {
      error: {
        code: "timeout",
        message: `rpc ${MSG.sessionsRemove} timed out after 60000ms in the connector`,
      },
    },
  ]);
});

test("core-bounded / long RPC types are exempt from the connector timeout", async () => {
  const seams = makeTimerSeams();
  const { control } = makeFakeControl({
    // Each of these wraps a core operation with its own ceiling (session-init
    // 120s) or is prompt-like; a connector timeout would preempt legit slow
    // work without cancelling it. The hub's 120s request timeout is the backstop.
    createSession: () => new Promise(() => {}),
    listNativeSessions: () => new Promise(() => {}),
    executeCommand: () => new Promise(() => {}),
    setSessionModel: () => new Promise(() => {}),
    setSessionEffort: () => new Promise(() => {}),
  });
  const bridge = createControlBridge(control as never, seams);

  bridge(
    req(MSG.sessionsCreate, {
      chatKey: "relay:acct",
      alias: "a",
      agent: "codex",
      workspace: "ws",
    }),
    () => {},
  );
  bridge(
    req(MSG.sessionsNativeList, {
      chatKey: "relay:acct",
      agent: "codex",
      workspace: "ws",
    }),
    () => {},
  );
  bridge(
    req(MSG.commandExecute, { chatKey: "relay:acct", command: "/status" }),
    () => {},
  );
  bridge(
    req(MSG.sessionModelSet, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      modelId: "model-b",
    }),
    () => {},
  );
  bridge(
    req(MSG.sessionEffortSet, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      effort: "high",
    }),
    () => {},
  );

  // No timer armed for any exempt type.
  expect(seams.armed).toHaveLength(0);
});

test("session archive is bounded by the default connector timeout (core-bounded at 30s)", async () => {
  const seams = makeTimerSeams();
  const { control } = makeFakeControl({
    archiveSession: () => new Promise(() => {}),
  });
  const bridge = createControlBridge(control as never, seams);

  bridge(
    req(MSG.sessionsArchive, { chatKey: "relay:acct", alias: "a" }),
    () => {},
  );

  expect(seams.armed.map((timer) => timer.ms)).toEqual([60_000]);
});

test("prompt dispatch is never bounded by the connector timeout (interactive turn)", async () => {
  const seams = makeTimerSeams();
  const { control } = makeFakeControl();
  const bridge = createControlBridge(control as never, seams);

  const result = await dispatch(
    bridge,
    req(MSG.prompt, {
      chatKey: "relay:acct",
      sessionAlias: "a",
      text: "hi",
      senderId: "acct",
      isOwner: true,
    }),
  );

  expect(result).toEqual({ ok: true, text: "done" });
  expect(seams.armed).toHaveLength(0);
});

test("a dispatch that resolves in time clears its timer and a late timeout fire is a no-op", async () => {
  const seams = makeTimerSeams();
  const { control } = makeFakeControl();
  const bridge = createControlBridge(control as never, seams);

  const responses: unknown[] = [];
  await new Promise((resolve) =>
    bridge(req(MSG.sessionsList, {}), (payload) => {
      responses.push(payload);
      resolve(undefined);
    }),
  );

  expect(seams.cleared).toEqual([seams.armed[0]]);
  // Even if the timer somehow fired afterwards, respond must not run twice.
  seams.armed[0]!.fn();
  expect(responses).toHaveLength(1);
});

test("a late resolution after the timeout fired does not respond a second time", async () => {
  const seams = makeTimerSeams();
  let settle: ((value: unknown) => void) | undefined;
  const { control } = makeFakeControl({
    removeSession: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  const bridge = createControlBridge(control as never, seams);

  const responses: unknown[] = [];
  bridge(
    req(MSG.sessionsRemove, { chatKey: "relay:acct", alias: "a" }),
    (payload) => responses.push(payload),
  );

  seams.armed[0]!.fn();
  settle!({ wasActive: false });
  // Let the .then(respondOnce) microtask run.
  await Promise.resolve();
  await Promise.resolve();

  expect(responses).toHaveLength(1);
  expect((responses[0] as { error: { code: string } }).error.code).toBe(
    "timeout",
  );
});

test("custom timeout value overrides the default for bounded RPCs", async () => {
  const seams = makeTimerSeams();
  const { control } = makeFakeControl({
    removeSession: () => new Promise(() => {}),
    archiveSession: () => new Promise(() => {}),
  });
  const bridge = createControlBridge(control as never, {
    ...seams,
    timeoutMs: 1_000,
  });

  bridge(
    req(MSG.sessionsRemove, { chatKey: "relay:acct", alias: "a" }),
    () => {},
  );
  bridge(
    req(MSG.sessionsArchive, { chatKey: "relay:acct", alias: "a" }),
    () => {},
  );

  expect(seams.armed.map((timer) => timer.ms)).toEqual([1_000, 1_000]);
});
