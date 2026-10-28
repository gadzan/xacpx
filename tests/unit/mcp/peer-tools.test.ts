import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildXacpxMcpToolRegistry } from "../../../src/mcp/xacpx-mcp-tools";
import { createMemoryTransport } from "../../../src/mcp/xacpx-mcp-transport";
import { PeerService } from "../../../src/peer/peer-service";
import { PeerStore } from "../../../src/peer/peer-store";
import type { ResolvedSession } from "../../../src/transport/types";

async function setupService(
  promptBehavior?: (session: ResolvedSession, text: string) => Promise<{ text: string }>,
) {
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
      return promptBehavior ? promptBehavior(session, text) : { text: `echo:${text}` };
    },
    store,
  });
  return {
    service,
    promptCalls,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function toolText(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("\n");
}

test("peer tools are registered and delegate stays unexecuted until approve", async () => {
  // The second delegation's turn must stay in flight while cancel is tested:
  // an immediately-returning prompt would race cancel against completion.
  let releaseSecond!: (value: { text: string }) => void;
  const secondPending = new Promise<{ text: string }>((resolve) => {
    releaseSecond = resolve;
  });
  const h = await setupService(async (_session, text) => {
    if (text.includes("req-tools-2")) return secondPending;
    return { text: `echo:${text}` };
  });
  try {
    const transport = createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        peerDelegate: async (input) => h.service.delegate(input),
        peerApprove: async (input) => h.service.approve(input),
        peerWatch: async (input) => h.service.watch(input),
        peerConfirm: async (input) => h.service.confirm(input),
        peerCancel: async (input) => h.service.cancel(input),
        peerList: async (input) => h.service.list(input),
        peerGet: async (input) => h.service.get(input),
      },
    );
    const registry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
    });
    const names = registry.map((tool) => tool.name);
    for (const name of [
      "peer_delegate",
      "peer_approve",
      "peer_watch",
      "peer_confirm",
      "peer_cancel",
      "peer_list",
      "peer_get",
    ]) {
      expect(names).toContain(name);
    }
    // peer_message must NOT exist: message exchange reuses agent_send.
    expect(names).not.toContain("peer_message");

    const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
    const approveTool = registry.find((tool) => tool.name === "peer_approve")!;
    const watchTool = registry.find((tool) => tool.name === "peer_watch")!;
    const confirmTool = registry.find((tool) => tool.name === "peer_confirm")!;
    const cancelTool = registry.find((tool) => tool.name === "peer_cancel")!;
    const listTool = registry.find((tool) => tool.name === "peer_list")!;
    const getTool = registry.find((tool) => tool.name === "peer_get")!;

    const created = await delegateTool.handler({
      targetAlias: "peer-b",
      task: "review the module",
      requestId: "req-tools-1",
    });
    expect(created.structuredContent).toMatchObject({
      requestId: "req-tools-1",
      status: "needs_confirmation",
    });
    expect(toolText(created)).toContain("agent_list");
    expect(h.promptCalls).toHaveLength(0);

    const approved = await approveTool.handler({ requestId: "req-tools-1" });
    expect(approved.structuredContent).toMatchObject({ status: "running" });
    const watched = await watchTool.handler({ requestId: "req-tools-1", timeoutMs: 5000, pollIntervalMs: 20 });
    expect(watched.structuredContent).toMatchObject({ status: "terminal" });
    expect(
      (watched.structuredContent as { request: { result: string } }).request.result,
    ).toContain("review the module");
    expect(toolText(watched)).toContain("review the module");
    expect(toolText(watched)).toContain("peer_confirm");
    const confirmed = await confirmTool.handler({ requestId: "req-tools-1" });
    expect(confirmed.structuredContent).toMatchObject({ status: "delivered" });

    // Cancel + query tools on a second delegation.
    await delegateTool.handler({
      targetAlias: "peer-b",
      task: "second task",
      requestId: "req-tools-2",
    });
    await approveTool.handler({ requestId: "req-tools-2" });
    const cancelled = await cancelTool.handler({ requestId: "req-tools-2" });
    expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });
    expect(toolText(cancelled)).toContain("does not stop the target's turn");
    expect(toolText(cancelled)).toContain("new requestId");
    const watchedCancelled = await watchTool.handler({
      requestId: "req-tools-2",
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });
    expect(watchedCancelled.structuredContent).toMatchObject({ status: "terminal" });
    expect(toolText(watchedCancelled)).toContain("cancelled");
    expect(toolText(watchedCancelled)).toContain("new requestId");

    const listed = await listTool.handler({});
    expect(toolText(listed)).toContain("req-tools-1");
    expect(toolText(listed)).toContain("req-tools-2");
    const listedCancelled = await listTool.handler({ status: "cancelled" });
    expect(toolText(listedCancelled)).toContain("req-tools-2");
    expect(toolText(listedCancelled)).not.toContain("req-tools-1");
    const got = await getTool.handler({ requestId: "req-tools-1" });
    expect(toolText(got)).toContain("delivered");
    expect(toolText(got)).toContain("review the module");
    const missing = await getTool.handler({ requestId: "req-tools-nope" });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("not found");
  } finally {
    releaseSecond({ text: "late" });
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
  expect(JSON.stringify(result)).toContain("not connected to a daemon");
});

test("peer tools report the same actionable error from the default memory stub", async () => {
  const transport = createMemoryTransport(async () => ({
    taskId: "task-1",
    status: "needs_confirmation",
  }));
  const registry = buildXacpxMcpToolRegistry({
    transport,
    coordinatorSession: "ws-a:peer-a",
    sourceHandle: "peer-a",
  });
  const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
  const result = await delegateTool.handler({ targetAlias: "peer-b", task: "t" });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("not connected to a daemon");
  expect(JSON.stringify(result)).toContain("docs/peer-delegation.md");
});

