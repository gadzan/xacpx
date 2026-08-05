import { expect, mock, test, beforeEach, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { homedir, tmpdir } from "node:os";

import { buildApp as buildAppRaw, resolveRuntimePaths } from "../../src/main";
import { coreHomeDir } from "../../src/runtime/core-home";
import { sameWorkspacePath } from "../../src/commands/workspace-path";
import { setLocale } from "../../src/i18n";

beforeEach(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

type BuildAppArgs = Parameters<typeof buildAppRaw>;
// Never touch the real ~/.acpx/config.json from unit tests: the overlay
// provisioner runs against the real home dir by design.
const buildApp = (paths: BuildAppArgs[0], deps: BuildAppArgs[1] = {}): ReturnType<typeof buildAppRaw> =>
  buildAppRaw(paths, {
    stateSaveDebounceMs: 0,
    provisionAgentOverlays: async () => ({ outcomes: {}, raced: false }),
    ...deps,
  });

async function readJsonWithRetry<T>(path: string, attempts = 5): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "failed to read json"));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("builds the runtime services from config and state paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  await expect(buildApp({ configPath, statePath })).resolves.toMatchObject({
    agent: expect.anything(),
    router: expect.anything(),
    sessions: expect.anything(),
    stateStore: expect.anything(),
    configStore: expect.anything(),
    orchestration: expect.anything(),
  });

  await rm(dir, { recursive: true, force: true });
});



