import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PeerService } from "../../../src/peer/peer-service";
import { PeerStore } from "../../../src/peer/peer-store";
import type { PeerRequest } from "../../../src/peer/peer-types";
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
      coordinatorSession: "ws-a:peer-a",
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
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "summarize the module",
    });
    const running = await h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
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
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "same task",
      requestId: "req-dup",
    });
    const again = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
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
        coordinatorSession: "ws-a:peer-a",
        targetAlias: "peer-b",
        task: "a different task",
        requestId: "req-dup",
      }),
    ).rejects.toThrow("already used by a different delegation");
    await expect(
      h.service.approve({ requestId: first.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" }),
    ).resolves.toBeDefined();
    await expect(
      h.service.approve({ requestId: first.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" }),
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
      coordinatorSession: "ws-a:peer-a",
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
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "slow task",
    });
    await h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
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
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await expect(
      h.service.confirm({ requestId: record.requestId, originatorAlias: "peer-a" }),
    ).rejects.toThrow("only a completed peer request can be confirmed");
    await h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
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
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
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
      h.service.delegate({ originatorAlias: "peer-a", coordinatorSession: "ws-a:peer-a", targetAlias: "peer-a", task: "t" }),
    ).rejects.toThrow("to self is not allowed");
    await expect(
      h.service.delegate({ originatorAlias: "peer-a", coordinatorSession: "ws-a:peer-a", targetAlias: "ghost", task: "t" }),
    ).rejects.toThrow("not found");
    await expect(
      h.service.delegate({
        originatorAlias: "peer-a",
        coordinatorSession: "ws-a:peer-a",
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
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
    await h.service.watch({ requestId: record.requestId, timeoutMs: 5000, pollIntervalMs: 20 });
    const reloadedStore = new PeerStore(join(h.dir, "peer-requests.json"));
    const reloadedService = new PeerService({
      resolveSession: async () => null,
      promptSession: async () => ({ text: "" }),
      store: reloadedStore,
    });
    const found = await reloadedService.get({ requestId: record.requestId, callerAlias: "peer-a" });
    expect(found?.status).toBe("completed");
    expect(found?.result).toContain("t");
  } finally {
    await h.cleanup();
  }
});

test("approve records the binding-derived approver and rejects target self-approval", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await expect(
      h.service.approve({ requestId: record.requestId, approverAlias: "peer-b", coordinatorSession: "ws-a:peer-a" }),
    ).rejects.toThrow("cannot approve a delegation addressed to itself");
    const running = await h.service.approve({
      requestId: record.requestId,
      approverAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(running.status).toBe("running");
    expect(running.approvedBy).toBe("ws-a:peer-a");
    await expect(
      h.service.approve({ requestId: record.requestId, approverAlias: "", coordinatorSession: "ws-a:peer-a" }),
    ).rejects.toThrow("not awaiting approval");
  } finally {
    await h.cleanup();
  }
});

test("cancel is originator-only, running-or-pending, and watch reports cancelled", async () => {
  let release!: (value: { text: string }) => void;
  const pending = new Promise<{ text: string }>((resolve) => {
    release = resolve;
  });
  const h = await setup(() => pending);
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    // Withdrawing a still-unapproved request succeeds (it never executed),
    // and a withdrawn request can no longer be approved.
    const withdrawn = await h.service.cancel({
      requestId: record.requestId,
      originatorAlias: "peer-a",
    });
    expect(withdrawn.status).toBe("cancelled");
    await expect(
      h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" }),
    ).rejects.toThrow("not awaiting approval");
    const record2 = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t2",
      requestId: "req-cancel-running",
    });
    await h.service.approve({ requestId: record2.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
    await expect(
      h.service.cancel({ requestId: record2.requestId, originatorAlias: "peer-b" }),
    ).rejects.toThrow("only the originator can cancel");
    const cancelled = await h.service.cancel({
      requestId: record2.requestId,
      originatorAlias: "peer-a",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBeDefined();
    const watched = await h.service.watch({
      requestId: record2.requestId,
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });
    expect(watched.status).toBe("terminal");
    expect(watched.request.status).toBe("cancelled");
    await expect(
      h.service.cancel({ requestId: record2.requestId, originatorAlias: "peer-a" }),
    ).rejects.toThrow("only a running or unapproved peer request can be cancelled");
  } finally {
    release({ text: "late" });
    await h.cleanup();
  }
});

test("a late completion never overwrites a cancellation", async () => {
  let release!: (value: { text: string }) => void;
  const pending = new Promise<{ text: string }>((resolve) => {
    release = resolve;
  });
  const h = await setup(() => pending);
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "slow task",
    });
    await h.service.approve({ requestId: record.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
    await h.service.cancel({ requestId: record.requestId, originatorAlias: "peer-a" });
    release({ text: "done late" });
    // Give the background execution a chance to attempt its backfill.
    await Bun.sleep(100);
    const after = await h.service.get({ requestId: record.requestId, callerAlias: "peer-a" });
    expect(after?.status).toBe("cancelled");
    expect(after?.result).toBeUndefined();
    expect(h.promptCalls).toHaveLength(1);
  } finally {
    await h.cleanup();
  }
});

test("listRelated returns caller-related delegations with optional status filter", async () => {
  const h = await setup();
  try {
    const ab = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "a to b",
      requestId: "req-list-ab",
    });
    await h.service.delegate({
      originatorAlias: "peer-b",
      coordinatorSession: "ws-b:peer-b",
      targetAlias: "peer-a",
      task: "b to a",
      requestId: "req-list-ba",
    });
    const forA = await h.service.listRelated("peer-a");
    expect(forA.map((r) => r.requestId).sort()).toEqual(["req-list-ab", "req-list-ba"]);
    const forGhost = await h.service.listRelated("ghost");
    expect(forGhost).toHaveLength(0);
    await h.service.approve({ requestId: ab.requestId, approverAlias: "ws-a:peer-a", coordinatorSession: "ws-a:peer-a" });
    const runningForA = await h.service.listRelated("peer-a", { status: "running" });
    expect(runningForA.map((r) => r.requestId)).toEqual(["req-list-ab"]);
    const pendingForB = await h.service.listRelated("peer-b", {
      status: "needs_confirmation",
    });
    expect(pendingForB.map((r) => r.requestId)).toEqual(["req-list-ba"]);
  } finally {
    await h.cleanup();
  }
});

