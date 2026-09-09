import { expect, test } from "bun:test";

import { mapResult, toConfigSnapshot } from "../../../../../src/bridge/engine/runtime/runtime-adapter";
import { mapRuntimeError } from "../../../../../src/bridge/engine/runtime/runtime-contract";

/** acpx 0.15.1 stable spawn failure: detailCode beats the "not found" message regex. */
test("AGENT_SPAWN_ENOENT maps to init failure, not session-missing", () => {
  const err = new Error(
    "Failed to spawn agent command: ghost acp. The agent process could not start because a required executable was not found.",
  ) as Error & { detailCode: string };
  err.name = "AgentSpawnError";
  err.detailCode = "AGENT_SPAWN_ENOENT";
  const mapped = mapRuntimeError(err);
  expect(mapped.code).toBe("RUNTIME_INIT_FAILED");
  expect(mapped.message).toContain("PATH");
});

/** Bare AgentSpawnError (e.g. lifecycle admission rejection) is init failure
 *  WITHOUT install/PATH remediation — only AGENT_SPAWN_ENOENT proves that. */
test("AgentSpawnError without ENOENT detail gets no install hint", () => {
  const err = new Error("Failed to spawn agent command: ghost acp") as Error;
  err.name = "AgentSpawnError";
  const mapped = mapRuntimeError(err);
  expect(mapped.code).toBe("RUNTIME_INIT_FAILED");
  expect(mapped.message).not.toContain("PATH");
  expect(mapped.message).not.toContain("install it");
});

/** Broad fallback still catches plain missing-session wording. */
test("plain session-missing wording still maps to session-missing", () => {
  expect(mapRuntimeError(new Error("session not found")).code).toBe("RUNTIME_SESSION_MISSING");
});

/** 64 MiB ceiling: detailCode and message-only shapes stay actionable with a recycle hint. */
test("ACP_MESSAGE_TOO_LARGE maps to turn failure with recycle hint", () => {
  const fromDetail = mapRuntimeError({
    message: "ACP message exceeded ACPX_MAX_ACP_MESSAGE_BYTES (65536 bytes).",
    detailCode: "ACP_MESSAGE_TOO_LARGE",
  });
  expect(fromDetail.code).toBe("RUNTIME_TURN_FAILED");
  expect(fromDetail.message).toContain("ACPX_MAX_ACP_MESSAGE_BYTES");
  expect(fromDetail.message).toContain("recycle");

  const fromMessage = mapRuntimeError(
    new Error("ACP message exceeded ACPX_MAX_ACP_MESSAGE_BYTES (65536 bytes)."),
  );
  expect(fromMessage.code).toBe("RUNTIME_TURN_FAILED");
  expect(fromMessage.message).toContain("recycle");
});

test("completed preserves opaque _meta as narrow meta", async () => {
  const mapped = await mapResult(
    Promise.resolve({ status: "completed", stopReason: "end_turn", _meta: { probe: "yes", nested: { a: 1 } } }),
  );
  expect(mapped).toEqual({ status: "completed", stopReason: "end_turn", meta: { probe: "yes", nested: { a: 1 } } });
});

test("cancelled preserves meta; explicit null survives; absent stays absent", async () => {
  const cancelled = await mapResult(Promise.resolve({ status: "cancelled", _meta: { why: "user" } }));
  expect(cancelled).toEqual({ status: "cancelled", meta: { why: "user" } });
  const nulled = await mapResult(Promise.resolve({ status: "completed", _meta: null }));
  expect(nulled).toEqual({ status: "completed", meta: null });
  expect("meta" in (nulled as object)).toBe(true);
  const absent = await mapResult(Promise.resolve({ status: "completed" }));
  expect(absent).toEqual({ status: "completed" });
  expect("meta" in (absent as object)).toBe(false);
});

test("failed never fabricates meta and meta survives a JSON round-trip", async () => {
  const failed = await mapResult(
    Promise.resolve({ status: "failed", error: { message: "boom" }, _meta: { probe: "yes" } }),
  );
  expect(failed).toEqual({ status: "failed", error: { message: "boom" } });
  const roundTripped = JSON.parse(JSON.stringify(await mapResult(
    Promise.resolve({ status: "completed", _meta: { probe: "yes" } }),
  )));
  expect(roundTripped).toEqual({ status: "completed", meta: { probe: "yes" } });
});

test("toConfigSnapshot narrows accepted options, stringifies booleans", () => {
  expect(toConfigSnapshot(undefined)).toBeUndefined();
  expect(toConfigSnapshot(null)).toBeUndefined();
  expect(toConfigSnapshot({})).toBeUndefined();
  expect(toConfigSnapshot({ configOptions: [] })).toEqual({ options: [] });
  expect(
    toConfigSnapshot({
      configOptions: [
        { id: "model", name: "Model", currentValue: "gpt-5" },
        { id: "thinking", currentValue: true },
        { id: "bare" },
        { id: 42, currentValue: "x" },
        null,
      ],
    }),
  ).toEqual({
    options: [
      { id: "model", currentValue: "gpt-5" },
      { id: "thinking", currentValue: "true" },
      { id: "bare" },
    ],
  });
});