test("buildApp exposes orchestration IPC runtime state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    {
      configPath,
      statePath,
      orchestrationSocketPath: join(dir, "runtime", "orchestration.sock"),
    },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  expect(runtime.orchestration.endpoint.path).toBe(join(dir, "runtime", "orchestration.sock"));
  expect(runtime.orchestration.server).toBeDefined();

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("external coordinator delegation sees agents added after daemon startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const prompt = mock(async () => ({ text: "review ok" }));

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  await runtime.orchestration.service.registerExternalCoordinator({
    coordinatorSession: "external:codex",
    workspace: "backend",
  });

  await writeFile(
    configPath,
    JSON.stringify({
      // preferLocalAgents:false keeps agentCommand resolution deterministic across
      // hosts — without it, a machine with the `opencode` CLI installed resolves to
      // "opencode acp" and the agentCommand:undefined assertions below fail (passes
      // in CI, fails locally).
      transport: { type: "acpx-cli", command: "acpx", preferLocalAgents: false },
      agents: {
        codex: { driver: "codex" },
        opencode: { driver: "opencode" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const result = await runtime.orchestration.service.requestDelegate({
    sourceHandle: "external:codex",
    targetAgent: "opencode",
    task: "review recent commits",
    cwd: "/tmp/backend",
  });

  expect(result.status).toBe("running");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const task = await runtime.orchestration.service.getTask(result.taskId);
    if (task?.status === "completed") {
      break;
    }
    await Bun.sleep(10);
  }

  expect(await runtime.orchestration.service.getTask(result.taskId)).toMatchObject({
    status: "completed",
    targetAgent: "opencode",
    resultText: "review ok",
  });
  expect(ensureSession.mock.calls.at(0)?.[0]).toMatchObject({
    agent: "opencode",
    agentCommand: undefined,
  });
  expect(prompt.mock.calls.at(0)?.[0]).toMatchObject({
    agent: "opencode",
    agentCommand: undefined,
  });
  expect(sameWorkspacePath(ensureSession.mock.calls.at(0)?.[0]?.cwd, "/tmp/backend")).toBe(true);
  expect(sameWorkspacePath(prompt.mock.calls.at(0)?.[0]?.cwd, "/tmp/backend")).toBe(true);

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp keeps session and orchestration mutations on the same runtime state object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  await runtime.orchestration.service.registerExternalCoordinator({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });

  await expect(
    runtime.sessions.attachSession("backend", "codex", "backend", "codex:backend"),
  ).rejects.toThrow('transport session "codex:backend" conflicts with an external coordinator');

  const saved = await readJsonWithRetry<{
    orchestration: { externalCoordinators: Record<string, unknown> };
  }>(statePath);
  expect(saved.orchestration.externalCoordinators["codex:backend"]).toMatchObject({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp serializes external coordinator registration against logical session creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  const originalSave = runtime.stateStore.save.bind(runtime.stateStore);
  const saveStarted = createDeferred<void>();
  const releaseSave = createDeferred<void>();
  let delayedExternalSave = false;
  runtime.stateStore.save = async (nextState) => {
    if (!delayedExternalSave && nextState.orchestration.externalCoordinators["codex:backend"]) {
      delayedExternalSave = true;
      saveStarted.resolve();
      await releaseSave.promise;
    }
    await originalSave(nextState);
  };

  const registerPromise = runtime.orchestration.service.registerExternalCoordinator({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });
  await saveStarted.promise;

  const attachPromise = runtime.sessions
    .attachSession("backend", "codex", "backend", "codex:backend")
    .then(
      () => undefined,
      (error) => error,
    );
  await Bun.sleep(10);
  releaseSave.resolve();

  await expect(registerPromise).resolves.toMatchObject({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });
  const attachError = await attachPromise;
  expect(attachError).toBeInstanceOf(Error);
  expect((attachError as Error).message).toBe(
    'transport session "codex:backend" conflicts with an external coordinator',
  );

  const saved = await readJsonWithRetry<{
    sessions: Record<string, unknown>;
    orchestration: { externalCoordinators: Record<string, unknown> };
  }>(statePath);
  expect(saved.sessions).toEqual({});
  expect(saved.orchestration.externalCoordinators["codex:backend"]).toMatchObject({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp reserves logical session transport before session creation side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureStarted = createDeferred<void>();
  const releaseEnsure = createDeferred<void>();

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {
          ensureStarted.resolve();
          await releaseEnsure.promise;
        },
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  const createPromise = runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await ensureStarted.promise;
  const registerPromise = runtime.orchestration.service
    .registerExternalCoordinator({
      coordinatorSession: "backend:main",
      workspace: "backend",
    })
    .then(
      () => undefined,
      (error) => error,
    );
  await Bun.sleep(10);
  releaseEnsure.resolve();

  await expect(createPromise).resolves.toMatchObject({ text: "会话「main」已创建并切换" });
  const registerError = await registerPromise;
  expect(registerError).toBeInstanceOf(Error);
  expect((registerError as Error).message).toBe(
    'coordinatorSession "backend:main" conflicts with an existing logical session',
  );

  const saved = await readJsonWithRetry<{
    sessions: Record<string, unknown>;
    orchestration: { externalCoordinators: Record<string, unknown> };
  }>(statePath);
  expect((saved.sessions.main as { transport_session?: string }).transport_session).toMatch(
    /^backend:main:reset-\d+$/,
  );
  expect(saved.orchestration.externalCoordinators).toEqual({});
  await expect(
    runtime.orchestration.service.registerExternalCoordinator({
      coordinatorSession: "backend:main",
      workspace: "backend",
    }),
  ).rejects.toThrow('coordinatorSession "backend:main" conflicts with an existing logical session');

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp reserves attached logical session transport before attach side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const checkStarted = createDeferred<void>();
  const releaseCheck = createDeferred<void>();

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async (session) => {
          if (session.transportSession === "codex:backend") {
            checkStarted.resolve();
            await releaseCheck.promise;
          }
          return true;
        },
        listSessions: async () => [],
      }),
    },
  );

  const attachPromise = runtime.router.handle(
    "wx:user",
    "/session attach attached --agent codex --ws backend --name codex:backend",
  );
  await checkStarted.promise;
  const registerPromise = runtime.orchestration.service
    .registerExternalCoordinator({
      coordinatorSession: "codex:backend",
      workspace: "backend",
    })
    .then(
      () => undefined,
      (error) => error,
    );
  await Bun.sleep(10);
  releaseCheck.resolve();

  await expect(attachPromise).resolves.toMatchObject({ text: "会话「attached」已绑定并切换" });
  const registerError = await registerPromise;
  expect(registerError).toBeInstanceOf(Error);
  expect((registerError as Error).message).toBe(
    'coordinatorSession "codex:backend" conflicts with an existing logical session',
  );

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp reserves reset logical session transport before reset side effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureStarted = createDeferred<void>();
  const releaseEnsure = createDeferred<void>();
  let resetTransportSession = "";

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async (session) => {
          if (session.transportSession.includes(":reset-")) {
            resetTransportSession = session.transportSession;
            ensureStarted.resolve();
            await releaseEnsure.promise;
          }
        },
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );
  await runtime.sessions.attachSession("main", "codex", "backend", "backend:main");
  await runtime.sessions.useSession("wx:user", "main");

  const resetPromise = runtime.router.handle("wx:user", "/session reset");
  await ensureStarted.promise;
  const registerPromise = runtime.orchestration.service
    .registerExternalCoordinator({
      coordinatorSession: resetTransportSession,
      workspace: "backend",
    })
    .then(
      () => undefined,
      (error) => error,
    );
  await Bun.sleep(10);
  releaseEnsure.resolve();

  await expect(resetPromise).resolves.toMatchObject({ text: "会话「main」已重置" });
  const registerError = await registerPromise;
  expect(registerError).toBeInstanceOf(Error);
  expect((registerError as Error).message).toBe(
    `coordinatorSession "${resetTransportSession}" conflicts with an existing logical session`,
  );

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("wires orchestration into the runtime router so /delegate creates and persists a task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const workerPrompt = createDeferred<{ text: string }>();
  const prompt = mock(async (session) => {
    if (session.alias === "backend:claude:backend:main") {
      return await workerPrompt.promise;
    }
    return { text: "coordinator wake ok" };
  });
  const hasSession = mock(async () => true);

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession,
      }),
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await runtime.router.handle("wx:user", "/delegate claude review the change");

  expect(reply.text).toContain("已创建委派任务");
  expect(ensureSession.mock.calls).toHaveLength(2);
  expect(ensureSession.mock.calls.at(0)?.[0]).toMatchObject({
    alias: "main",
    agent: "codex",
    workspace: "backend",
  });
  const coordinatorTransportSession = ensureSession.mock.calls.at(0)?.[0].transportSession;
  expect(coordinatorTransportSession).toMatch(/^backend:main:reset-\d+$/);
  expect(ensureSession.mock.calls.at(1)?.[0]).toMatchObject({
    alias: "backend:claude:backend:main",
    agent: "claude",
    workspace: "backend",
    transportSession: "backend:claude:backend:main",
  });
  expect(prompt.mock.calls).toHaveLength(1);
  expect(prompt.mock.calls.at(0)?.[0]).toMatchObject({
    alias: "backend:claude:backend:main",
    agent: "claude",
    workspace: "backend",
    transportSession: "backend:claude:backend:main",
  });
  expect(prompt.mock.calls.at(0)?.[1]).toContain("这是来自 xacpx 的委派任务。");
  expect(prompt.mock.calls.at(0)?.[1]).toContain("任务内容: review the change");
  workerPrompt.resolve({ text: "ok" });

  type SavedState = {
    orchestration: {
      tasks: Record<
        string,
        {
          sourceHandle: string;
          coordinatorSession: string;
          workerSession?: string;
          workspace: string;
          targetAgent: string;
          task: string;
          status: string;
        }
      >;
      workerBindings: Record<
        string,
        {
          sourceHandle: string;
          coordinatorSession: string;
          workspace: string;
          targetAgent: string;
        }
      >;
    };
  };
  let saved: SavedState = await readJsonWithRetry<SavedState>(statePath);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    saved = await readJsonWithRetry<SavedState>(statePath);
    const firstTask = Object.values(saved.orchestration.tasks)[0];
    if (firstTask?.status === "completed") {
      break;
    }
    await Bun.sleep(10);
  }
  const entries = Object.entries(saved.orchestration.tasks);
  expect(entries).toHaveLength(1);
  const [taskId, task] = entries[0];

  expect(taskId).toBeDefined();
  expect(task).toBeDefined();
  expect(task).toMatchObject({
    sourceHandle: coordinatorTransportSession,
    coordinatorSession: "backend:main",
    workerSession: "backend:claude:backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the change",
    status: "completed",
    resultText: "ok",
  });
  expect(saved.orchestration.workerBindings["backend:claude:backend:main"]).toMatchObject({
    sourceHandle: "backend:claude:backend:main",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("dispatches worker tasks asynchronously, records completion, and notifies the originating chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const hasSession = mock(async () => true);
  const sendOrchestrationNotice = mock(async () => {});
  let resolveWorkerPrompt: ((value: { text: string }) => void) | null = null;
  const workerPrompt = new Promise<{ text: string }>((resolve) => {
    resolveWorkerPrompt = resolve;
  });
  const prompt = mock(async (session) => {
    if (session.alias === "backend:claude:backend:main") {
      return await workerPrompt;
    }
    return { text: "ok" };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession,
      }),
      sendOrchestrationNotice,
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");

  let settled = false;
  const replyPromise = runtime.router
    .handle("wx:user", "/delegate claude review asynchronously", undefined, "ctx-123", "acc-1")
    .then((value) => {
      settled = true;
      return value;
    });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (settled) break;
    await Bun.sleep(10);
  }

  expect(settled).toBe(true);
  const reply = await replyPromise;
  expect(reply.text).toContain("已创建委派任务");

  const runningState = await readJsonWithRetry<{
    orchestration: {
      tasks: Record<string, { status: string; resultText: string; chatKey?: string; replyContextToken?: string; accountId?: string }>;
    };
  }> (statePath);
  const runningTask = Object.values(runningState.orchestration.tasks)[0];
  expect(runningTask).toMatchObject({
    status: "running",
    resultText: "",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });

  resolveWorkerPrompt?.({ text: "worker finished" });
  let completedTask:
    | { status: string; resultText: string; chatKey?: string; replyContextToken?: string; accountId?: string }
    | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const completedState = await readJsonWithRetry<{
      orchestration: {
        tasks: Record<string, { status: string; resultText: string; chatKey?: string; replyContextToken?: string; accountId?: string }>;
      };
    }>(statePath);
    completedTask = Object.values(completedState.orchestration.tasks)[0];
    if (completedTask?.status === "completed" && completedTask.resultText === "worker finished") {
      break;
    }
    await Bun.sleep(10);
  }

  expect(completedTask).toMatchObject({
    status: "completed",
    resultText: "worker finished",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });
  // The notice dispatch races behind the state.json "completed" write — under
  // suite-load we may observe the terminal status before the notifier has had
  // a chance to fire. Mirror the state polling loop so the assertion is stable.
  for (let attempt = 0; attempt < 20 && sendOrchestrationNotice.mock.calls.length === 0; attempt += 1) {
    await Bun.sleep(10);
  }
  expect(sendOrchestrationNotice).toHaveBeenCalledTimes(1);
  expect(sendOrchestrationNotice.mock.calls[0]?.[0]).toMatchObject({
    status: "completed",
    resultText: "worker finished",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("external coordinator worker completion does not wake coordinator transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const prompt = mock(async () => ({ text: "external worker result" }));

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );
  await writeFile(
    statePath,
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
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
      loggerNow: () => new Date("2026-04-28T10:00:00.000Z"),
    },
  );

  const delegated = await runtime.orchestration.service.requestDelegate({
    sourceHandle: "codex:backend",
    targetAgent: "claude",
    task: "review external change",
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const task = await runtime.orchestration.service.getTask(delegated.taskId);
    if (task?.status === "completed") {
      break;
    }
    await Bun.sleep(10);
  }
  await runtime.dispose();

  expect(prompt.mock.calls).toHaveLength(1);
  const logText = await readFile(join(dir, "runtime", "app.log"), "utf8").catch(() => "");
  expect(logText).not.toContain("orchestration.worker.wake_failed");
  expect(logText).not.toContain('no logical session is attached to coordinator "codex:backend"');

  await rm(dir, { recursive: true, force: true });
});

test("pathless external coordinator dispatches workers in the requested cwd", async () => {
  const requestedCwd = "/tmp/standalone-project";
  const expectedCwd = normalize(requestedCwd);
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const prompt = mock(async () => ({ text: "external worker result" }));

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { claude: { driver: "claude", settingsPolicy: "provider-only" } },
      workspaces: {},
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {},
        externalCoordinators: {
          "codex:instance": {
            coordinatorSession: "codex:instance",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
      loggerNow: () => new Date("2026-04-28T10:00:00.000Z"),
    },
  );

  const delegated = await runtime.orchestration.service.requestDelegateFromRpc({
    sourceHandle: "codex:instance",
    targetAgent: "claude",
    task: "review external change",
    cwd: requestedCwd,
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (prompt.mock.calls.length > 0) {
      break;
    }
    await Bun.sleep(10);
  }
  await runtime.dispose();

  expect(delegated.status).toBe("running");
  expect(ensureSession.mock.calls[0]?.[0]).toMatchObject({
    driver: "claude",
    settingsPolicy: "provider-only",
    cwd: expectedCwd,
    workspace: "standalone-project",
    transportSession: delegated.workerSession,
  });
  expect(prompt.mock.calls[0]?.[0]).toMatchObject({
    driver: "claude",
    settingsPolicy: "provider-only",
    cwd: expectedCwd,
    workspace: "standalone-project",
    transportSession: delegated.workerSession,
    mcpCoordinatorSession: "codex:instance",
    mcpSourceHandle: delegated.workerSession,
  });

  await rm(dir, { recursive: true, force: true });
});

test("keeps the previous orchestration snapshot visible until task completion is persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const taskId = "task-1";
  const workerSession = "backend:claude:backend:main";
  const originalTask = {
    taskId,
    sourceHandle: workerSession,
    sourceKind: "worker" as const,
    coordinatorSession: "backend:main",
    workerSession,
    workspace: "backend",
    targetAgent: "claude",
    task: "review asynchronously",
    status: "running" as const,
    summary: "",
    resultText: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          [taskId]: originalTask,
        },
        workerBindings: {},
        groups: {},
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "worker finished" }),
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  const stateStore = runtime.stateStore as unknown as {
    save: (state: unknown) => Promise<void>;
  };
  const originalSave = stateStore.save.bind(runtime.stateStore);
  const saveStarted = createDeferred<void>();
  const releaseSave = createDeferred<void>();
  stateStore.save = async (nextState) => {
    saveStarted.resolve();
    await releaseSave.promise;
    await originalSave(nextState);
  };

  const replyPromise = runtime.orchestration.service.recordWorkerReply({
    taskId,
    sourceHandle: workerSession,
    status: "completed",
    resultText: "worker finished",
  });

  await saveStarted.promise;

  const inMemoryTask = await runtime.orchestration.service.getTask(taskId);
  expect(inMemoryTask).toMatchObject({
    status: "running",
    resultText: "",
  });

  const onDiskTask = JSON.parse(await readFile(statePath, "utf8")) as {
    orchestration: {
      tasks: Record<string, { status: string; resultText: string }>;
    };
  };
  expect(onDiskTask.orchestration.tasks[taskId]).toMatchObject({
    status: "running",
    resultText: "",
  });

  releaseSave.resolve();
  await expect(replyPromise).resolves.toMatchObject({
    status: "completed",
    resultText: "worker finished",
  });

  const persistedTask = await readJsonWithRetry<{
    orchestration: {
      tasks: Record<string, { status: string; resultText: string }>;
    };
  }>(statePath);
  expect(persistedTask.orchestration.tasks[taskId]).toMatchObject({
    status: "completed",
    resultText: "worker finished",
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("does not notify delegated task completion when the originating reply context is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const hasSession = mock(async () => true);
  const sendOrchestrationNotice = mock(async () => {});
  const prompt = mock(async (session) => {
    if (session.alias === "backend:claude:backend:main") {
      return { text: "worker finished" };
    }
    return { text: "ok" };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession,
      }),
      sendOrchestrationNotice,
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await runtime.router.handle("wx:user", "/delegate claude review asynchronously");
  expect(reply.text).toContain("已创建委派任务");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const completedState = await readJsonWithRetry<{
      orchestration: {
        tasks: Record<string, { status: string; resultText: string; replyContextToken?: string; accountId?: string }>;
      };
    }>(statePath);
    const completedTask = Object.values(completedState.orchestration.tasks)[0];
    if (completedTask?.status === "completed") {
      expect(completedTask.replyContextToken).toBeUndefined();
      break;
    }
    await Bun.sleep(10);
  }

  expect(sendOrchestrationNotice).not.toHaveBeenCalled();

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp dispose waits for in-flight worker dispatches to settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const promptStarted = createDeferred<void>();
  const releasePrompt = createDeferred<void>();

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async (session) => {
          if (session.alias === "backend:claude:backend:main") {
            promptStarted.resolve();
            await releasePrompt.promise;
            return { text: "worker finished" };
          }
          return { text: "ok" };
        },
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.router.handle("wx:user", "/delegate claude review asynchronously");

  await promptStarted.promise;

  let disposed = false;
  const disposePromise = runtime.dispose().then(() => {
    disposed = true;
  });

  await Bun.sleep(20);
  expect(disposed).toBe(false);

  releasePrompt.resolve();
  await disposePromise;
  await rm(dir, { recursive: true, force: true });
});

test("buildApp dispose awaits logger flush before returning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const flushStarted = createDeferred<void>();
  const releaseFlush = createDeferred<void>();

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
    },
  );

  const originalFlush = runtime.logger.flush;
  runtime.logger.flush = async () => {
    flushStarted.resolve();
    await releaseFlush.promise;
    await originalFlush();
  };

  let disposed = false;
  const disposePromise = runtime.dispose().then(() => {
    disposed = true;
  });

  await flushStarted.promise;
  await Bun.sleep(20);
  expect(disposed).toBe(false);

  releaseFlush.resolve();
  await disposePromise;
  await rm(dir, { recursive: true, force: true });
});

