import { expect, test, mock } from "bun:test";

import { MSG, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "../../../../packages/relay-protocol/src/index";
import {
  createControlBridge,
  scheduledTaskToDto,
  subscribeControlEvents,
} from "../../../../packages/channel-relay/src/control-bridge";

const req = (type: string, payload: unknown): RelayEnvelope => ({
  protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "r-1", type, payload,
});

function makeFakeControl(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => { (calls[name] ??= []).push(args); };
  const listeners: Array<(event: unknown) => void> = [];
  const control = {
    listSessions: () => [{ alias: "a", agent: "claude", workspace: "/ws", transportSession: "t", running: false }],
    createSession: async (alias: string, agent: string, workspace: string) => {
      record("createSession", { alias, agent, workspace });
      return { alias, agent, workspace, transportSession: "t", running: false };
    },
    removeSession: async (alias: string) => { record("removeSession", alias); return { wasActive: false }; },
    listAgents: () => [{ name: "codex", driver: "codex" }, { name: "claude", driver: "claude" }],
    listWorkspaces: () => [{ name: "home", cwd: "/home", description: "h" }],
    createWorkspace: async (name: string, cwd: string, description?: string) => {
      record("createWorkspace", { name, cwd, description });
      return { name, cwd, ...(description ? { description } : {}) };
    },
    prompt: async (input: unknown) => { record("prompt", input); return { ok: true, text: "done" }; },
    cancelTurn: (chatKey: string, alias: string) => { record("cancelTurn", { chatKey, alias }); return true; },
    cancelQueuedItem: (chatKey: string, alias: string, itemId: string) => {
      record("cancelQueuedItem", { chatKey, alias, itemId });
      return { cancelled: true };
    },
    executeCommand: async (input: unknown) => { record("executeCommand", input); return "output"; },
    listScheduledTasks: (chatKey: string) => [{
      id: "ab12", chat_key: chatKey, session_alias: "a",
      execute_at: "2026-06-14T10:00:00.000Z", message: "m", status: "pending", created_at: "2026-06-13T10:00:00.000Z",
    }],
    createScheduledTask: async (input: { chatKey: string; executeAt: Date }) => {
      record("createScheduledTask", input);
      return {
        id: "cd34", chat_key: input.chatKey, session_alias: "a",
        execute_at: input.executeAt.toISOString(), message: "m", status: "pending", created_at: "2026-06-13T10:00:00.000Z",
      };
    },
    cancelScheduledTask: async () => true,
    listOrchestrationTasks: async () => [{
      taskId: "t1", status: "running", targetAgent: "claude", workspace: "/ws",
      task: "do", summary: "s", createdAt: "x", updatedAt: "y",
      sourceHandle: "h", sourceKind: "human", coordinatorSession: "c", resultText: "",
    }],
    getOrchestrationTask: async () => null,
    cancelOrchestrationTask: async () => ({
      taskId: "t1", status: "cancelled", targetAgent: "claude", workspace: "/ws",
      task: "do", summary: "s", createdAt: "x", updatedAt: "y",
      sourceHandle: "h", sourceKind: "human", coordinatorSession: "c", resultText: "",
    }),
    events: { subscribe: (listener: (event: unknown) => void) => { listeners.push(listener); return () => {}; } },
    ...overrides,
  };
  return { control, calls, emit: (event: unknown) => listeners.forEach((l) => l(event)) };
}

async function dispatch(bridge: ReturnType<typeof createControlBridge>, envelope: RelayEnvelope): Promise<unknown> {
  return await new Promise((resolve) => bridge(envelope, resolve));
}

test("sessions.list / prompt / command.execute dispatch and shape results", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.sessionsList, {}))).toEqual({
    sessions: [{ alias: "a", agent: "claude", workspace: "/ws", transportSession: "t", running: false }],
  });
  const promptResult = await dispatch(bridge, req(MSG.prompt, {
    chatKey: "relay:acct", sessionAlias: "a", text: "hi", senderId: "acct", isOwner: true,
  }));
  expect(promptResult).toEqual({ ok: true, text: "done" });
  expect(calls.prompt?.[0]).toEqual({ chatKey: "relay:acct", sessionAlias: "a", text: "hi", senderId: "acct", isOwner: true });
  expect(await dispatch(bridge, req(MSG.commandExecute, { chatKey: "k", text: "/status", senderId: "acct" }))).toEqual({ output: "output" });
});

