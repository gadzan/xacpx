import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, test, vi } from "vitest";
import { normalizeRuntimeConfig } from "../lib/runtime-config";
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

test("a failed config request keeps the relay dashboard", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "unauthorized" }, 401)));
  const config = await useRuntimeStore().ensure();
  expect(config.hostMode).toBe("relay");
  expect(config.auth.required).toBe(true);
  expect(config.capabilities.agentDirectory).toBe(true);
});
