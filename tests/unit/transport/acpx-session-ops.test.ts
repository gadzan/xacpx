import { expect, test } from "bun:test";

import {
  buildQueueOwnerLaunchInput,
  cleanupOverflowedOwnerFlow,
  coolQueueOwnerWith,
  describeCleanupError,
  ensureMcpQueueOwnerLaunched,
  probeInspectTimeout,
  queueOwnerRefFromBridgeInput,
  queueOwnerRefFromResolvedSession,
  resolveEffortReapply,
  syncPersistedSessionEffortFlow,
  willReplaceQueueOwner,
  type QueueOwnerRef,
} from "../../../src/transport/acpx-session-ops";
import type { ResolvedSession } from "../../../src/transport/types";
import { ACPX_MODEL_INSPECT_TIMEOUT_MS } from "../../../src/transport/acpx-model-inspector";

const resolved: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
  model: "gpt-5.5",
  mcpCoordinatorSession: "backend:main",
  mcpSourceHandle: "backend:claude:backend:main",
};

const bridgeLike = {
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  cwd: "/tmp/backend",
  name: "backend:api-fix",
  model: "gpt-5.5",
  mcpCoordinatorSession: "backend:main",
  mcpSourceHandle: "backend:claude:backend:main",
};

const ctx = {
  agentEnv: { FILTERED: "yes" },
  hostPolicyEnv: { ACPX_MAX: "1" },
  permissionMode: "approve-all",
  nonInteractivePermissions: "deny",
};

test("both lanes build an identical queue-owner launch input", () => {
  const fromCli = buildQueueOwnerLaunchInput(
    queueOwnerRefFromResolvedSession(resolved),
    "record-1",
    ctx,
  );
  const fromBridge = buildQueueOwnerLaunchInput(
    queueOwnerRefFromBridgeInput(bridgeLike),
    "record-1",
    ctx,
  );
  expect(fromBridge).toEqual(fromCli);
  expect(fromCli).toMatchObject({
    acpxRecordId: "record-1",
    coordinatorSession: "backend:main",
    sourceHandle: "backend:claude:backend:main",
    sessionOptions: { model: "gpt-5.5" },
    env: { FILTERED: "yes", ACPX_MAX: "1" },
  });
});

test("adapter context uses the alias on CLI and sessionKey ?? name on bridge", async () => {
  // Shape-only classifier: two argv parts, second containing /adapters/<id>/releases/.
  const managed = '"/usr/bin/node" "/srv/adapters/codex/releases/1.1.2/node_modules/@agentclientprotocol/codex-acp/bin/codex-acp.js"';
  const seen: string[] = [];
  const factory = {
    ...ctx,
    agentEnv: undefined,
    createAdapterContext: ({ sessionKey: key }: { sessionKey: string }) => {
      seen.push(key);
      return undefined;
    },
  };
  const cliInput = buildQueueOwnerLaunchInput(
    { ...queueOwnerRefFromResolvedSession(resolved), agentCommand: managed },
    "r",
    factory,
  );
  const bridgeInput = buildQueueOwnerLaunchInput(
    { ...queueOwnerRefFromBridgeInput({ ...bridgeLike, sessionKey: "chat-7" }), agentCommand: managed },
    "r",
    factory,
  );
  // Both lanes route the adapter context through their own session identity.
  expect(seen).toEqual(["api-fix", "chat-7"]);
  expect(cliInput.agentCommand).toBe(managed);
  expect(bridgeInput.agentCommand).toBe(managed);
})

const effortRecord = JSON.stringify({
  acpxRecordId: "record-1",
  acpx: {
    config_options: [
      { id: "effort", options: [{ value: "low" }, { value: "high" }], currentValue: "low" },
    ],
  },
});

test("effort decision is shared: reapply only when advertised and needed", () => {
  expect(resolveEffortReapply({ persisted: "high", record: effortRecord, ownerWillBeReplaced: false })).toBe("high");
  expect(resolveEffortReapply({ persisted: "low", record: effortRecord, ownerWillBeReplaced: false })).toBeUndefined();
  expect(resolveEffortReapply({ persisted: undefined, record: effortRecord, ownerWillBeReplaced: false })).toBeUndefined();
  expect(resolveEffortReapply({ persisted: "  ", record: effortRecord, ownerWillBeReplaced: false })).toBeUndefined();
  // Same persisted value as live still reapplies when the owner will be replaced.
  expect(resolveEffortReapply({ persisted: "low", record: effortRecord, ownerWillBeReplaced: true })).toBe("low");
});

