import { expect, mock, test } from "bun:test";

import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";
import { BridgeServer } from "../../../src/bridge/bridge-server";

test("bridge routes freeWarmProcess to the runtime", async () => {
  const freeWarmProcess = mock(async () => ({}));
  const runtime = {
    shutdown: async () => ({}),
    updatePermissionPolicy: async () => ({}),
    hasSession: async () => ({ exists: true }),
    ensureSession: async () => ({}),
    prompt: async () => ({ text: "ok" }),
    setMode: async () => ({}),
    cancel: async () => ({ cancelled: true, message: "cancelled" }),
    removeSession: async () => ({}),
    deleteSession: async () => ({}),
    freeWarmProcess,
  } as unknown as BridgeRuntime;
  const server = new BridgeServer(runtime);

  await expect(server.handleLine(JSON.stringify({
    id: "free-1",
    method: "freeWarmProcess",
    params: { agent: "codex", cwd: "/repo", name: "demo" },
  }))).resolves.toBe('{"id":"free-1","ok":true,"result":{}}\n');

  expect(freeWarmProcess).toHaveBeenCalledTimes(1);
  expect(freeWarmProcess).toHaveBeenCalledWith({
    agent: "codex",
    agentCommand: undefined,
    cwd: "/repo",
    name: "demo",
  });
});
