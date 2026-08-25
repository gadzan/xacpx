// tests/unit/commands/transport-invoker-cancel.test.ts
// v0.4 Peer Interrupt Delivery contract-boundary gate (spec §6.4, §10 seam).
//
// Splits the interrupt contract in two:
//   xacpx-owned:   an abort of the turn's AbortController issues EXACTLY ONE
//                  cancellation request to the transport (TransportInvoker's
//                  cancel-on-abort path), and a pre-aborted signal issues none.
//   transport-owned: whether that request actually terminates the in-flight
//                  prompt early. The fake transport here deliberately IGNORES
//                  the cancel and finishes naturally — mirroring runtimes that
//                  do not honor mid-turn cancellation.
import { expect, test } from "bun:test";

import { TransportInvoker } from "../../../src/commands/transport-invoker";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import type {
  ResolvedSession,
  SessionTransport,
} from "../../../src/transport/types";

const session: ResolvedSession = {
  alias: "main",
  agent: "codex",
  workspace: "ws",
  transportSession: "coordinator",
  cwd: "/tmp/ws",
};

const tick = () => new Promise((r) => setTimeout(r, 0));

// Test seam: the invoker's remaining deps are unused on the prompt/cancel path.
function makeInvoker(transport: SessionTransport): TransportInvoker {
  return new TransportInvoker({
    transport,
    logger: createNoopAppLogger(),
    sessions: null as unknown as ConstructorParameters<
      typeof TransportInvoker
    >["0"]["sessions"],
    resolveSessionAgentCommand: (() => undefined) as ConstructorParameters<
      typeof TransportInvoker
    >["0"]["resolveSessionAgentCommand"],
    autoInstall: (async () => {
      throw new Error("auto-install must not run in the cancel seam gate");
    }) as ConstructorParameters<typeof TransportInvoker>["0"]["autoInstall"],
    discoverPaths: (() => []) as ConstructorParameters<
      typeof TransportInvoker
    >["0"]["discoverPaths"],
  });
}

// A transport whose prompt parks until the test settles it and whose cancel
// only COUNTS calls — it never terminates the prompt early.
function makeControllableTransport() {
  let settlePrompt!: (r: { text: string }) => void;
  let cancelCalls = 0;
  const transport = {
    prompt: () =>
      new Promise<{ text: string }>((resolve) => {
        settlePrompt = resolve;
      }),
    cancel: async () => {
      cancelCalls += 1;
      return { cancelled: true, message: "cancel recorded" };
    },
  };
  return {
    transport: transport as unknown as SessionTransport,
    settle: () => settlePrompt({ text: "natural completion" }),
    cancelCount: () => cancelCalls,
  };
}

test("cancel seam: an abort issues exactly ONE transport cancel request while the prompt stays pending; natural completion still settles the turn", async () => {
  const { transport, settle, cancelCount } = makeControllableTransport();
  const invoker = makeInvoker(transport);
  const controller = new AbortController();

  const promptPromise = invoker.promptTransportSession(
    session,
    "old turn",
    undefined,
    undefined,
    undefined,
    controller.signal,
  );
  await tick();
  expect(cancelCount()).toBe(0);

  // The interrupt path aborts the turn controller → exactly one cancel REQUEST.
  controller.abort();
  await tick();
  expect(cancelCount()).toBe(1);

  // Transport-owned: the prompt is STILL pending — the cancel did not stop it.
  // xacpx waits; it never starts a second turn over this one.
  settle();
  const result = await promptPromise;
  expect(result.text).toBe("natural completion");
  expect(cancelCount()).toBe(1); // still exactly one — no retry storm
});

test("cancel seam: an already-aborted signal issues NO cancel request (no double cancel for aborted-but-unsettled predecessors)", async () => {
  const { transport, settle, cancelCount } = makeControllableTransport();
  const invoker = makeInvoker(transport);
  const controller = new AbortController();
  controller.abort();

  await expect(
    invoker.promptTransportSession(
      session,
      "old turn",
      undefined,
      undefined,
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow();
  await tick();
  // The prompt never dispatched (pre-aborted throws before transport.prompt),
  // so there is nothing to settle — and crucially NO cancel request either.
  expect(cancelCount()).toBe(0);
});
