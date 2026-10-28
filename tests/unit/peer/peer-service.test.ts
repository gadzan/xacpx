import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PeerService } from "../../../src/peer/peer-service";
import { PeerStore } from "../../../src/peer/peer-store";
import type { ResolvedSession } from "../../../src/transport/types";

function makeSession(alias: string, workspace: string): ResolvedSession {
  return {
    alias,
    agent: "mock",
    workspace,
    transportSession: `${workspace}:${alias}`,
  } as ResolvedSession;
}

interface Harness {
  service: PeerService;
  store: PeerStore;
  promptCalls: Array<{ session: string; text: string }>;
  promptBehavior: (text: string) => Promise<{ text: string }>;
  dir: string;
  cleanup: () => Promise<void>;
}

async function setup(
  promptBehavior?: (text: string) => Promise<{ text: string }>,
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "xacpx-peer-unit-"));
  const store = new PeerStore(join(dir, "peer-requests.json"));
  const promptCalls: Array<{ session: string; text: string }> = [];
  let behavior = promptBehavior ?? (async (text: string) => ({ text: `echo:${text}` }));
  const sessions = new Map<string, ResolvedSession>([
    ["peer-a", makeSession("peer-a", "ws-a")],
    ["peer-b", makeSession("peer-b", "ws-b")],
  ]);
  const service = new PeerService({
    resolveSession: async (key) => sessions.get(key) ?? null,
    promptSession: async (session, text) => {
      promptCalls.push({ session: session.alias, text });
      return await behavior(text);
    },
    store,
  });
  return {
    service,
    store,
    promptCalls,
    get promptBehavior() {
      return behavior;
    },
    set promptBehavior(next) {
      behavior = next;
    },
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("delegate creates needs_confirmation and never executes before approval", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "summarize the module",
    });
    expect(record.status).toBe("needs_confirmation");
    expect(record.requestId.length).toBeGreaterThan(0);
    expect(record.target.workspace).toBe("ws-b");
    expect(h.promptCalls).toHaveLength(0);
  } finally {
    await h.cleanup();
  }
});

test("approve executes, backfills the result, and watch observes terminal", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "summarize the module",
    });
    const running = await h.service.approve({ requestId: record.requestId, approvedBy: "operator" });
    expect(running.status).toBe("running");
    const watched = await h.service.watch({ requestId: record.requestId, timeoutMs: 5000, pollIntervalMs: 20 });
    expect(watched.status).toBe("terminal");
    expect(watched.request.status).toBe("completed");
    expect(watched.request.result).toContain("summarize the module");
    expect(h.promptCalls).toHaveLength(1);
    expect(h.promptCalls[0]?.session).toBe("peer-b");
    expect(h.promptCalls[0]?.text).toContain("Peer delegation from peer-a");
    expect(h.promptCalls[0]?.text).toContain(`request ${record.requestId}`);
    expect(watched.request.targetTransportSession).toBe("ws-b:peer-b");
  } finally {
    await h.cleanup();
  }
});

test("duplicate requestId returns the existing record; reuse for another delegation is rejected", async () => {
  const h = await setup();
  try {
    const first = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "same task",
      requestId: "req-dup",
    });
    const again = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "same task",
      requestId: "req-dup",
    });
    expect(again.requestId).toBe(first.requestId);
    expect(again.status).toBe("needs_confirmation");
    expect(await h.store.list()).toHaveLength(1);
    await expect(
      h.service.delegate({
        originatorAlias: "peer-a",
        targetAlias: "peer-b",
        task: "a different task",
        requestId: "req-dup",
      }),
    ).rejects.toThrow("already used by a different delegation");
    await expect(
      h.service.approve({ requestId: first.requestId, approvedBy: "operator" }),
    ).resolves.toBeDefined();
    await expect(
      h.service.approve({ requestId: first.requestId, approvedBy: "operator" }),
    ).rejects.toThrow("not awaiting approval");
  } finally {
    await h.cleanup();
  }
});