test("persists delegated task completion even when sending the completion notice fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const hasSession = mock(async () => true);
  const sendOrchestrationNotice = mock(async () => {
    throw new Error("notice failed");
  });
  const prompt = mock(async (session) => {
    if (session.alias === "backend:claude:backend:main") {
      return { text: "worker finished" };
    }
    return { text: "ok" };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession,
      }),
      sendOrchestrationNotice,
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  const reply = await runtime.router.handle(
    "wx:user",
    "/delegate claude review asynchronously",
    undefined,
    "ctx-123",
    "acc-1",
  );
  expect(reply.text).toContain("已创建委派任务");

  let completedTask:
    | { status: string; resultText: string; chatKey?: string; replyContextToken?: string; accountId?: string }
    | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const completedState = await readJsonWithRetry<{
      orchestration: {
        tasks: Record<string, { status: string; resultText: string; chatKey?: string; replyContextToken?: string; accountId?: string }>;
      };
    }>(statePath);
    completedTask = Object.values(completedState.orchestration.tasks)[0];
    if (completedTask?.status === "completed" && completedTask.resultText === "worker finished") {
      break;
    }
    await Bun.sleep(10);
  }

  expect(completedTask).toMatchObject({
    status: "completed",
    resultText: "worker finished",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });
  for (let attempt = 0; attempt < 20 && sendOrchestrationNotice.mock.calls.length === 0; attempt += 1) {
    await Bun.sleep(10);
  }
  expect(sendOrchestrationNotice).toHaveBeenCalledTimes(1);
  await Bun.sleep(25);

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("replays pending orchestration notices during runtime startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const sendOrchestrationNotice = mock(async () => {});

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: {
        codex: { driver: "codex" },
        claude: { driver: "claude" },
      },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      sessions: {},
      chat_contexts: {},
      orchestration: {
        tasks: {
          "task-notice-replay-1": {
            taskId: "task-notice-replay-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            chatKey: "wx:user",
            replyContextToken: "ctx-123",
            accountId: "acc-1",
            noticePending: true,
          },
        },
        workerBindings: {},
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendOrchestrationNotice,
    },
  );

  expect(sendOrchestrationNotice).toHaveBeenCalledTimes(1);
  expect(sendOrchestrationNotice.mock.calls[0]?.[0]).toMatchObject({
    taskId: "task-notice-replay-1",
    noticePending: true,
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("propagates running task cancellation to the worker transport and completes the task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const ensureSession = mock(async () => {});
  const prompt = mock(async () => ({ text: "ok" }));
  const hasSession = mock(async () => true);
  const cancel = mock(async () => ({ cancelled: true, message: "cancelled" }));

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] } },
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      chat_contexts: {
        "wx:user": {
          current_session: "main",
        },
      },
      orchestration: {
        tasks: {
          "task-cancel-runtime-1": {
            taskId: "task-cancel-runtime-1",
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
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
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
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession,
        prompt,
        setMode: async () => {},
        cancel,
        hasSession,
      }),
      sendOrchestrationNotice: async () => {},
    },
  );

  const reply = await runtime.router.handle("wx:user", "/task cancel task-cancel-runtime-1");
  expect(reply.text).toContain("已请求取消");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const saved = await readJsonWithRetry<{
      orchestration: { tasks: Record<string, { status: string; cancelRequestedAt?: string; cancelCompletedAt?: string }> };
    }>(statePath);
    if (saved.orchestration.tasks["task-cancel-runtime-1"]?.status === "cancelled") {
      break;
    }
    await Bun.sleep(10);
  }

  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel.mock.calls[0]?.[0]).toMatchObject({
    alias: "backend:claude:backend:main",
    agent: "claude",
    workspace: "backend",
    transportSession: "backend:claude:backend:main",
  });

  const saved = await readJsonWithRetry<{
    orchestration: {
      tasks: Record<string, { status: string; cancelRequestedAt?: string; cancelCompletedAt?: string; lastCancelError?: string }>;
    };
  }>(statePath);
  expect(saved.orchestration.tasks["task-cancel-runtime-1"]).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: expect.any(String),
    cancelCompletedAt: expect.any(String),
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("records cancellation errors when worker transport cancel is not acknowledged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const cancel = mock(async () => ({ cancelled: false, message: "transport refused" }));

  await writeFile(
    configPath,
    JSON.stringify({
      language: "zh",
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] } },
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      chat_contexts: {
        "wx:user": { current_session: "main" },
      },
      orchestration: {
        tasks: {
          "task-cancel-runtime-2": {
            taskId: "task-cancel-runtime-2",
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
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
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
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        setMode: async () => {},
        cancel,
        hasSession: async () => true,
      }),
      sendOrchestrationNotice: async () => {},
    },
  );

  const reply = await runtime.router.handle("wx:user", "/task cancel task-cancel-runtime-2");
  expect(reply.text).toContain("已请求取消");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const saved = await readJsonWithRetry<{
      orchestration: {
        tasks: Record<string, { status: string; lastCancelError?: string; cancelRequestedAt?: string }>;
      };
    }>(statePath);
    if (saved.orchestration.tasks["task-cancel-runtime-2"]?.lastCancelError) {
      break;
    }
    await Bun.sleep(10);
  }

  const saved = await readJsonWithRetry<{
    orchestration: {
      tasks: Record<string, { status: string; lastCancelError?: string; cancelRequestedAt?: string }>;
    };
  }>(statePath);
  expect(saved.orchestration.tasks["task-cancel-runtime-2"]).toMatchObject({
    status: "running",
    cancelRequestedAt: expect.any(String),
    lastCancelError: "transport refused",
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logText = await readFile(join(dir, "runtime", "app.log"), "utf8").catch(() => "");
    if (logText.includes("orchestration.task.cancel_failed")) {
      break;
    }
    await Bun.sleep(10);
  }

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("creates a default config on first run when the config file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createBridgeTransport: async () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
        dispose: async () => {},
      }),
    },
  );

  const saved = JSON.parse(await readFile(configPath, "utf8")) as {
    transport: { type: string; sessionInitTimeoutMs?: number };
    agents: Record<string, { driver: string }>;
    workspaces: Record<string, unknown>;
  };

  // The seed stays slim: defaults (timeouts, permission modes, TTLs) are
  // materialized at load time, never pinned into the file.
  expect(saved.transport).toEqual({ type: "acpx-bridge" });
  expect(saved.agents).toEqual({
    codex: {
      driver: "codex",
    },
    claude: {
      driver: "claude",
    },
  });
  // First run seeds a single portable home workspace (`~` is expanded on load).
  expect(saved.workspaces).toEqual({ home: { cwd: "~", description: "home directory" } });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prefers the configured acpx command when building the cli transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  let capturedCommand = "";

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "/custom/acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: (command) => {
        capturedCommand = command;
        return {
          ensureSession: async () => {},
          prompt: async () => ({ text: "ok" }),
          cancel: async () => ({ cancelled: true, message: "cancelled" }),
          hasSession: async () => true,
          listSessions: async () => [],
        };
      },
    },
  );

  expect(capturedCommand).toBe("/custom/acpx");
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("builds the bridge transport when transport.type is acpx-bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-bridge", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createBridgeTransport: async () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
        dispose: async () => {},
      }),
    },
  );

  expect(runtime.router).toBeDefined();
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("defaults to the bridge transport when transport.type is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createBridgeTransport: async () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
        dispose: async () => {},
      }),
    },
  );

  expect(runtime.router).toBeDefined();
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("falls back to the OS home directory when HOME is unset", () => {
  const originalHome = process.env.HOME;
  const originalConfig = process.env.WEACPX_CONFIG;
  const originalState = process.env.WEACPX_STATE;

  delete process.env.HOME;
  delete process.env.WEACPX_CONFIG;
  delete process.env.WEACPX_STATE;

  try {
    const paths = resolveRuntimePaths();

    const normalizedConfigPath = paths.configPath.replace(/\\/g, "/");
    const normalizedStatePath = paths.statePath.replace(/\\/g, "/");
    const normalizedPerfPath = (paths.perfLogPath ?? "").replace(/\\/g, "/");

    // Derive the expected base via coreHomeDir(homedir()): it prefers ~/.xacpx
    // but falls back to an existing legacy ~/.weacpx, so a hardcoded dir name
    // would make this assertion machine-dependent. The test's point is the
    // HOME-unset → homedir() fallback, not the directory name.
    const base = coreHomeDir(homedir()).replace(/\\/g, "/");

    expect(normalizedConfigPath).toBe(`${base}/config.json`);
    expect(normalizedStatePath).toBe(`${base}/state.json`);
    expect(normalizedPerfPath).toBe(`${base}/runtime/perf.log`);
    if (process.platform === "win32") {
      expect(paths.orchestrationSocketPath.startsWith("\\\\.\\pipe\\xacpx-orchestration-")).toBe(true);
    } else {
      expect(paths.orchestrationSocketPath.replace(/\\/g, "/")).toBe(`${base}/runtime/orchestration.sock`);
    }
  } finally {
    process.env.HOME = originalHome;
    process.env.WEACPX_CONFIG = originalConfig;
    process.env.WEACPX_STATE = originalState;
  }
});

