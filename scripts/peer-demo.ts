/**
 * Peer delegation live demo (prototype, service-level driven).
 *
 * Drives two REAL sessions (mock ACP agent, acpx-cli lane) through the full
 * peer flow: delegate -> observe -> message -> complete -> reverse delegate.
 *
 * Isolation: the script REFUSES to run without PEER_DEMO_HOME set, and every
 * file it writes (config.json, state.json, peer-requests.json, workspaces)
 * lives under that directory. It never touches the operator's real HOME.
 * It needs no API key and no WeChat credential: the agent is the repo's own
 * mock ACP agent.
 *
 * Honest boundary (see docs/peer-delegation.md): the mock agent cannot
 * initiate MCP tool calls, so this demo drives the PeerService directly
 * with two sessions' names. What it proves is the point-to-point path
 * itself — delegation, approval gating, observation, backfill, message
 * reuse via agent_send, and reverse delegation — not agent initiative.
 *
 * Run: PEER_DEMO_HOME=<isolated dir> bun run scripts/peer-demo.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp, type AppRuntime } from "../src/main";
import { resolveAcpxCommand } from "../src/config/resolve-acpx-command";
import { encodeAgentHandle } from "../src/orchestration/agent-handle";
import { PeerService } from "../src/peer/peer-service";
import { PeerStore } from "../src/peer/peer-store";

const MOCK_AGENT = fileURLToPath(new URL("../tests/fixtures/mock-acp-agent.mjs", import.meta.url));

function log(step: string, detail: string): void {
  console.log(`[${step}] ${detail}`);
}

async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

async function readPrompts(wsDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(wsDir, ".mock-agent-prompts.json"), "utf8");
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const home = process.env.PEER_DEMO_HOME;
  if (!home) {
    throw new Error("PEER_DEMO_HOME is required: the demo refuses to run without an isolated home directory.");
  }
  const wsA = join(home, "ws-a");
  const wsB = join(home, "ws-b");
  await mkdir(home, { recursive: true });
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });

  const config = {
    agents: { mock: { driver: "mock", argv: ["node", MOCK_AGENT] } },
    workspaces: {
      "ws-a": { cwd: wsA },
      "ws-b": { cwd: wsB },
    },
    transport: { type: "acpx-cli", command: resolveAcpxCommand({}) },
    logging: { level: "error" },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(home, "state.json"), JSON.stringify({}, null, 2));

  log("SETUP", `isolated home: ${home}`);
  const runtime: AppRuntime = await buildApp(
    {
      configPath: join(home, "config.json"),
      statePath: join(home, "state.json"),
      orchestrationSocketPath: join(home, "orchestration.sock"),
    },
    { canReapQueueOwners: () => true, stateSaveDebounceMs: 0 },
  );

  try {
    const sessionA = await runtime.control.createSession("peer-chat", "peer-a", "mock", "ws-a");
    const sessionB = await runtime.control.createSession("peer-chat", "peer-b", "mock", "ws-b");
    log("SETUP", `sessions created: peer-a (${sessionA.transportSession}), peer-b (${sessionB.transportSession})`);

    const peer = new PeerService({
      resolveSession: async (key) => {
        const direct = await runtime.sessions.getSession(key);
        if (direct) return direct;
        const internal = await runtime.sessions.resolveAliasForChat("peer-chat", key);
        const viaInternal = await runtime.sessions.getSession(internal);
        if (viaInternal) return viaInternal;
        return await runtime.sessions.getPreferredSessionForTransport(key);
      },
      promptSession: async (session, text) => runtime.transport.prompt(session, text),
      store: new PeerStore(join(home, "peer-requests.json")),
    });

    log("STEP 1", "peer-a delegates to peer-b (delay-3000-partial keeps B busy so observation is real)");
    const ab = await peer.delegate({
      originatorAlias: "peer-a",
      coordinatorSession: sessionA.transportSession,
      targetAlias: "peer-b",
      task: "peer-task-a-to-b delay-3000-partial",
      requestId: "req-demo-ab",
    });
    log("STEP 1", `created: requestId=${ab.requestId} status=${ab.status}`);
    const promptsBefore = await readPrompts(wsB);
    if (promptsBefore.some((t) => t.includes("peer-task-a-to-b"))) {
      throw new Error("unapproved delegation already executed: task reached B before approval");
    }
    log("STEP 1", "verified: unapproved delegation did NOT execute (B has not seen the task)");

    log("STEP 2", "operator approves; peer-a observes");
    await peer.approve({ requestId: ab.requestId, approverAlias: sessionA.transportSession, coordinatorSession: sessionA.transportSession });
    const shortWatch = await peer.watch({ requestId: ab.requestId, timeoutMs: 1000, pollIntervalMs: 100 });
    log("STEP 2", `short watch: status=${shortWatch.status} request=${shortWatch.request.status} (timeout ends only the watch; B keeps running)`);
    if (shortWatch.status !== "timeout" || shortWatch.request.status !== "running") {
      throw new Error("expected a timeout watch over a still-running request");
    }
    const settled = await peer.watch({ requestId: ab.requestId, timeoutMs: 30_000, pollIntervalMs: 200 });
    log("STEP 2", `long watch: status=${settled.status} request=${settled.request.status}`);
    log("STEP 2", `backfilled result (truncated to 200 chars): ${(settled.request.result ?? "").slice(0, 200)}`);

    log("STEP 3", "message exchange via existing agent_send (no new message channel)");
    const peers = await runtime.agentMessaging.listReachable({
      coordinatorSession: sessionA.transportSession,
    });
    const peerB = peers.find((p) => p.sessionAlias === "peer-b" && p.endpointKind === "logical");
    if (!peerB) {
      throw new Error("peer-b not reachable via agent_list from peer-a");
    }
    const sendResponse = JSON.parse(
      await runtime.orchestration.server.handleLine(
        JSON.stringify({
          id: "peer-demo-msg-1",
          method: "agent.send",
          params: {
            coordinatorSession: sessionA.transportSession,
            to: encodeAgentHandle(peerB.address),
            message: "peer-note-a-to-b",
          },
        }),
      ),
    );
    if (!sendResponse.ok) {
      throw new Error(`agent.send failed: ${JSON.stringify(sendResponse)}`);
    }
    log("STEP 3", `agent.send receipt: messageId=${sendResponse.result.messageId} status=${sendResponse.result.status}`);
    await waitUntil(async () => (await readPrompts(wsB)).some((t) => t.includes("peer-note-a-to-b")));
    log("STEP 3", "verified: B's mock agent received the peer message");

    log("STEP 4", "peer-b delegates back to peer-a (mutual delegation)");
    const ba = await peer.delegate({
      originatorAlias: "peer-b",
      coordinatorSession: sessionB.transportSession,
      targetAlias: "peer-a",
      task: "peer-task-b-to-a",
      requestId: "req-demo-ba",
    });
    await peer.approve({ requestId: ba.requestId, approverAlias: sessionB.transportSession, coordinatorSession: sessionB.transportSession });
    const baSettled = await peer.watch({ requestId: ba.requestId, timeoutMs: 30_000, pollIntervalMs: 200 });
    log("STEP 4", `reverse delegation: status=${baSettled.request.status}`);
    log("STEP 4", `backfilled result (truncated to 200 chars): ${(baSettled.request.result ?? "").slice(0, 200)}`);

    log("STEP 5", "originators validate and confirm delivery");
    const deliveredAb = await peer.confirm({ requestId: ab.requestId, originatorAlias: "peer-a" });
    const deliveredBa = await peer.confirm({ requestId: ba.requestId, originatorAlias: "peer-b" });
    log("STEP 5", `req-demo-ab: ${deliveredAb.status}; req-demo-ba: ${deliveredBa.status}`);

    log("STEP 6", "records survive a store reload (daemon restart)");
    const reloaded = new PeerService({
      resolveSession: async () => null,
      promptSession: async () => ({ text: "" }),
      store: new PeerStore(join(home, "peer-requests.json")),
    });
    const reAb = await reloaded.get("req-demo-ab");
    const reBa = await reloaded.get("req-demo-ba");
    log("STEP 6", `after reload: req-demo-ab=${reAb?.status} req-demo-ba=${reBa?.status}`);
    if (reAb?.status !== "delivered" || reBa?.status !== "delivered") {
      throw new Error("reloaded records did not survive");
    }

    log("STEP 7", "cancel + query: peer-b delegates a slow task to peer-a, then cancels while it runs");
    const cx = await peer.delegate({
      originatorAlias: "peer-b",
      coordinatorSession: sessionB.transportSession,
      targetAlias: "peer-a",
      task: "peer-task-cancel delay-3000-partial",
      requestId: "req-demo-cancel",
    });
    await peer.approve({ requestId: cx.requestId, approverAlias: sessionB.transportSession, coordinatorSession: sessionB.transportSession });
    await waitUntil(async () => (await readPrompts(wsA)).some((t) => t.includes("peer-task-cancel")));
    log("STEP 7", "verified: peer-a's turn is running (cancellation is record-level only; it will not stop this turn)");
    const cancelled = await peer.cancel({ requestId: cx.requestId, originatorAlias: "peer-b" });
    log("STEP 7", `cancelled: requestId=${cancelled.requestId} status=${cancelled.status}`);
    const cancelWatched = await peer.watch({ requestId: cx.requestId, timeoutMs: 30_000, pollIntervalMs: 200 });
    log("STEP 7", `watch after cancel: status=${cancelWatched.status} request=${cancelWatched.request.status}`);
    const listedCancelled = await peer.listRelated("peer-b", { status: "cancelled" });
    log("STEP 7", `peer_list (peer-b, cancelled): ${listedCancelled.map((r) => r.requestId).join(", ")}`);
    const gotCancelled = await peer.get("req-demo-cancel");
    log("STEP 7", `peer_get req-demo-cancel: status=${gotCancelled?.status}`);
    if (cancelled.status !== "cancelled" || cancelWatched.request.status !== "cancelled" || gotCancelled?.status !== "cancelled") {
      throw new Error("cancel flow did not reach cancelled state");
    }

    console.log("DEMO OK: delegate -> observe -> message -> complete -> reverse delegate -> confirm -> cancel/query");
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) {
  await main();
}