test("completion mismatch is refused: unknown id and non-running record", async () => {
  const h = await setup();
  try {
    await expect(
      h.service.recordCompletion("no-such-id", { result: "x" }),
    ).rejects.toThrow("not found");
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await expect(
      h.service.recordCompletion(record.requestId, { result: "x" }),
    ).rejects.toThrow("is not running");
  } finally {
    await h.cleanup();
  }
});

test("watch timeout ends only the watch; the request keeps running", async () => {
  let release!: (value: { text: string }) => void;
  const pending = new Promise<{ text: string }>((resolve) => {
    release = resolve;
  });
  const h = await setup(() => pending);
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "slow task",
    });
    await h.service.approve({ requestId: record.requestId, approvedBy: "operator" });
    const watched = await h.service.watch({ requestId: record.requestId, timeoutMs: 200, pollIntervalMs: 20 });
    expect(watched.status).toBe("timeout");
    expect(watched.request.status).toBe("running");
    release({ text: "done late" });
    const later = await h.service.watch({ requestId: record.requestId, timeoutMs: 5000, pollIntervalMs: 20 });
    expect(later.status).toBe("terminal");
    expect(later.request.status).toBe("completed");
    expect(later.request.result).toBe("done late");
  } finally {
    await h.cleanup();
  }
});

test("confirm requires completed status and the originator", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await expect(
      h.service.confirm({ requestId: record.requestId, originatorAlias: "peer-a" }),
    ).rejects.toThrow("only a completed peer request can be confirmed");
    await h.service.approve({ requestId: record.requestId, approvedBy: "operator" });
    const watched = await h.service.watch({ requestId: record.requestId, timeoutMs: 5000, pollIntervalMs: 20 });
    expect(watched.request.status).toBe("completed");
    await expect(
      h.service.confirm({ requestId: record.requestId, originatorAlias: "peer-b" }),
    ).rejects.toThrow("only the originator can confirm");
    const delivered = await h.service.confirm({ requestId: record.requestId, originatorAlias: "peer-a" });
    expect(delivered.status).toBe("delivered");
    expect(delivered.deliveredAt).toBeDefined();
  } finally {
    await h.cleanup();
  }
});

test("failed execution backfills a sanitized error", async () => {
  const h = await setup(async () => {
    throw new Error("boom\nat somewhere (stack.ts:1:1)");
  });
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await h.service.approve({ requestId: record.requestId, approvedBy: "operator" });
    const watched = await h.service.watch({ requestId: record.requestId, timeoutMs: 5000, pollIntervalMs: 20 });
    expect(watched.request.status).toBe("failed");
    expect(watched.request.error).toContain("boom");
    expect(watched.request.error).not.toContain("at somewhere");
  } finally {
    await h.cleanup();
  }
});

test("self-delegation, unknown target, and workspace mismatch are rejected", async () => {
  const h = await setup();
  try {
    await expect(
      h.service.delegate({ originatorAlias: "peer-a", targetAlias: "peer-a", task: "t" }),
    ).rejects.toThrow("to self is not allowed");
    await expect(
      h.service.delegate({ originatorAlias: "peer-a", targetAlias: "ghost", task: "t" }),
    ).rejects.toThrow("not found");
    await expect(
      h.service.delegate({
        originatorAlias: "peer-a",
        targetAlias: "peer-b",
        targetWorkspace: "ws-other",
        task: "t",
      }),
    ).rejects.toThrow("not \"ws-other\"");
  } finally {
    await h.cleanup();
  }
});

test("records survive a store reload (daemon restart)", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await h.service.approve({ requestId: record.requestId, approvedBy: "operator" });
    await h.service.watch({ requestId: record.requestId, timeoutMs: 5000, pollIntervalMs: 20 });
    const reloadedStore = new PeerStore(join(h.dir, "peer-requests.json"));
    const reloadedService = new PeerService({
      resolveSession: async () => null,
      promptSession: async () => ({ text: "" }),
      store: reloadedStore,
    });
    const found = await reloadedService.get(record.requestId);
    expect(found?.status).toBe("completed");
    expect(found?.result).toContain("t");
  } finally {
    await h.cleanup();
  }
});