test("extracts [PROGRESS] markers from worker output and sends progress notifications", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const sendOrchestrationNotice = mock(async () => {});

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex", "claude"],
        },
      },
      orchestration: { progressHeartbeatSeconds: 0 },
    }),
  );
  await writeFile(statePath, JSON.stringify({ sessions: {}, chat_contexts: {}, orchestration: { tasks: {}, workerBindings: {} } }));

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async (_session, _text, reply, _replyContext, options) => {
          if (reply) {
            await reply("[PROGRESS] analyzing code\n");
            await reply("[PROGRESS] found 3 issues\nHere is the result.\n");
            return { text: "" };
          }
          await options?.onSegment?.("[PROGRESS] analyzing code\n");
          await options?.onSegment?.("[PROGRESS] found 3 issues\nHere is the result.\n");
          return { text: "[PROGRESS] analyzing code\n[PROGRESS] found 3 issues\nHere is the result." };
        },
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendOrchestrationNotice,
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.router.handle("wx:user", "/dg claude review the code", undefined, "ctx-1", "acc-1");

  // Wait for async dispatchWorkerTask to complete
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const persistedState = await readJsonWithRetry<Awaited<ReturnType<typeof runtime.stateStore.load>>>(statePath);
    const task = await runtime.orchestration.service.getTask(
      Object.keys(persistedState.orchestration.tasks)[0] ?? "",
    );
    if (task?.status === "completed") {
      break;
    }
    await Bun.sleep(10);
  }

  // Final result should not contain [PROGRESS] lines
  const saved = await readJsonWithRetry<Awaited<ReturnType<typeof runtime.stateStore.load>>>(statePath);
  const taskEntry = Object.values(saved.orchestration.tasks)[0];
  expect(taskEntry?.resultText).not.toContain("[PROGRESS]");
  expect(taskEntry?.resultText).toContain("Here is the result.");
  expect(taskEntry?.lastProgressAt).toBeDefined();
  expect(taskEntry?.lastProgressSummary).toBe("found 3 issues");

  await Bun.sleep(20);
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp logs quarantined state records at error level with the quarantine path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const rootDir = join(dir, ".weacpx");
  const configPath = join(rootDir, "config.json");
  const statePath = join(rootDir, "state.json");
  const runtimeDir = join(rootDir, "runtime");
  await mkdir(rootDir, { recursive: true });

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );
  await writeFile(
    statePath,
    JSON.stringify({
      sessions: {
        good: {
          alias: "good",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:good",
          created_at: "2026-06-10T10:00:00.000Z",
          last_used_at: "2026-06-10T10:00:00.000Z",
        },
        bad: { alias: "bad", agent: 42 },
      },
      chat_contexts: {},
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  const appLog = await readFile(join(runtimeDir, "app.log"), "utf8");
  expect(appLog).toContain("ERROR state.record_quarantined");
  expect(appLog).toContain('section="sessions"');
  expect(appLog).toContain('key="bad"');
  expect(appLog).toContain("ERROR state.file_quarantined");
  expect(appLog).toContain("state.json.quarantine-");

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp cleans stale rotated app logs and can default logging to debug", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const rootDir = join(dir, ".weacpx");
  const configPath = join(rootDir, "config.json");
  const statePath = join(rootDir, "state.json");
  const runtimeDir = join(rootDir, "runtime");
  const staleLog = join(runtimeDir, "app.log.2");
  await mkdir(runtimeDir, { recursive: true });

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
        },
      },
    }),
  );
  await writeFile(staleLog, "stale");
  const staleAt = new Date("2026-03-19T00:00:00.000Z");
  await utimes(staleLog, staleAt, staleAt);

  const runtime = await buildApp(
    { configPath, statePath },
    {
      defaultLoggingLevel: "debug",
      loggerNow: () => new Date("2026-03-27T00:00:00.000Z"),
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
      }),
    },
  );

  await runtime.agent.chat({
    conversationId: "wx:user",
    text: "/help",
  });

  const appLog = await readFile(join(runtimeDir, "app.log"), "utf8");
  expect(appLog).toContain("DEBUG command.parsed");
  await expect(readFile(staleLog, "utf8")).rejects.toThrow();

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("workerRaiseQuestion auto-wakes the preferred coordinator session with a blocker-first prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const workerPrompt = createDeferred<{ text: string }>();
  const prompt = mock(async (session: { alias: string }) => {
    if (session.alias === "backend:claude:backend:main") {
      return await workerPrompt.promise;
    }
    return { text: "coordinator woke" };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] } },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendCoordinatorMessage: mock(async () => {}),
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.orchestration.service.requestDelegate({
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the patch",
  });
  const taskId = Object.keys(
    (
      await readJsonWithRetry<{
        orchestration: { tasks: Record<string, unknown> };
      }>(statePath)
    ).orchestration.tasks,
  )[0]!;

  await runtime.orchestration.service.workerRaiseQuestion({
    taskId,
    sourceHandle: "backend:claude:backend:main",
    question: "Should I keep SQLite?",
    whyBlocked: "follow-up steps depend on the DB choice",
    whatIsNeeded: "database decision",
  });

  const coordinatorPrompt = prompt.mock.calls.find((call) => call[0].alias === "main")?.[1] ?? "";
  expect(coordinatorPrompt).toContain("[delegate_question_package]");
  expect(coordinatorPrompt).toContain("Should I keep SQLite?");
  expect(coordinatorPrompt).toContain("answer_blockers_first");

  workerPrompt.resolve({ text: "worker still running" });
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("workerRaiseQuestion wake prefers the canonical alias over a more recently used shadow alias for the same transport session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const workerPrompt = createDeferred<{ text: string }>();
  const prompt = mock(async (session: { alias: string }) => {
    if (session.alias === "backend:claude:backend:main") {
      return await workerPrompt.promise;
    }
    return { text: `coordinator woke via ${session.alias}` };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: {
        backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] },
        shadow: { cwd: "/tmp/shadow", allowed_agents: ["codex", "claude"] },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendCoordinatorMessage: mock(async () => {}),
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.sessions.attachSession("shadow-main", "codex", "shadow", "backend:main");
  await runtime.sessions.useSession("wx:shadow", "shadow-main");

  await runtime.orchestration.service.requestDelegate({
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the patch",
  });
  const taskId = Object.keys(
    (
      await readJsonWithRetry<{
        orchestration: { tasks: Record<string, unknown> };
      }>(statePath)
    ).orchestration.tasks,
  )[0]!;

  await runtime.orchestration.service.workerRaiseQuestion({
    taskId,
    sourceHandle: "backend:claude:backend:main",
    question: "Should I keep SQLite?",
    whyBlocked: "follow-up steps depend on the DB choice",
    whatIsNeeded: "database decision",
  });

  expect(prompt.mock.calls.find((call) => call[0].alias === "main")?.[1] ?? "").toContain(
    "[delegate_question_package]",
  );
  expect(prompt.mock.calls.find((call) => call[0].alias === "shadow-main")).toBeUndefined();

  workerPrompt.resolve({ text: "worker still running" });
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("coordinatorRequestHumanInput sends a proactive package through the latest coordinator route context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const sendCoordinatorMessage = mock(async () => {});
  const workerPrompt = createDeferred<{ text: string }>();

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] } },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async (session) =>
          session.alias === "backend:claude:backend:main" ? await workerPrompt.promise : { text: "ok" },
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendCoordinatorMessage,
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.router.handle("wx:user", "主线继续", undefined, "ctx-1", "acc-1");
  await runtime.orchestration.service.requestDelegate({
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the patch",
  });
  const task = Object.values(
    (
      await readJsonWithRetry<{
        orchestration: { tasks: Record<string, { taskId: string }> };
      }>(statePath)
    ).orchestration.tasks,
  )[0]!;

  const raised = await runtime.orchestration.service.workerRaiseQuestion({
    taskId: task.taskId,
    sourceHandle: "backend:claude:backend:main",
    question: "Should I keep SQLite?",
    whyBlocked: "follow-up steps depend on the DB choice",
    whatIsNeeded: "database decision",
  });

  await runtime.orchestration.service.coordinatorRequestHumanInput({
    coordinatorSession: "backend:main",
    taskQuestions: [{ taskId: task.taskId, questionId: raised.questionId }],
    promptText: "请确认数据库方案。",
    expectedActivePackageId: undefined,
  });

  expect(sendCoordinatorMessage).toHaveBeenCalledTimes(1);
  expect(sendCoordinatorMessage.mock.calls[0]?.[0]).toMatchObject({
    coordinatorSession: "backend:main",
    chatKey: "wx:user",
    accountId: "acc-1",
    replyContextToken: "ctx-1",
  });
  expect(sendCoordinatorMessage.mock.calls[0]?.[0].text).toContain("请确认数据库方案");

  workerPrompt.resolve({ text: "worker still running" });
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("worker prompt return after workerRaiseQuestion leaves the task blocked instead of completing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const firstWorkerTurn = createDeferred<{ text: string }>();
  let workerPromptCount = 0;
  const prompt = mock(async (session: { alias: string }) => {
    if (session.alias === "backend:claude:backend:main") {
      workerPromptCount += 1;
      if (workerPromptCount === 1) {
        return await firstWorkerTurn.promise;
      }
      return { text: "unexpected extra worker turn" };
    }
    return { text: "coordinator woke" };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] } },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendCoordinatorMessage: mock(async () => {}),
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.orchestration.service.requestDelegate({
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the patch",
  });
  const taskId = Object.keys(
    (
      await readJsonWithRetry<{
        orchestration: { tasks: Record<string, unknown> };
      }>(statePath)
    ).orchestration.tasks,
  )[0]!;

  const raised = await runtime.orchestration.service.workerRaiseQuestion({
    taskId,
    sourceHandle: "backend:claude:backend:main",
    question: "Should I keep SQLite?",
    whyBlocked: "follow-up steps depend on the DB choice",
    whatIsNeeded: "database decision",
  });

  firstWorkerTurn.resolve({ text: "I need a database decision before I can continue." });
  await Bun.sleep(20);

  const task = await runtime.orchestration.service.getTask(taskId);
  expect(task).toMatchObject({
    taskId,
    status: "blocked",
    resultText: "",
    openQuestion: {
      questionId: raised.questionId,
      status: "open",
    },
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("coordinatorAnswerQuestion resumes asynchronously and persists the resumed completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const firstWorkerTurn = createDeferred<{ text: string }>();
  const resumedWorkerTurn = createDeferred<{ text: string }>();
  let workerPromptCount = 0;
  const prompt = mock(async (session: { alias: string }) => {
    if (session.alias === "backend:claude:backend:main") {
      workerPromptCount += 1;
      if (workerPromptCount === 1) {
        return await firstWorkerTurn.promise;
      }
      return await resumedWorkerTurn.promise;
    }
    return { text: "coordinator woke" };
  });

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend", allowed_agents: ["codex", "claude"] } },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt,
        setMode: async () => {},
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
      }),
      sendCoordinatorMessage: mock(async () => {}),
    },
  );

  await runtime.router.handle("wx:user", "/session new main --agent codex --ws backend");
  await runtime.orchestration.service.requestDelegate({
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the patch",
  });
  const taskId = Object.keys(
    (
      await readJsonWithRetry<{
        orchestration: { tasks: Record<string, unknown> };
      }>(statePath)
    ).orchestration.tasks,
  )[0]!;

  const raised = await runtime.orchestration.service.workerRaiseQuestion({
    taskId,
    sourceHandle: "backend:claude:backend:main",
    question: "Should I keep SQLite?",
    whyBlocked: "follow-up steps depend on the DB choice",
    whatIsNeeded: "database decision",
  });
  firstWorkerTurn.resolve({ text: "Need an explicit database answer." });
  await Bun.sleep(20);

  let answerSettled = false;
  const answerPromise = runtime.orchestration.service
    .coordinatorAnswerQuestion({
      coordinatorSession: "backend:main",
      taskId,
      questionId: raised.questionId,
      answer: "继续 SQLite。",
    })
    .then(() => {
      answerSettled = true;
    });

  await answerPromise;
  expect(answerSettled).toBe(true);
  expect(await runtime.orchestration.service.getTask(taskId)).toMatchObject({
    taskId,
    status: "running",
    resultText: "",
    openQuestion: {
      questionId: raised.questionId,
      status: "answered",
      answerSource: "coordinator",
      answerText: "继续 SQLite。",
    },
  });

  resumedWorkerTurn.resolve({ text: "Here is the resumed result." });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const task = await runtime.orchestration.service.getTask(taskId);
    if (task?.status === "completed") {
      break;
    }
    await Bun.sleep(10);
  }

  expect(await runtime.orchestration.service.getTask(taskId)).toMatchObject({
    taskId,
    status: "completed",
    resultText: "Here is the resumed result.",
  });

  await answerPromise;
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("closeWorkerSession dep calls transport.removeSession with the resolved session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const removeSession = mock(async () => {});

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: { cwd: "/tmp/backend", allowed_agents: ["codex"] },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "ok" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
        removeSession,
      }),
    },
  );

  // Register an external coordinator so we can delegate a parallel task.
  await runtime.orchestration.service.registerExternalCoordinator({
    coordinatorSession: "external:codex",
    workspace: "backend",
  });

  const result = await runtime.orchestration.service.requestDelegate({
    sourceHandle: "external:codex",
    targetAgent: "codex",
    task: "do work",
    cwd: "/tmp/backend",
    parallel: true,
  });

  // Wait for the task to reach a terminal state.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = await runtime.orchestration.service.getTask(result.taskId);
    if (task?.status === "completed" || task?.status === "failed") {
      break;
    }
    await Bun.sleep(10);
  }

  // Trigger reconcile so it can close the ephemeral session and invoke removeSession.
  await runtime.orchestration.service.reconcileParallelSlots();

  expect(removeSession.mock.calls.length).toBeGreaterThan(0);
  const sessionArg = removeSession.mock.calls[0]?.[0];
  expect(sessionArg).toMatchObject({
    agent: "codex",
    workspace: "backend",
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("reconcileParallelSlots is called after a worker turn completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const removeSession = mock(async () => {});

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: { cwd: "/tmp/backend", allowed_agents: ["codex"] },
      },
    }),
  );

  const runtime = await buildApp(
    { configPath, statePath },
    {
      createCliTransport: () => ({
        ensureSession: async () => {},
        prompt: async () => ({ text: "done" }),
        cancel: async () => ({ cancelled: true, message: "cancelled" }),
        hasSession: async () => true,
        listSessions: async () => [],
        removeSession,
      }),
    },
  );

  await runtime.orchestration.service.registerExternalCoordinator({
    coordinatorSession: "external:codex",
    workspace: "backend",
  });

  const result = await runtime.orchestration.service.requestDelegate({
    sourceHandle: "external:codex",
    targetAgent: "codex",
    task: "parallel work",
    cwd: "/tmp/backend",
    parallel: true,
  });

  // Wait for the post-worker-turn reconcile to run (launchWorkerTurn calls it).
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (removeSession.mock.calls.length > 0) {
      break;
    }
    await Bun.sleep(10);
  }

  // The post-turn reconcile should have triggered removeSession for the ephemeral session.
  expect(removeSession.mock.calls.length).toBeGreaterThan(0);
  expect(await runtime.orchestration.service.getTask(result.taskId)).toMatchObject({
    status: "completed",
    ephemeralWorkerSessionClosed: true,
  });

  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

