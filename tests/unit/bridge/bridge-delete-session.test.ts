import { expect, mock, test } from "bun:test";

import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";
import { BridgeServer } from "../../../src/bridge/bridge-server";

test("bridge routes deleteSession to the runtime", async () => {
  const deleteSession = mock(async () => ({}));
  const runtime = {
    shutdown: async () => ({}),
    updatePermissionPolicy: async () => ({}),
    hasSession: async () => ({ exists: true }),
    ensureSession: async () => ({}),
    prompt: async () => ({ text: "ok" }),
    setMode: async () => ({}),
    cancel: async () => ({ cancelled: true, message: "cancelled" }),
    removeSession: async () => ({}),
    deleteSession,
  } as unknown as BridgeRuntime;
  const server = new BridgeServer(runtime);

  await expect(server.handleLine(JSON.stringify({
    id: "del-1",
    method: "deleteSession",
    params: { agent: "codex", cwd: "/repo", name: "demo" },
  }))).resolves.toBe('{"id":"del-1","ok":true,"result":{}}\n');

  expect(deleteSession).toHaveBeenCalledTimes(1);
  expect(deleteSession).toHaveBeenCalledWith({
    agent: "codex",
    agentCommand: undefined,
    cwd: "/repo",
    name: "demo",
  });
});