test("sync flow cools the owner only when an effort must be reapplied", async () => {
  const record = effortRecord;
  const calls: string[] = [];
  await syncPersistedSessionEffortFlow(
    "high",
    () => "record-1",
    {
      readRecord: async () => record,
      ownerWillBeReplaced: async () => false,
      coolOwner: async () => { calls.push("cool"); },
      applyEffort: async () => { calls.push("apply"); },
    },
  );
  expect(calls).toEqual(["cool", "apply"]);

  calls.length = 0;
  await syncPersistedSessionEffortFlow(
    "low",
    () => "record-1",
    {
      readRecord: async () => record,
      ownerWillBeReplaced: async () => false,
      coolOwner: async () => { calls.push("cool"); },
      applyEffort: async () => { calls.push("apply"); },
    },
  );
  expect(calls).toEqual([]);
});

test("willReplaceQueueOwner matches both lanes' predicate", async () => {
  const build = (id: string) => ({ acpxRecordId: id }) as never;
  expect(await willReplaceQueueOwner({
    coordinatorSession: undefined,
    acpxRecordId: "r",
    buildLaunchInput: build,
  })).toBe(false);
  expect(await willReplaceQueueOwner({
    coordinatorSession: "s",
    acpxRecordId: undefined,
    buildLaunchInput: build,
  })).toBe(false);
  expect(await willReplaceQueueOwner({
    coordinatorSession: "s",
    acpxRecordId: "r",
    buildLaunchInput: build,
  })).toBe(true);
  expect(await willReplaceQueueOwner({
    coordinatorSession: "s",
    acpxRecordId: "r",
    wouldReuse: async () => true,
    buildLaunchInput: build,
  })).toBe(false);
});

test("mcp pre-launch writes back a prepared agent command", async () => {
  let written: string | undefined;
  await ensureMcpQueueOwnerLaunched({
    coordinatorSession: "backend:main",
    readRecord: async () => ({ acpxRecordId: "r" }),
    launch: async () => ({ agentCommand: "prepared-cmd" }),
    onPreparedAgentCommand: (cmd) => { written = cmd; },
    buildLaunchInput: (id) => ({ acpxRecordId: id, coordinatorSession: "backend:main" }) as never,
  });
  expect(written).toBe("prepared-cmd");

  written = undefined;
  await ensureMcpQueueOwnerLaunched({
    coordinatorSession: undefined,
    readRecord: async () => { throw new Error("must not read"); },
    launch: async () => { throw new Error("must not launch"); },
    onPreparedAgentCommand: (cmd) => { written = cmd; },
    buildLaunchInput: (id) => ({ acpxRecordId: id }) as never,
  });
  expect(written).toBeUndefined();
});

test("overflow cleanup flow reports cancel/record/terminate outcomes without throwing", async () => {
  const calls: string[] = [];
  const result = await cleanupOverflowedOwnerFlow({
    cancel: async () => { calls.push("cancel"); },
    readRecordId: async () => { calls.push("read"); return "record-1"; },
    terminate: async () => { calls.push("terminate"); },
  });
  expect(calls).toEqual(["cancel", "read", "terminate"]);
  expect(result).toEqual({
    cancelAttempted: true,
    cancelSucceeded: true,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
  });

  const failed = await cleanupOverflowedOwnerFlow({
    cancel: async () => { throw new Error("boom-cancel"); },
    readRecordId: async () => { throw new Error("boom-read"); },
    terminate: async () => { throw new Error("must not run"); },
  });
  expect(failed.cancelSucceeded).toBe(false);
  expect(failed.ownerTerminationAttempted).toBe(false);
  expect(failed.diagnostic).toContain("cancel failed: boom-cancel");
  expect(failed.diagnostic).toContain("could not resolve the queue owner record: boom-read");
});

test("cool prefers the launcher fast-path and falls back to the verified terminator", async () => {
  const calls: string[] = [];
  await coolQueueOwnerWith({ cool: async (id) => { calls.push(`cool:${id}`); } }, "r1");
  expect(calls).toEqual(["cool:r1"]);
});

test("probe timeout caps the session-init bound at the inspector ceiling", () => {
  expect(probeInspectTimeout(120_000)).toBeLessThanOrEqual(120_000);
  expect(probeInspectTimeout(1_000_000)).toBe(ACPX_MODEL_INSPECT_TIMEOUT_MS);
});

test("describeCleanupError truncates long output", () => {
  expect(describeCleanupError(new Error("x".repeat(600)))).toHaveLength(513);
  expect(describeCleanupError("short")).toBe("short");
});
