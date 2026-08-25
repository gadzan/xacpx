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

// ── push-subscription ownership contract (fail-closed auth switch) ──────────

vi.mock("../lib/web-push", () => ({
  releaseSubscriptionOwnership: vi.fn(),
  transferSubscriptionOwnership: vi.fn(),
  reconcileExistingSubscription: vi.fn(),
}));

import {
  releaseSubscriptionOwnership,
  transferSubscriptionOwnership,
  reconcileExistingSubscription,
} from "../lib/web-push";

const transferMock = vi.mocked(transferSubscriptionOwnership);
const reconcileMock = vi.mocked(reconcileExistingSubscription);
const releaseMock = vi.mocked(releaseSubscriptionOwnership);
test("login awaits reconcile and reports failure when ownership transfer fails (A→B leak window closed)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ username: "bob" }), { status: 200 })));
  // Simulate the crashed-tab case: browser still holds A's subscription and
  // the rebind PUT fails → reconcile rejects → login must NOT report success.
  let resolveTransfer!: (v: void) => void;
  transferMock.mockReturnValue(new Promise<void>((r) => { resolveTransfer = r; }));

  const auth = useAuthStore();
  const loginPromise = auth.login("b-token");
  let settled = false;
  loginPromise.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  // /api/login succeeded but reconcile is still pending → no success yet:
  expect(settled).toBe(false);
  resolveTransfer();
  expect(await loginPromise).toBe(true);
});

test("login returns false and revokes server session when reconcile rejects (local subscription destroyed)", async () => {
  const postCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const p = String(url);
    if (init?.method === "POST" && p === "/api/login") {
      postCalls.push("login");
      return new Response(JSON.stringify({ username: "bob" }), { status: 200 });
    }
    if (init?.method === "POST" && p === "/api/logout") {
      postCalls.push("logout");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
  }));
  transferMock.mockRejectedValueOnce(new Error("rebind failed"));
  const auth = useAuthStore();
  const ok = await auth.login("b-token");
  expect(ok).toBe(false);
  expect(auth.account).toBeNull();
  expect(transferMock).toHaveBeenCalledTimes(1);
  expect(postCalls).toEqual(["login", "logout"]);
});

test("fetchMe also awaits reconcile before reporting success", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ username: "u" }), { status: 200 })));
  reconcileMock.mockRejectedValueOnce(new Error("hub unreachable"));
  const auth = useAuthStore();
  expect(await auth.fetchMe()).toBe(false);
  expect(auth.account).toBeNull();
});

test("login throws when session rollback /api/logout fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const p = String(url);
    if (init?.method === "POST" && p === "/api/login") {
      return new Response(JSON.stringify({ username: "bob" }), { status: 200 });
    }
    if (init?.method === "POST" && p === "/api/logout") {
      return new Response(JSON.stringify({ error: "network-error" }), { status: 500 });
    }
    return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
  }));
  transferMock.mockRejectedValueOnce(new Error("rebind failed"));
  const auth = useAuthStore();
  await expect(auth.login("b-token")).rejects.toThrow();
});

test("logout releases subscription ownership BEFORE clearing the session", async () => {
  const callOrder: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    // auth.logout POSTs /api/logout; record where it lands relative to release.
    if (init?.method === "POST") callOrder.push("logout-post");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
  releaseMock.mockImplementation(async () => { callOrder.push("release"); });

  const auth = useAuthStore();
  auth.account = { username: "alice" };
  await auth.logout();
  expect(releaseMock).toHaveBeenCalledTimes(1);
  expect(callOrder).toEqual(["release", "logout-post"]);
});