import { join as joinPath2 } from "node:path";
import { loadConfiguredPlugins } from "../../src/plugins/plugin-loader";
import { createMessageChannels } from "../../src/channels/create-channel";

test("loadConfiguredPlugins registers plugin channels usable by createMessageChannels", async () => {
  const fixture = joinPath2(process.cwd(), "tests/fixtures/channel-demo-plugin/index.mjs");

  await loadConfiguredPlugins({
    plugins: [{ name: "demo-fixture-plugin", enabled: true }],
    importPlugin: async () => await import(fixture),
  });

  const channels = createMessageChannels([
    { id: "demo-fixture", type: "demo-fixture", enabled: true },
  ]);

  expect(channels.length).toBe(1);
  expect(channels[0]?.id).toBe("demo-fixture");
});

test("buildApp wires weixinLog to the app logger", async () => {
  const { weixinLog, resetWeixinLogForTest } = await import("../../src/weixin/util/weixin-log");
  resetWeixinLogForTest();

  const dir = await mkdtemp(join(tmpdir(), "weacpx-app-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  await writeFile(
    configPath,
    JSON.stringify({
      transport: { type: "acpx-cli", command: "acpx" },
      agents: { codex: { driver: "codex" } },
      workspaces: {
        backend: {
          cwd: "/tmp/backend",
          allowed_agents: ["codex"],
        },
      },
    }),
  );

  const runtime = await buildApp({ configPath, statePath });

  // Call weixinLog directly (no setWeixinLog from the test) so the only way
  // this can land in app.log is if buildApp itself wired the sink. If the
  // wiring is missing, weixinLog's sink stays null and the write is dropped.
  weixinLog.info("weixin.probe.ok", "probe");
  await runtime.logger.flush();

  const logText = await readFile(join(dir, "runtime", "app.log"), "utf8").catch(() => "");
  expect(logText).toContain("weixin.probe.ok");
  expect(logText).toContain("message=\"probe\"");

  resetWeixinLogForTest();
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("buildApp provisions acpx agent overlays before transport creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-main-"));
  try {
    const configPath = join(dir, "config.json");
    const statePath = join(dir, "state.json");
    await writeFile(
      configPath,
      JSON.stringify({
        transport: { type: "acpx-cli", command: "acpx" },
        agents: { codex: { driver: "codex" }, pool: { driver: "pool" } },
        workspaces: { backend: { cwd: "/tmp/backend" } },
      }),
    );

    let provisionedConfig: unknown;
    const runtime = await buildApp({ configPath, statePath }, {
      createCliTransport: () => ({
        ensureSession: async () => ({}),
        prompt: async () => ({ text: "ok" }),
        setMode: async () => ({}),
        cancel: async () => ({}),
        hasSession: () => false,
        dispose: async () => {},
      }),
      provisionAgentOverlays: async (config) => {
        provisionedConfig = config;
        return { outcomes: {}, raced: false };
      },
    });

    expect(provisionedConfig).toMatchObject({
      agents: { codex: { driver: "codex" }, pool: { driver: "pool" } },
    });
    await runtime.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