test("queue.cancel dispatches to cancelQueuedItem and returns its result", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  const result = await dispatch(bridge, req(MSG.queueCancel, { chatKey: "relay:acct", sessionAlias: "a", itemId: "q1" }));
  expect(result).toEqual({ cancelled: true });
  expect(calls.cancelQueuedItem?.[0]).toEqual({ chatKey: "relay:acct", alias: "a", itemId: "q1" });
});

test("sessions.native.list lists, and sessions.create forwards agentSessionId for native resume", async () => {
  const created: unknown[] = [];
  const { control } = makeFakeControl({
    listNativeSessions: async (_chatKey: string, _agent: string, _workspace: string) =>
      [{ sessionId: "ses_1", title: "Old", updatedAt: "2026-06-10T00:00:00Z", cwd: "/ws" }],
    createSession: async (chatKey: string, alias: string, agent: string, workspace: string, agentSessionId?: string) => {
      created.push({ chatKey, alias, agent, workspace, agentSessionId });
      return { alias, agent, workspace, transportSession: "t", running: false };
    },
  });
  const bridge = createControlBridge(control as never);

  expect(await dispatch(bridge, req(MSG.sessionsNativeList, { chatKey: "relay:acct", agent: "codex", workspace: "backend" }))).toEqual({
    sessions: [{ sessionId: "ses_1", title: "Old", updatedAt: "2026-06-10T00:00:00Z", cwd: "/ws" }],
  });

  await dispatch(bridge, req(MSG.sessionsCreate, { chatKey: "relay:acct", alias: "resumed", agent: "codex", workspace: "backend", agentSessionId: "ses_1" }));
  expect(created).toEqual([{ chatKey: "relay:acct", alias: "resumed", agent: "codex", workspace: "backend", agentSessionId: "ses_1" }]);
});

test("scheduled list/create map records to camelCase DTOs; executeAt parsed to Date", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.scheduledList, { chatKey: "relay:acct" }))).toEqual({
    tasks: [{ id: "ab12", sessionAlias: "a", executeAt: "2026-06-14T10:00:00.000Z", message: "m", status: "pending", createdAt: "2026-06-13T10:00:00.000Z" }],
  });
  await dispatch(bridge, req(MSG.scheduledCreate, {
    chatKey: "relay:acct", sessionAlias: "a", executeAt: "2026-06-14T10:00:00.000Z", message: "m",
  }));
  const createInput = calls.createScheduledTask?.[0] as { executeAt: Date };
  expect(createInput.executeAt instanceof Date).toBe(true);
});

test("returns bad-request for an invalid executeAt on scheduled.create", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.scheduledCreate, {
    chatKey: "relay:acct", sessionAlias: "a", executeAt: "not-a-date", message: "m",
  }))).toEqual({ error: { code: "bad-request", message: "executeAt is not a valid ISO timestamp" } });
  expect(calls.createScheduledTask).toBeUndefined(); // never forwarded to the control service
});

test("agents.list / workspaces.list / workspaces.create dispatch and shape results", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.agentsList, {}))).toEqual({
    agents: [{ name: "codex", driver: "codex" }, { name: "claude", driver: "claude" }],
  });
  expect(await dispatch(bridge, req(MSG.workspacesList, {}))).toEqual({
    workspaces: [{ name: "home", cwd: "/home", description: "h" }],
  });
  expect(await dispatch(bridge, req(MSG.workspacesCreate, { name: "backend", cwd: "/srv/backend", description: "api" }))).toEqual({
    workspace: { name: "backend", cwd: "/srv/backend", description: "api" },
  });
  expect(calls.createWorkspace?.[0]).toEqual({ name: "backend", cwd: "/srv/backend", description: "api" });
});

test("workspaces.create rejects missing name or cwd with bad-request", async () => {
  const { control, calls } = makeFakeControl();
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.workspacesCreate, { name: "  ", cwd: "/x" }))).toEqual({
    error: { code: "bad-request", message: "workspace name and cwd are required" },
  });
  expect(await dispatch(bridge, req(MSG.workspacesCreate, { name: "x", cwd: "" }))).toEqual({
    error: { code: "bad-request", message: "workspace name and cwd are required" },
  });
  expect(calls.createWorkspace).toBeUndefined();
});

