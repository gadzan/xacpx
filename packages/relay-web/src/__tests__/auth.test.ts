// packages/relay-web/src/__tests__/auth.test.ts
import { setActivePinia, createPinia } from "pinia";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { useAuthStore } from "../stores/auth";
import { useFilesStore } from "../stores/files";
import { useSessionControlsStore } from "../stores/session-controls";
import { useTasksStore } from "../stores/tasks";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => vi.restoreAllMocks());

test("login posts {token} and stores the account on success", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ username: "admin" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const auth = useAuthStore();
  const ok = await auth.login("secret-token");
  expect(ok).toBe(true);
  // Must post {token: ...} — not username/password
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(init.body as string);
  expect(body).toEqual({ token: "secret-token" });
  // account has no role key
  expect(auth.account).toEqual({ username: "admin" });
  expect(auth.error).toBe("");
});

test("login surfaces an error and leaves account null on 401", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid-credentials" }), { status: 401 })));
  const auth = useAuthStore();
  const ok = await auth.login("bad-token");
  expect(ok).toBe(false);
  expect(auth.account).toBeNull();
  expect(auth.error).toBe("invalid-credentials");
});

test("fetchMe populates account when a session exists", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ username: "u" }), { status: 200 })));
  const auth = useAuthStore();
  expect(await auth.fetchMe()).toBe(true);
  expect(auth.account?.username).toBe("u");
  // No role on the account
  expect((auth.account as Record<string, unknown>).role).toBeUndefined();
});

test("logout clears account-owned view state before another user can reuse the stores", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const auth = useAuthStore();
  auth.account = { username: "alice" };
  const controls = useSessionControlsStore();
  const tasks = useTasksStore();
  const files = useFilesStore();
  controls.modelCurrent = "alice-model";
  controls.modelAvailable = ["alice-model"];
  controls.effortCurrent = "high";
  controls.effortAvailable = ["high"];
  tasks.scope = { instanceId: "i1", sessionAlias: "s1" };
  tasks.scheduled = [{ id: "alice-task" }] as never;
  tasks.orchestration = [{ taskId: "alice-agent" }] as never;
  files.instanceId = "i1";
  files.workspace = "alice-workspace";
  files.tree = { "": [{ name: "alice-secret.ts", type: "file" }] };
  files.gitSummary = { workspace: "alice-workspace", changedCount: 1 };

  await auth.logout();
  await nextTick();

  expect(controls.modelCurrent).toBeUndefined();
  expect(controls.modelAvailable).toEqual([]);
  expect(controls.effortCurrent).toBeUndefined();
  expect(controls.effortAvailable).toEqual([]);
  expect(tasks.scope).toBeNull();
  expect(tasks.scheduled).toEqual([]);
  expect(tasks.orchestration).toEqual([]);
  expect(files.instanceId).toBeNull();
  expect(files.workspace).toBeNull();
  expect(files.tree).toEqual({});
  expect(files.gitSummary).toBeNull();
});