test("watch text carries a truncated result with an explicit note", async () => {
  const h = await setupService();
  try {
    const transport = createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        peerDelegate: async (input) => h.service.delegate(input),
        peerApprove: async (input) => h.service.approve(input),
        peerWatch: async (input) => h.service.watch(input),
      },
    );
    const registry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
    });
    const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
    const approveTool = registry.find((tool) => tool.name === "peer_approve")!;
    const watchTool = registry.find((tool) => tool.name === "peer_watch")!;
    const longTask = "x".repeat(20000);
    await delegateTool.handler({
      targetAlias: "peer-b",
      task: longTask,
      requestId: "req-tools-long",
    });
    await approveTool.handler({ requestId: "req-tools-long" });
    const watched = await watchTool.handler({
      requestId: "req-tools-long",
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });
    expect(
      (watched.structuredContent as { request: { resultTruncated: boolean } }).request
        .resultTruncated,
    ).toBe(true);
    expect(toolText(watched)).toContain("truncated to 16 KiB");
    expect(toolText(watched)).toContain("x".repeat(100));
  } finally {
    await h.cleanup();
  }
});

test("watch failed text gives a next step distinct from a resend", async () => {
  const h = await setupService(async () => {
    throw new Error("target exploded");
  });
  try {
    const transport = createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        peerDelegate: async (input) => h.service.delegate(input),
        peerApprove: async (input) => h.service.approve(input),
        peerWatch: async (input) => h.service.watch(input),
      },
    );
    const registry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
    });
    const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
    const approveTool = registry.find((tool) => tool.name === "peer_approve")!;
    const watchTool = registry.find((tool) => tool.name === "peer_watch")!;
    await delegateTool.handler({
      targetAlias: "peer-b",
      task: "doomed task",
      requestId: "req-tools-fail",
    });
    await approveTool.handler({ requestId: "req-tools-fail" });
    const watched = await watchTool.handler({
      requestId: "req-tools-fail",
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });
    expect(toolText(watched)).toContain("target exploded");
    expect(toolText(watched)).toContain("new requestId");
    expect(toolText(watched)).toContain("not a resend");
  } finally {
    await h.cleanup();
  }
});

test("watch timeout on an unapproved request says it is still waiting for approval", async () => {
  const h = await setupService();
  try {
    const transport = createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        peerDelegate: async (input) => h.service.delegate(input),
        peerWatch: async (input) => h.service.watch(input),
      },
    );
    const registry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
    });
    const delegateTool = registry.find((tool) => tool.name === "peer_delegate")!;
    const watchTool = registry.find((tool) => tool.name === "peer_watch")!;
    await delegateTool.handler({
      targetAlias: "peer-b",
      task: "waiting task",
      requestId: "req-tools-wait",
    });
    const watched = await watchTool.handler({
      requestId: "req-tools-wait",
      timeoutMs: 100,
      pollIntervalMs: 20,
    });
    expect(watched.structuredContent).toMatchObject({ status: "timeout" });
    expect(toolText(watched)).toContain("needs_confirmation");
    expect(toolText(watched)).toContain("waiting for approval");
  } finally {
    await h.cleanup();
  }
});

test("a worker-bound caller cannot approve, and sees only its related view", async () => {
  const h = await setupService();
  try {
    const transport = createMemoryTransport(
      async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      {
        peerDelegate: async (input) => h.service.delegate(input),
        peerApprove: async (input) => h.service.approve(input),
        peerWatch: async (input) => h.service.watch(input),
        peerConfirm: async (input) => h.service.confirm(input),
        peerCancel: async (input) => h.service.cancel(input),
        peerList: async (input) => h.service.list(input),
        peerGet: async (input) => h.service.get(input),
      },
    );
    const workerRegistry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
      sourceHandle: "worker:review",
    });
    const coordinatorRegistry = buildXacpxMcpToolRegistry({
      transport,
      coordinatorSession: "ws-a:peer-a",
    });
    const workerDelegate = workerRegistry.find((tool) => tool.name === "peer_delegate")!;
    const workerApprove = workerRegistry.find((tool) => tool.name === "peer_approve")!;
    const workerList = workerRegistry.find((tool) => tool.name === "peer_list")!;
    const workerGet = workerRegistry.find((tool) => tool.name === "peer_get")!;
    const coordinatorDelegate = coordinatorRegistry.find((tool) => tool.name === "peer_delegate")!;

    await workerDelegate.handler({
      targetAlias: "peer-b",
      task: "worker task",
      requestId: "req-tools-worker",
    });
    await coordinatorDelegate.handler({
      targetAlias: "peer-b",
      task: "coordinator task",
      requestId: "req-tools-coord",
    });

    // The worker originated req-tools-worker but still cannot approve it:
    // only the recorded coordinator can.
    const denied = await workerApprove.handler({ requestId: "req-tools-worker" });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("only the record's coordinator");

    // And the worker's list is the related view: its own delegation only,
    // not the coordinator's unrelated one.
    const listed = await workerList.handler({});
    expect(toolText(listed)).toContain("req-tools-worker");
    expect(toolText(listed)).not.toContain("req-tools-coord");

    // Same story for get: the worker reads its own delegation, but the
    // coordinator's unrelated one looks exactly like an unknown id.
    const own = await workerGet.handler({ requestId: "req-tools-worker" });
    expect(own.isError).not.toBe(true);
    expect(toolText(own)).toContain("worker task");
    const hidden = await workerGet.handler({ requestId: "req-tools-coord" });
    expect(hidden.isError).toBe(true);
    expect(JSON.stringify(hidden)).toContain("not found");
  } finally {
    await h.cleanup();
  }
});