test("agents.catalog returns the control catalog", async () => {
  const { control } = makeFakeControl({
    listAgentCatalog: () => [{ driver: "gemini", configured: false, installed: "unknown" }],
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
  expect(await dispatch(bridge, req(MSG.agentsCreate, { name: "", driver: "gemini" }))).toMatchObject({
    error: { code: "bad-request" },
  });
  expect(await dispatch(bridge, req(MSG.agentsCreate, { name: "gemini", driver: "gemini" }))).toEqual({
    agent: { name: "gemini", driver: "gemini" },
  });
});

test("agents.remove and workspaces.remove return ok", async () => {
  const removed: string[] = [];
  const { control } = makeFakeControl({
    removeAgent: async (name: string) => { removed.push(`a:${name}`); },
    removeWorkspace: async (name: string) => { removed.push(`w:${name}`); },
  });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.agentsRemove, { name: "gemini" }))).toEqual({ ok: true });
  expect(await dispatch(bridge, req(MSG.workspacesRemove, { name: "ws1" }))).toEqual({ ok: true });
  expect(removed).toEqual(["a:gemini", "w:ws1"]);
});

test("control.upload dispatches to uploadFile and returns UploadResult", async () => {
  const uploadResult = { id: "u1", path: "/tmp/u1.png", filename: "photo.png", mimeType: "image/png", size: 1024 };
  const { control } = makeFakeControl({
    uploadFile: async (input: unknown) => uploadResult,
  });
  const bridge = createControlBridge(control as never);

  // happy path: all fields present → returns UploadResult
  expect(await dispatch(bridge, req(MSG.upload, { filename: "photo.png", content: "abc123", mimeType: "image/png" }))).toEqual(uploadResult);

  // bad-request: missing mimeType
  expect(await dispatch(bridge, req(MSG.upload, { filename: "photo.png", content: "abc123" }))).toEqual({
    error: { code: "bad-request", message: "filename, content and mimeType are required" },
  });
});

test("sessions.rename dispatches to setSessionDisplayName and returns ok", async () => {
  const calls: unknown[] = [];
  const { control } = makeFakeControl({
    setSessionDisplayName: async (chatKey: string, alias: string, displayName: string) => {
      calls.push([chatKey, alias, displayName]);
    },
  });
  const bridge = createControlBridge(control as never);
  const result = await dispatch(bridge, req(MSG.sessionsRename, { chatKey: "relay:acc", alias: "backend", displayName: "My label" }));
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
  const result = await dispatch(bridge, req(MSG.fsSearch, {
    workspace: "w", query: "x", mode: "content", regex: true,
    include: "**/*.ts", exclude: "dist/**", path: "src", matchCase: true, wholeWord: true,
  }));
  expect(result).toEqual({ workspace: "w", query: "x", matches: [], hits: [], truncated: false });
  expect(calls).toEqual([["w", {
    query: "x", mode: "content", matchCase: true, wholeWord: true, regex: true,
    include: "**/*.ts", exclude: "dist/**", path: "src",
  }]]);
});

test("fs.search returns bad-request when workspace is missing", async () => {
  const { control, calls } = makeFakeControl({
    searchWorkspace: async (workspace: string, opts: unknown) => {
      calls.searchWorkspace ??= [];
      calls.searchWorkspace.push([workspace, opts]);
      return { workspace, query: "x", matches: [], hits: [], truncated: false };
    },
  });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.fsSearch, { query: "x" }))).toEqual({
    error: { code: "bad-request", message: "workspace is required" },
  });
  expect(calls.searchWorkspace).toBeUndefined();
});

test("sessions.rename returns bad-request when alias is missing", async () => {
  const { control } = makeFakeControl({
    setSessionDisplayName: async () => {},
  });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.sessionsRename, { chatKey: "relay:acc", alias: "", displayName: "x" }))).toEqual({
    error: { code: "bad-request", message: "alias is required" },
  });
});

test("unknown type and thrown errors become error payloads", async () => {
  const { control } = makeFakeControl();
  const broken = { ...control, listSessions: () => { throw new Error("boom"); } };
  const bridge = createControlBridge(broken as never);
  expect(await dispatch(bridge, req("control.nope", {}))).toEqual({ error: { code: "unknown-type", message: "unsupported rpc type: control.nope" } });
  expect(await dispatch(bridge, req(MSG.sessionsList, {}))).toEqual({ error: { code: "internal", message: "boom" } });
});