test("a corrupted store file fails with a clear recovery message", async () => {
  const h = await setup();
  try {
    const file = join(h.dir, "peer-requests.json");
    await writeFile(file, "{not json", "utf8");
    await expect(h.service.listRelated("peer-a")).rejects.toThrow(
      "Peer request store is corrupted",
    );
    await expect(h.service.listRelated("peer-a")).rejects.toThrow(
      "move this file aside",
    );
    await writeFile(file, JSON.stringify({ not: "an array" }), "utf8");
    await expect(h.service.get({ requestId: "whatever", callerAlias: "peer-a" })).rejects.toThrow(
      "Peer request store is corrupted",
    );
  } finally {
    await h.cleanup();
  }
});

test("delegate requires a non-empty coordinatorSession", async () => {
  const h = await setup();
  try {
    await expect(
      h.service.delegate({
        originatorAlias: "peer-a",
        coordinatorSession: "",
        targetAlias: "peer-b",
        task: "t",
      }),
    ).rejects.toThrow("requires a non-empty coordinatorSession");
    await expect(
      h.service.delegate({
        originatorAlias: "peer-a",
        coordinatorSession: "   ",
        targetAlias: "peer-b",
        task: "t",
      }),
    ).rejects.toThrow("requires a non-empty coordinatorSession");
  } finally {
    await h.cleanup();
  }
});

test("only the record's coordinator can approve; a non-coordinator is rejected", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await expect(
      h.service.approve({
        requestId: record.requestId,
        approverAlias: "someone-else",
        coordinatorSession: "ws-a:peer-a",
      }),
    ).rejects.toThrow("only the record's coordinator can approve");
    await expect(
      h.service.approve({
        requestId: record.requestId,
        approverAlias: "ws-a:peer-a",
        coordinatorSession: "ws-other:peer-x",
      }),
    ).rejects.toThrow("only the record's coordinator can approve");
    const running = await h.service.approve({
      requestId: record.requestId,
      approverAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(running.status).toBe("running");
  } finally {
    await h.cleanup();
  }
});

