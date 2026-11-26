// ---------------------------------------------------------------------------
// Cross-lane error-text parity: resumeAgentSession / injectMessage.
//
// Follow-up to the argv parity oracle. Both lanes throw on control-command
// failure; the only sanctioned shape difference is the CLI resume path's
// `explainSessionSpawnFailure` outer (user-facing spawn diagnosis — a
// passthrough for non-spawn errors, kept by design). Everything else must be
// the post-2b-2 shape `normalizeCommandError(result) ?? "command failed with
// exit code N"` on both lanes. These tests pin that: the same failure through
// either lane must read identically.
//
// Intentionally NOT pinned: resume timeout mapping. A hung resume rejects with
// the raw CommandTimeoutError on the CLI lane and with a plain
// "session initialization timed out ..." Error on the bridge lane. That split
// is pre-existing, downstream code branches on the CLI error type, and it is
// out of scope — the two documentation tests below lock the boundary so a
// future "convergence" cannot silently change either side.
// ---------------------------------------------------------------------------

import { expect, test } from "bun:test";

import { runCliArgvOracle, makeCliSession } from "./cli-argv-oracle-harness";
import { runBridgeArgvOracle, makeBridgeInput } from "../../bridge/golden/bridge-argv-oracle-harness";
import { CommandTimeoutError } from "../../../../src/transport/command-timeouts";

function threwOf(outcome: unknown): string {
  const threw = (outcome as { threw?: unknown }).threw;
  expect(typeof threw).toBe("string");
  return threw as string;
}

test("resume failure text matches across lanes", async () => {
  const failure = { code: 1, stdout: "", stderr: "boom" };
  const cli = await runCliArgvOracle({
    name: "resume-failure",
    results: [failure],
    run: (transport) =>
      transport.resumeAgentSession(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }), "acp-sess-42"),
  });
  const bridge = await runBridgeArgvOracle({
    name: "resume-failure",
    results: [failure],
    run: (runtime) =>
      runtime.resumeAgentSession({
        ...makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" }),
        agentSessionId: "acp-sess-42",
      }),
  });
  expect(threwOf(cli.outcome)).toBe("boom");
  expect(threwOf(bridge.outcome)).toBe(threwOf(cli.outcome));
});

test("inject failure text matches across lanes", async () => {
  const failure = { code: 1, stdout: "", stderr: "boom" };
  const cli = await runCliArgvOracle({
    name: "inject-failure",
    results: [failure],
    run: (transport) =>
      transport.injectMessage(
        makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }),
        { text: "hello", messageId: "m-1", mode: "queue" },
      ),
  });
  const bridge = await runBridgeArgvOracle({
    name: "inject-failure",
    results: [failure],
    run: (runtime) =>
      runtime.injectMessage({ ...makeBridgeInput(), text: "hello", messageId: "m-1", mode: "queue" }),
  });
  expect(threwOf(cli.outcome)).toBe("boom");
  expect(threwOf(bridge.outcome)).toBe(threwOf(cli.outcome));
});

test("resume timeout keeps the raw CommandTimeoutError on the CLI lane", async () => {
  // The oracle harness cannot produce this (its runner seam never hangs):
  // drive the transport directly with a hanging runner and a tiny budget.
  const { AcpxCliTransport } = await import("../../../../src/transport/acpx-cli/acpx-cli-transport");
  const hanging = () => new Promise<never>(() => {});
  const transport = new AcpxCliTransport({ command: "acpx", sessionInitTimeoutMs: 50 }, hanging as never, hanging as never);
  const error = await transport
    .resumeAgentSession(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }), "acp-sess-42")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CommandTimeoutError);
  expect((error as Error).message).toMatch(/acpx command timed out/);
});

test("resume timeout stays a plain session-init error on the bridge lane", async () => {
  // The oracle harness seams only resolve canned results, never reject: drive
  // the runtime directly with a seam that rejects like a hung spawn would.
  const { BridgeRuntime } = await import("../../../../src/bridge/bridge-runtime");
  const rejecting = async () => {
    throw new CommandTimeoutError(50, "sessions new");
  };
  const runtime = new BridgeRuntime("acpx", rejecting as never, rejecting as never);
  const error = await runtime
    .resumeAgentSession({ ...makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" }), agentSessionId: "acp-sess-42" })
    .catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(CommandTimeoutError);
  expect((error as Error).message).toMatch(/session initialization timed out after/);
  expect((error as Error).message).not.toMatch(/acpx command timed out/);
});