test("subscribeControlEvents forwards events and unsubscribes", () => {
  const { control, emit } = makeFakeControl();
  const sent: Array<{ type: string; payload: unknown }> = [];
  subscribeControlEvents(control as never, (type, payload) => sent.push({ type, payload }));
  emit({ type: "sessions-changed" });
  expect(sent).toEqual([{ type: MSG.instanceEvent, payload: { event: { type: "sessions-changed" } } }]);
});

test("scheduledTaskToDto maps snake_case record", () => {
  expect(scheduledTaskToDto({
    id: "i", chat_key: "k", session_alias: "s", execute_at: "e", message: "m", status: "pending", created_at: "c",
  } as never)).toEqual({ id: "i", sessionAlias: "s", executeAt: "e", message: "m", status: "pending", createdAt: "c" });
});

test("scheduledTaskToDto carries terminal-run fields so the web shows Done/Failed", () => {
  expect(scheduledTaskToDto({
    id: "i", chat_key: "k", session_alias: "s", execute_at: "e", message: "m", status: "failed", created_at: "c",
    executed_at: undefined, failed_at: "f", last_error: "boom",
  } as never)).toEqual({ id: "i", sessionAlias: "s", executeAt: "e", message: "m", status: "failed", createdAt: "c", failedAt: "f", lastError: "boom" });
  expect(scheduledTaskToDto({
    id: "i", chat_key: "k", session_alias: "s", execute_at: "e", message: "m", status: "executed", created_at: "c",
    executed_at: "x",
  } as never)).toEqual({ id: "i", sessionAlias: "s", executeAt: "e", message: "m", status: "executed", createdAt: "c", executedAt: "x" });
});

import { createControlEventBus } from "../../../../src/control/control-event-bus";

test("subscribeControlEvents maps native session-history into persisted-shaped wire rows", () => {
  const events = createControlEventBus();
  const sent: Array<{ type: string; payload: any }> = [];
  const control = { events } as never;
  const stop = subscribeControlEvents(control, (type, payload) => sent.push({ type, payload }));

  events.emit({
    type: "session-history", chatKey: "relay:a", sessionAlias: "backend",
    messages: [
      { role: "user", text: "summarize" },
      {
        role: "agent", text: "it's a CLI",
        parts: [
          { kind: "reasoning", text: "thinking" },
          { kind: "tool", tool: { toolCallId: "t1", toolName: "Read", kind: "read", status: "success", rawInput: { path: "a.ts" } } },
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
  expect(agent.structured.parts.map((p: any) => p.type)).toEqual(["reasoning", "tool", "text"]);
  expect(agent.structured.toolSteps[0]).toMatchObject({ toolCallId: "t1", kind: "read" });
  expect(agent.structured.reasoning).toBe("thinking");
});

test("subscribeControlEvents normalizes tool-event into a step DTO", () => {
  const events = createControlEventBus();
  const sent: Array<{ type: string; payload: any }> = [];
  const control = { events } as never;
  const stop = subscribeControlEvents(control, (type, payload) => sent.push({ type, payload }));

  events.emit({ type: "turn-started", chatKey: "c", sessionAlias: "s" });
  events.emit({
    type: "tool-event", chatKey: "c", sessionAlias: "s",
    event: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", rawInput: { command: "ls" } },
  });
  stop();

  expect(sent[0].payload.event).toEqual({ type: "turn-started", chatKey: "c", sessionAlias: "s" });
  const tool = sent[1].payload.event;
  expect(tool.type).toBe("tool-event");
  expect(tool.step).toMatchObject({ toolCallId: "t1", kind: "execute", title: "ls", detail: { type: "command", command: "ls" } });
  expect(tool.event).toBeUndefined();
});

test("terminal.attach RPC forwards to attachTerminal and returns its result", async () => {
  const { control } = makeFakeControl({ attachTerminal: mock((id: string) => ({ ok: true, buffer: "SCROLL", lastSeq: 3 })) });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.terminalAttach, { terminalId: "t1" }))).toEqual({ ok: true, buffer: "SCROLL", lastSeq: 3 });
  expect((control.attachTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1"]);
});

test("terminal.attach RPC without terminalId returns bad-request", async () => {
  const { control } = makeFakeControl({ attachTerminal: mock(() => ({ ok: false })) });
  const bridge = createControlBridge(control as never);
  expect(await dispatch(bridge, req(MSG.terminalAttach, {}))).toEqual({ error: { code: "bad-request", message: "terminalId is required" } });
});
