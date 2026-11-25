import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { normalizeRuntimeConfig } from "../lib/runtime-config";
import { hostRoute } from "../router";
import { useAuthStore } from "../stores/auth";
import { useRuntimeStore } from "../stores/runtime";

const LOCAL_CAPS = {
  multiInstance: false,
  pairing: false,
  invites: false,
  webPush: false,
  relayUpdate: false,
  agentDirectory: false,
  terminal: false,
  desktop: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.restoreAllMocks();
});

test("a config without hostMode stays on the relay dashboard", () => {
  const config = normalizeRuntimeConfig({
    historyRetention: { mode: "client-side", days: 30, maxPerSession: 2000 },
  });
  expect(config.hostMode).toBe("relay");
  expect(config.auth).toEqual({ required: true, mode: "token" });
  expect(config.capabilities.pairing).toBe(true);
  expect(config.capabilities.webPush).toBe(true);
});

test("local mode without auth answers as the local user and never asks the server", async () => {
  const fetchMock = vi.fn(async () => json({ error: "unexpected" }, 500));
  vi.stubGlobal("fetch", fetchMock);
  const runtime = useRuntimeStore();
  runtime.config = normalizeRuntimeConfig({
    hostMode: "local",
    auth: { required: false, mode: "none" },
    capabilities: LOCAL_CAPS,
  });
  runtime.loaded = true;

  expect(await useAuthStore().fetchMe()).toBe(true);
  expect(useAuthStore().account).toEqual({ username: "local" });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("local mode with a token still signs in, and does not touch web push", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/login") && init?.method === "POST") return json({ username: "ada" });
    return json({ error: "unexpected" }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  const runtime = useRuntimeStore();
  runtime.config = normalizeRuntimeConfig({
    hostMode: "local",
    auth: { required: true, mode: "token" },
    capabilities: LOCAL_CAPS,
  });
  runtime.loaded = true;

  const ok = await useAuthStore().login("local-secret");
  expect(ok).toBe(true);
  expect(useAuthStore().account).toEqual({ username: "ada" });
  const urls = fetchMock.mock.calls.map(([url]) => String(url));
  expect(urls).toEqual(["/api/login"]);
});

test("a 401 config response is an older relay hub and is remembered", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "unauthorized" }, 401)));
  const runtime = useRuntimeStore();
  const config = await runtime.ensure();
  expect(config.hostMode).toBe("relay");
  expect(runtime.loaded).toBe(true);
  expect(config.capabilities.agentDirectory).toBe(true);
});

test("a failed config request is not remembered, so the next navigation can retry", async () => {
  const fetchMock = vi.fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(json({
      hostMode: "local",
      auth: { required: false, mode: "none" },
      capabilities: LOCAL_CAPS,
    }));
  vi.stubGlobal("fetch", fetchMock);
  const runtime = useRuntimeStore();
  expect((await runtime.ensure()).hostMode).toBe("relay");
  expect(runtime.loaded).toBe(false);
  expect((await runtime.ensure()).hostMode).toBe("local");
  expect(runtime.loaded).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("an open local host leaves login and invite for the dashboard", () => {
  const config = normalizeRuntimeConfig({
    hostMode: "local",
    auth: { required: false, mode: "none" },
    capabilities: LOCAL_CAPS,
  });
  expect(hostRoute("login", config)).toEqual({ name: "dashboard" });
  expect(hostRoute("invite", config)).toEqual({ name: "dashboard" });
  expect(hostRoute("dashboard", config)).toBe(true);
});

test("a token-gated local host keeps login and refuses invites", () => {
  const config = normalizeRuntimeConfig({
    hostMode: "local",
    auth: { required: true, mode: "token" },
    capabilities: LOCAL_CAPS,
  });
  expect(hostRoute("login", config)).toBe(true);
  expect(hostRoute("invite", config)).toEqual({ name: "login" });
  expect(hostRoute("settings", config)).toBe("check-session");
});

test("recheck corrects a latched relay fallback when the host answers again", async () => {
  // A 401/404 latches the relay runtime and nothing clears it, so a host that was
  // briefly unreachable left the whole session on the login page with no way back.
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(json({ error: "unauthorized" }, 401))
    .mockResolvedValueOnce(json({
      hostMode: "local",
      auth: { required: false, mode: "none" },
      capabilities: LOCAL_CAPS,
    }));
  vi.stubGlobal("fetch", fetchMock);
  const runtime = useRuntimeStore();
  expect((await runtime.ensure()).hostMode).toBe("relay");
  expect((await runtime.recheck()).hostMode).toBe("local");
  expect(runtime.config.hostMode).toBe("local");
});
