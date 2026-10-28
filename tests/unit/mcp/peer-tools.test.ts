import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildXacpxMcpToolRegistry } from "../../../src/mcp/xacpx-mcp-tools";
import { createMemoryTransport } from "../../../src/mcp/xacpx-mcp-transport";
import { PeerService } from "../../../src/peer/peer-service";
import { PeerStore } from "../../../src/peer/peer-store";
import type { ResolvedSession } from "../../../src/transport/types";

async function setupService() {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-peer-tools-"));
  const store = new PeerStore(join(dir, "peer-requests.json"));
  const promptCalls: string[] = [];
  const sessions = new Map<string, ResolvedSession>([
    ["peer-a", { alias: "peer-a", agent: "mock", workspace: "ws-a", transportSession: "ws-a:peer-a" } as ResolvedSession],
    ["peer-b", { alias: "peer-b", agent: "mock", workspace: "ws-b", transportSession: "ws-b:peer-b" } as ResolvedSession],
  ]);
  const service = new PeerService({
    resolveSession: async (key) => sessions.get(key) ?? null,
    promptSession: async (session, text) => {
      promptCalls.push(`${session.alias}:${text}`);
      return { text: `echo:${text}` };
    },
    store,
  });
  return {
    service,
    promptCalls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("peer tools are registered and delegate stays unexecuted until approve", async () => {
  const h = await setupService();
  try {
    const transport = createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        peerDelegate: async (input) => h.service.delegate(input),
        peerApprove: async (input) => h.service.approve(input),
        peerWatch: async (input) => h.service.watch(input),
        peerConfirm: async (input) => h.service.confirm(input),
      },
    );
    const registry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
      sourceHandle: "peer-a",
    });
    const names = registry.map((tool) => tool.name);
    for (const name of ["peer_delegate", "peer_approve", "peer_watch", "peer_confirm"]) {
      expect(names).toContain(name);
    }
    // peer_message must NOT exist: message exchange reuses agent_send.
    expect(names).not.toContain("peer_message");

    const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
    const approveTool = registry.find((tool) => tool.name === "peer_approve")!;
    const watchTool = registry.find((tool) => tool.name === "peer_watch")!;
    const confirmTool = registry.find((tool) => tool.name === "peer_confirm")!;

    const created = await delegateTool.handler({
      targetAlias: "peer-b",
      task: "review the module",
      requestId: "req-tools-1",
    });
    expect(created.structuredContent).toMatchObject({
      requestId: "req-tools-1",
      status: "needs_confirmation",
    });
    expect(h.promptCalls).toHaveLength(0);

    const approved = await approveTool.handler({ requestId: "req-tools-1" });
    expect(approved.structuredContent).toMatchObject({ status: "running" });
    const watched = await watchTool.handler({ requestId: "req-tools-1", timeoutMs: 5000, pollIntervalMs: 20 });
    expect(watched.structuredContent).toMatchObject({ status: "terminal" });
    expect(
      (watched.structuredContent as { request: { result: string } }).request.result,
    ).toContain("review the module");
    const confirmed = await confirmTool.handler({ requestId: "req-tools-1" });
    expect(confirmed.structuredContent).toMatchObject({ status: "delivered" });
  } finally {
    await h.cleanup();
  }
});

test("peer tools throw when no peer transport is bound", async () => {
  const transport = createMemoryTransport(async () => ({
    taskId: "task-1",
    status: "needs_confirmation",
  }));
  // Simulate a transport with no peer binding at all (not even the memory
  // stub): the tool guard must throw instead of advertising a dead call.
  delete (transport as Partial<typeof transport>).peerDelegate;
  const registry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "ws-a:peer-a",
    sourceHandle: "peer-a",
  });
  const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
  const result = await delegateTool.handler({ targetAlias: "peer-b", task: "t" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("requires a bound peer transport");
});
