import { expect, test } from "bun:test";

import { createQueueOwnerAdapterContext } from "../../../src/transport/queue-owner-adapter-context";

const TOKEN = "11111111-1111-4111-8111-111111111111";

test("Windows context reuses the same token in every daemon RPC and fences the acknowledged generation", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const context = createQueueOwnerAdapterContext({
    id: "codex",
    sessionKey: "logical",
    agentCommand: "old-command",
    platform: "win32",
    launcherIdentity: async () => ({ pid: 44, creationDate: "123456" }),
    requestDaemon: async (method, params) => {
      calls.push({ method, params });
      if (method === "registerAdapterIntent") {
        return { agentCommand: "new-command", intentToken: TOKEN, generationId: "generation-1" };
      }
      return {};
    },
    readCurrentGeneration: async () => "generation-1",
  });
  expect(await context.prepare(TOKEN)).toEqual({ agentCommand: "new-command", generationId: "generation-1" });
  expect(await context.isGenerationCurrent("generation-1")).toBe(true);
  await context.spawned(TOKEN);
  await context.settle({ intentToken: TOKEN, outcome: "owner-committed", ownerPid: 55, ownerAcpxRecordId: "record" });
  expect(calls.map((item) => item.method)).toEqual(["registerAdapterIntent", "launcherSpawned", "launchSettled"]);
  expect(calls.every((item) => item.params.intentToken === TOKEN)).toBe(true);
  expect(calls[0]!.params).toMatchObject({ launcherPid: 44, launcherCreationDate: "123456" });
});

test("Unix context sends only resolveAdapterCommand and rejects token-shaped registration fields", async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const context = createQueueOwnerAdapterContext({
    id: "claude",
    sessionKey: "logical",
    agentCommand: "old-command",
    platform: "linux",
    launcherIdentity: async () => { throw new Error("must not query launcher"); },
    requestDaemon: async (method, params) => {
      calls.push({ method, params });
      return { agentCommand: "new-command" };
    },
    readCurrentGeneration: async () => null,
  });
  expect(await context.prepare(TOKEN)).toEqual({ agentCommand: "new-command" });
  expect(calls).toEqual([{
    method: "resolveAdapterCommand",
    params: { id: "claude", sessionKey: "logical", agentCommand: "old-command" },
  }]);
});