test("a coordinator still approves after /clear rotated its transport name", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    const running = await h.service.approve({
      requestId: record.requestId,
      approverAlias: "ws-a:peer-a:reset-123456",
      coordinatorSession: "ws-a:peer-a:reset-123456",
    });
    expect(running.status).toBe("running");
    expect(running.approvedBy).toBe("ws-a:peer-a:reset-123456");
  } finally {
    await h.cleanup();
  }
});

test("a worker originator cannot approve its own delegation", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "worker:review",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    await expect(
      h.service.approve({
        requestId: record.requestId,
        approverAlias: "worker:review",
        coordinatorSession: "ws-a:peer-a",
      }),
    ).rejects.toThrow("only the record's coordinator can approve");
    // The coordinator itself can still approve the worker's delegation.
    const running = await h.service.approve({
      requestId: record.requestId,
      approverAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(running.status).toBe("running");
  } finally {
    await h.cleanup();
  }
});

test("a coordinator originator may approve its own delegation", async () => {
  const h = await setup();
  try {
    // Distinct from "a worker originator cannot approve its own
    // delegation": here the originator IS the coordinator session, so
    // approving is the operator approving, not a worker self-approving.
    const record = await h.service.delegate({
      originatorAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    const running = await h.service.approve({
      requestId: record.requestId,
      approverAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(running.status).toBe("running");
  } finally {
    await h.cleanup();
  }
});

test("a record without a coordinator fails closed on approve", async () => {
  const h = await setup();
  try {
    const legacy: PeerRequest = {
      requestId: "req-legacy",
      originator: { alias: "peer-a" },
      target: { alias: "peer-b", workspace: "ws-b" },
      task: "t",
      status: "needs_confirmation",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    await h.store.upsert(legacy);
    await expect(
      h.service.approve({
        requestId: "req-legacy",
        approverAlias: "ws-a:peer-a",
        coordinatorSession: "ws-a:peer-a",
      }),
    ).rejects.toThrow("has no recorded coordinator");
  } finally {
    await h.cleanup();
  }
});

test("an empty approver is rejected on a fresh needs_confirmation record", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    // Previous coverage only hit this guard's shadow: an already-approved
    // record rejects on status first. A fresh record must reach the
    // empty-identity guard itself.
    await expect(
      h.service.approve({
        requestId: record.requestId,
        approverAlias: "   ",
        coordinatorSession: "ws-a:peer-a",
      }),
    ).rejects.toThrow("binding-derived approver identity");
    await expect(
      h.service.approve({
        requestId: record.requestId,
        approverAlias: "ws-a:peer-a",
        coordinatorSession: "   ",
      }),
    ).rejects.toThrow("binding-derived coordinatorSession");
  } finally {
    await h.cleanup();
  }
});

test("list splits coordinator view from worker related view", async () => {
  const h = await setup();
  try {
    const stamp = "2026-10-01T00:00:00.000Z";
    const fixture = (
      requestId: string,
      originator: string,
      target: string,
      coordinator: string | undefined,
      status: PeerRequest["status"],
    ): PeerRequest => ({
      requestId,
      originator: { alias: originator },
      target: { alias: target },
      ...(coordinator !== undefined ? { coordinator } : {}),
      task: "t",
      status,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await h.store.upsert(fixture("req-coord-a", "peer-a", "peer-b", "ws-a:peer-a", "needs_confirmation"));
    await h.store.upsert(fixture("req-coord-b", "peer-b", "peer-a", "ws-b:peer-b", "running"));
    await h.store.upsert(fixture("req-coord-c", "peer-c", "peer-d", "ws-a:peer-a", "completed"));
    await h.store.upsert(fixture("req-legacy", "peer-a", "peer-b", undefined, "needs_confirmation"));

    // Coordinator view: everything in scope, even delegations the
    // coordinator neither originated nor is targeted by; the legacy
    // coordinator-less record stays out.
    const coordView = await h.service.list({
      callerAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(coordView.map((r) => r.requestId).sort()).toEqual(["req-coord-a", "req-coord-c"]);
    const coordPending = await h.service.list({
      callerAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
      status: "needs_confirmation",
    });
    expect(coordPending.map((r) => r.requestId)).toEqual(["req-coord-a"]);

    // Worker view is unchanged: only related records, including the
    // legacy coordinator-less one where the worker is involved.
    const workerView = await h.service.list({
      callerAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(workerView.map((r) => r.requestId).sort()).toEqual([
      "req-coord-a",
      "req-coord-b",
      "req-legacy",
    ]);
    // listRelated itself is untouched by the split.
    expect((await h.service.listRelated("peer-a")).map((r) => r.requestId).sort()).toEqual([
      "req-coord-a",
      "req-coord-b",
      "req-legacy",
    ]);
  } finally {
    await h.cleanup();
  }
});

test("get admits party or coordinator, and hides records from anyone else", async () => {
  const h = await setup();
  try {
    const stamp = "2026-10-01T00:00:00.000Z";
    const fixture = (
      requestId: string,
      originator: string,
      target: string,
      coordinator: string | undefined,
      status: PeerRequest["status"],
    ): PeerRequest => ({
      requestId,
      originator: { alias: originator },
      target: { alias: target },
      ...(coordinator !== undefined ? { coordinator } : {}),
      task: "t",
      status,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await h.store.upsert(fixture("req-get-a", "peer-a", "peer-b", "ws-a:peer-a", "needs_confirmation"));
    await h.store.upsert(fixture("req-get-b", "peer-c", "peer-d", "ws-a:peer-a", "completed"));
    await h.store.upsert(fixture("req-get-legacy", "peer-a", "peer-b", undefined, "needs_confirmation"));

    // Party view: originator and target both read.
    expect(
      (await h.service.get({ requestId: "req-get-a", callerAlias: "peer-a" }))?.requestId,
    ).toBe("req-get-a");
    expect(
      (await h.service.get({ requestId: "req-get-a", callerAlias: "peer-b" }))?.requestId,
    ).toBe("req-get-a");
    // Coordinator view: in-scope records even when the coordinator is
    // neither originator nor target.
    expect(
      (
        await h.service.get({
          requestId: "req-get-b",
          callerAlias: "ws-a:peer-a",
          coordinatorSession: "ws-a:peer-a",
        })
      )?.requestId,
    ).toBe("req-get-b");
    // Anyone else gets null — indistinguishable from an unknown id.
    expect(
      await h.service.get({
        requestId: "req-get-a",
        callerAlias: "worker:review",
        coordinatorSession: "ws-a:peer-a",
      }),
    ).toBeNull();
    expect(await h.service.get({ requestId: "req-get-a", callerAlias: "ghost" })).toBeNull();
    expect(await h.service.get({ requestId: "req-nope", callerAlias: "peer-a" })).toBeNull();
    // Legacy coordinator-less records stay party-only, never coordinator
    // visible: fail closed.
    expect(
      (
        await h.service.get({
          requestId: "req-get-legacy",
          callerAlias: "ws-a:peer-a",
          coordinatorSession: "ws-a:peer-a",
        })
      ),
    ).toBeNull();
    expect(
      (await h.service.get({ requestId: "req-get-legacy", callerAlias: "peer-a" }))?.requestId,
    ).toBe("req-get-legacy");
  } finally {
    await h.cleanup();
  }
});

test("withdrawing a pending request reports cancelled on watch", async () => {
  const h = await setup();
  try {
    const record = await h.service.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: "ws-a:peer-a",
      targetAlias: "peer-b",
      task: "t",
    });
    const cancelled = await h.service.cancel({
      requestId: record.requestId,
      originatorAlias: "peer-a",
    });
    expect(cancelled.status).toBe("cancelled");
    const watched = await h.service.watch({
      requestId: record.requestId,
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });
    expect(watched.status).toBe("terminal");
    expect(watched.request.status).toBe("cancelled");
    expect(h.promptCalls).toHaveLength(0);
  } finally {
    await h.cleanup();
  }
});
