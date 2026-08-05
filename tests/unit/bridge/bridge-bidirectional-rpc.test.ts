import { expect, test } from "bun:test";

import { BridgeServer } from "../../../src/bridge/bridge-server";
import { AcpxBridgeClient } from "../../../src/transport/acpx-bridge/acpx-bridge-client";

test("bridge-originated requests interleave with ordinary responses and replay duplicate ids", async () => {
  const writes: string[] = [];
  const calls: string[] = [];
  let launcherPid: number | undefined;
  const client = new AcpxBridgeClient((line) => { writes.push(line); }, {
    bridgeProcessPid: 4321,
    onBridgeRequest: async (method, params, context) => {
      calls.push(`${method}:${String(params.sessionKey)}`);
      launcherPid = context.launcherPid;
      return { agentCommand: "resolved" };
    },
  });
  const ping = client.request("ping", {});
  const request = JSON.stringify({
    direction: "bridge-to-daemon",
    rpcId: "bridge:7",
    method: "resolveAdapterCommand",
    params: { id: "launch-1", sessionKey: "s", agentCommand: "old" },
  });
  client.handleLine(request);
  await Promise.resolve();
  await Promise.resolve();
  client.handleLine(JSON.stringify({ id: "1", event: "session.progress", stage: "ready" }));
  client.handleLine(JSON.stringify({ id: "1", ok: true, result: { pong: true } }));
  await expect(ping).resolves.toEqual({ pong: true });
  client.handleLine(request);
  expect(calls).toEqual(["resolveAdapterCommand:s"]);
  expect(launcherPid).toBe(4321);
  expect(writes.filter((line) => line.includes('"rpcId":"bridge:7"'))).toHaveLength(2);
});

test("daemon side cancellation aborts an active bridge request", async () => {
  const writes: string[] = [];
  const client = new AcpxBridgeClient((line) => { writes.push(line); }, {
    onBridgeRequest: async (_method, _params, { signal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by bridge")), { once: true });
      });
    },
  });
  client.handleLine(JSON.stringify({
    direction: "bridge-to-daemon",
    rpcId: "bridge:8",
    method: "resolveAdapterCommand",
    params: { id: "launch-2", sessionKey: "s", agentCommand: "old" },
  }));
  client.handleLine(JSON.stringify({ direction: "bridge-to-daemon", cancelRpcId: "bridge:8" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(writes.some((line) => line.includes("BRIDGE_RPC_CANCELED"))).toBe(true);
});

test("bridge requester routes responses, suppresses late duplicates, times out with cancel, and rejects disconnect", async () => {
  const writes: string[] = [];
  const server = new BridgeServer({} as never, 5);
  await server.handleLine(JSON.stringify({ id: "daemon:1", method: "ping", params: {} }), (line) => writes.push(line));

  const first = server.requestDaemon<{ ok: boolean }>("resolveAdapterCommand", { sessionKey: "s" });
  const firstRequest = JSON.parse(writes.at(-1)!);
  expect(firstRequest.rpcId).toBe("bridge:1");
  expect(await server.handleLine(JSON.stringify({
    direction: "daemon-to-bridge", rpcId: "bridge:1", ok: true, result: { ok: true },
  }))).toBeNull();
  await expect(first).resolves.toEqual({ ok: true });
  // A duplicate/late response has no effect and produces no protocol response.
  expect(await server.handleLine(JSON.stringify({
    direction: "daemon-to-bridge", rpcId: "bridge:1", ok: true, result: { ok: false },
  }))).toBeNull();

  const timedOut = server.requestDaemon("registerAdapterIntent", {});
  await expect(timedOut).rejects.toThrow("timed out");
  expect(writes.some((line) => line.includes('"cancelRpcId":"bridge:2"'))).toBe(true);

  const disconnected = server.requestDaemon("launcherSpawned", {});
  server.handleDisconnect(new Error("gone"));
  await expect(disconnected).rejects.toThrow("gone");
});

test("caller abort sends a cancel and a malformed daemon response cannot settle the request", async () => {
  const writes: string[] = [];
  const server = new BridgeServer({} as never, 1_000);
  await server.handleLine(JSON.stringify({ id: "daemon:1", method: "ping", params: {} }), (line) => writes.push(line));
  const controller = new AbortController();
  const pending = server.requestDaemon("launchSettled", {}, { signal: controller.signal });
  const malformed = await server.handleLine(JSON.stringify({
    direction: "daemon-to-bridge", rpcId: "bridge:1", ok: false, error: {},
  }));
  expect(malformed).not.toBeNull();
  controller.abort(new Error("caller canceled"));
  await expect(pending).rejects.toThrow("caller canceled");
  expect(writes.some((line) => line.includes('"cancelRpcId":"bridge:1"'))).toBe(true);
});
