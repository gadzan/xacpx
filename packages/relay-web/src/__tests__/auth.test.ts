// packages/relay-web/src/__tests__/auth.test.ts
import { setActivePinia, createPinia } from "pinia";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAuthStore } from "../stores/auth";

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
