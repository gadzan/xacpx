import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine.ts";

/** Mock ACP agent that asks twice per turn and withdraws its first question. */
const MOCK_AGENT_SOURCE = resolve(process.cwd(), "tests/fixtures/mock-elicit-cancel-agent.mjs");

async function buildWorker(dir: string): Promise<string> {
  const workerOutDir = join(dir, "dist", "bridge", "engine", "runtime");
  const result = await Bun.build({
    entrypoints: [resolve(process.cwd(), "./src/bridge/engine/runtime/runtime-worker-main.ts")],
    outdir: workerOutDir,
    target: "node",
    external: ["acpx", "node-pty", "fs-ext", "write-file-atomic"],
  });
  if (!result.success) throw new Error(`Bun.build failed: ${result.logs.join("\n")}`);
  return join(workerOutDir, "runtime-worker-main.js");
}

test("$/cancel_request for one elicitation aborts the host propagation without ending the turn", async () => {
  // Regression: request-scoped cancellation did not propagate past the worker.
  // The worker's abort handler only cleared its own pending map and rejected,
  // so an agent withdrawing a single `elicitation/create` left the daemon
  // broker — and therefore the renderer — waiting out the full 120s deadline
  // even though nobody would read the answer.
  //
  // This exercises the REAL production path: acpx aborts the handler signal on
  // `$/cancel_request`, the worker must emit `elicitation.cancel`, the host
  // worker client must abort its in-flight propagation, and the engine must
  // surface a cancelled decision to the host handler.
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-cancel-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-cancel-agent.mjs");
  await writeFile(agentFile, await Bun.file(MOCK_AGENT_SOURCE).text());

  const decisions: string[] = [];
  let q1Invoked = false;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async (payload, signal) => {
      const message = (payload.request as { message?: unknown })?.message;
      if (message === "q1") {
        // The withdrawn request must reach the host handler with an ALIVE
        // propagation that then aborts. Before the fix the worker cleared its
        // own pending map and nothing else, so this handler would sit until
        // the 125s watchdog.
        q1Invoked = true;
        const aborted = new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new Error("elicitation cancelled"));
          else signal?.addEventListener("abort", () => reject(new Error("elicitation cancelled")), { once: true });
        });
        // Racing makes the assertion about the abort, not about the delay.
        const held = new Promise<string>((resolve) => setTimeout(() => {
          decisions.push("q1:late-accept");
          resolve("late");
        }, 2_000));
        await Promise.race([held, aborted]).catch(() => {
          decisions.push("q1:aborted");
          return "aborted";
        });
        // Whatever happened above, the host handler reports cancellation: the
        // engine's own cancel mapping is fail-closed.
        return { action: "cancel" };
      }
      decisions.push("q2:answered");
      return { action: "accept", content: { answer: "ok" } };
    },
  } as never);

  try {
    await engine.prompt({
      agent: "cancel-agent",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "cancel-session",
      logicalSessionId: "cancel-1",
      text: "ask twice",
    } as never, async () => {});

    // The abort reached the host handler: it lost the race against the held
    // decision instead of sleeping out its own delay.
    expect(q1Invoked).toBe(true);
    expect(decisions).toContain("q1:aborted");
    expect(decisions).not.toContain("q1:late-accept");
    // The turn survived request-scoped cancellation and asked again.
    expect(decisions).toContain("q2:answered");
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);
