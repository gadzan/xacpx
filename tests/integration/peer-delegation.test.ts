import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, type AppRuntime } from "../../src/main";
import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import { encodeAgentHandle } from "../../src/orchestration/agent-handle";
import { PeerService } from "../../src/peer/peer-service";
import { PeerStore } from "../../src/peer/peer-store";

const MOCK_AGENT = fileURLToPath(new URL("../fixtures/mock-acp-agent.mjs", import.meta.url));
const ACPX = resolveAcpxCommand({});

async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  context?: () => string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(100);
  }
  const extra = context ? ` (${await context()})` : "";
  throw new Error(`waitUntil timed out after ${timeoutMs}ms${extra}`);
}

async function readPrompts(wsDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(wsDir, ".mock-agent-prompts.json"), "utf8");
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

test(
  "Peer delegation E2E: two real sessions delegate mutually, observe, message, and confirm",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "xacpx-peer-e2e-"));
    const home = join(root, "home");
    const wsA = join(root, "ws-a");
    const wsB = join(root, "ws-b");
    await mkdir(home, { recursive: true });
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });

    const config = {
      agents: { mock: { driver: "mock", argv: ["node", MOCK_AGENT] } },
      workspaces: {
        "ws-a": { cwd: wsA },
        "ws-b": { cwd: wsB },
      },
      transport: { type: "acpx-cli", command: ACPX },
      logging: { level: "error" },
    };
    await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2));
    await writeFile(join(home, "state.json"), JSON.stringify({}, null, 2));

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

      const peer = new PeerService({
        // Session keys arrive as display aliases ("peer-b"); state is keyed
        // by channel-scoped internal aliases, so map display -> internal
        // first, then fall back to direct and transport-session lookup.
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

      // 1. A delegates to B. Unapproved: nothing executes.
      const ab = await peer.delegate({
        originatorAlias: "peer-a",
        targetAlias: "peer-b",
        // delay-3000-partial keeps B's turn busy for 3s so the watch
        // observes a genuinely running request before it settles.
        task: "peer-task-a-to-b delay-3000-partial",
        requestId: "req-e2e-ab",
      });
      expect(ab.status).toBe("needs_confirmation");
      expect(await readPrompts(wsB)).not.toContainEqual(
        expect.stringContaining("peer-task-a-to-b"),
      );

      // 2. Operator approves; A observes: first a short watch times out
      // (the request keeps running — timeout is not failure, not a resend),
      // then a longer watch sees terminal completion with the result.
      await peer.approve({ requestId: ab.requestId, approvedBy: "operator" });
      const shortWatch = await peer.watch({
        requestId: ab.requestId,
        timeoutMs: 1000,
        pollIntervalMs: 100,
      });
      expect(shortWatch.status).toBe("timeout");
      expect(shortWatch.request.status).toBe("running");
      const settled = await peer.watch({
        requestId: ab.requestId,
        timeoutMs: 30_000,
        pollIntervalMs: 200,
      });
      expect(settled.status).toBe("terminal");
      expect(settled.request.status).toBe("completed");
      expect(settled.request.result).toContain("peer-task-a-to-b");
      expect(settled.request.result).toContain("Peer delegation from peer-a");
      expect(settled.request.result).toContain("request req-e2e-ab");

      // 3. Message exchange reuses agent_send (no new message channel):
      // A sends a one-way peer message to B over the real agent.send RPC.
      const peers = await runtime.agentMessaging.listReachable({
        coordinatorSession: sessionA.transportSession,
      });
      const peerB = peers.find(
        (p) => p.sessionAlias === "peer-b" && p.endpointKind === "logical",
      );
      expect(peerB).toBeDefined();
      const sendResponse = JSON.parse(
        await runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "peer-msg-1",
            method: "agent.send",
            params: {
              coordinatorSession: sessionA.transportSession,
              to: encodeAgentHandle(peerB!.address),
              message: "peer-note-a-to-b",
            },
          }),
        ),
      );
      expect(sendResponse.ok).toBe(true);
      await waitUntil(
        async () => (await readPrompts(wsB)).some((t) => t.includes("peer-note-a-to-b")),
        30_000,
        async () => `B prompts: ${JSON.stringify(await readPrompts(wsB))}`,
      );

      // 4. B delegates back to A (mutual delegation) and A confirms first.
      const ba = await peer.delegate({
        originatorAlias: "peer-b",
        targetAlias: "peer-a",
        task: "peer-task-b-to-a",
        requestId: "req-e2e-ba",
      });
      await peer.approve({ requestId: ba.requestId, approvedBy: "operator" });
      const baSettled = await peer.watch({
        requestId: ba.requestId,
        timeoutMs: 30_000,
        pollIntervalMs: 200,
      });
      expect(baSettled.request.status).toBe("completed");
      expect(baSettled.request.result).toContain("peer-task-b-to-a");

      const deliveredAb = await peer.confirm({
        requestId: ab.requestId,
        originatorAlias: "peer-a",
      });
      expect(deliveredAb.status).toBe("delivered");
      const deliveredBa = await peer.confirm({
        requestId: ba.requestId,
        originatorAlias: "peer-b",
      });
      expect(deliveredBa.status).toBe("delivered");

      // 5. Records survive a store reload (daemon restart).
      const reloaded = new PeerService({
        resolveSession: async () => null,
        promptSession: async () => ({ text: "" }),
        store: new PeerStore(join(home, "peer-requests.json")),
      });
      expect((await reloaded.get("req-e2e-ab"))?.status).toBe("delivered");
      expect((await reloaded.get("req-e2e-ba"))?.status).toBe("delivered");
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  },
  { timeout: 180_000 },
);
