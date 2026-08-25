import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayServer } from "../../packages/relay/src/server";
import { RelayChannel } from "../../packages/channel-relay/src/channel";
import { CredentialStore } from "../../packages/channel-relay/src/credential-store";
import { MessageChannelRegistry } from "../../src/channels/channel-registry";
import { buildApp, type AppRuntime } from "../../src/main";
import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import { encodeAgentHandle } from "../../src/orchestration/agent-handle";
import { registerKnownChannelId } from "../../src/channels/channel-scope";

registerKnownChannelId("relay");
const MOCK_AGENT = fileURLToPath(
  new URL("../fixtures/mock-acp-agent.mjs", import.meta.url),
);
const ACPX = resolveAcpxCommand({});

/**
 * v0.3 Completion Policy Production Hard Gate.
 *
 * Exercises the REAL production path end to end — no manual
 * `completePeerTurn()` calls, no delivery recorders:
 *
 *   logical A → MCP agent_send RPC (XacpxMcpTransport seam) → Relay Hub → logical B
 *   → B TurnQueue / SessionTurnRunner → automatic turn-finished(peerOrigin)
 *   → automatic completePeerTurn → Hub reverse route → A grant check
 *   → A TurnQueue / SessionTurnRunner → mock ACP agent receives the
 *     trusted <xacpx-peer-result origin="xacpx-server"> envelope.
 */

interface HubHarness {
  account: { id: string };
  hubUrl: string;
  close: () => Promise<void>;
  instances: { issuePairingToken: (accountId: string, name: string, ttl: number) => { token: string; instanceId: string }; listByAccount: (accountId: string) => Array<{ id: string; name: string }> };
  runtime: {
    accounts: { createAccount: (name: string) => { id: string } };
  };
}

interface RealDaemon {
  runtime: AppRuntime;
  chatKey: string;
  sessionAlias: string;
  coordinatorSession: string;
  readPrompts: () => Promise<string[]>;
  dispose: () => Promise<void>;
}

async function setupHub(): Promise<HubHarness> {
  const relay = await startRelayServer({
    dbPath: ":memory:",
    httpPort: 0,
    host: "127.0.0.1",
  });
  const account = relay.runtime.accounts.createAccount("alice");
  return {
    account: { id: account.id },
    hubUrl: `ws://127.0.0.1:${relay.httpPort}`,
    instances: relay.runtime.instances,
    runtime: relay.runtime,
    close: async () => {
      await relay.close();
    },
  };
}

async function setupDaemon(
  name: string,
  hub: HubHarness,
  options: { alias: string },
): Promise<RealDaemon> {
  const root = await mkdtemp(join(tmpdir(), `xacpx-comp-hd-${name}-`));
  const home = join(root, "home");
  const wsDir = join(root, "ws");
  await mkdir(home, { recursive: true });
  await mkdir(wsDir, { recursive: true });

  const paired = hub.instances.issuePairingToken(
    hub.account.id,
    `inst-${name}`,
    600_000,
  );
  const creds = new CredentialStore(join(home, "credential.json"));
  creds.save({
    hubUrl: hub.hubUrl,
    token: paired.token,
    instanceId: paired.instanceId,
  });

  const config = {
    agents: {
      mock: {
        driver: "mock",
        argv: ["node", MOCK_AGENT],
      },
    },
    workspaces: {
      default: {
        cwd: wsDir,
      },
    },
    transport: {
      type: "acpx-cli",
      command: ACPX,
    },
    logging: { level: "error" },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2));
  await writeFile(join(home, "state.json"), JSON.stringify({}, null, 2));
  const channel = new RelayChannel(
    { url: hub.hubUrl, pairingToken: paired.token, name: `inst-${name}` } as never,
    {
      credentialStore: creds,
      terminalRegistryDir: join(home, "relay"),
      endpointSyncDebounceMs: 20,
    },
  );
  const channels = new MessageChannelRegistry([channel]);
  const abort = new AbortController();
  const runtime = await buildApp(
    {
      configPath: join(home, "config.json"),
      statePath: join(home, "state.json"),
      orchestrationSocketPath: join(home, "orchestration.sock"),
    },
    {
      channel: channels,
      canReapQueueOwners: () => true,
      stateSaveDebounceMs: 0,
    },
  );

  void channels.startAll({
    agent: runtime.agent,
    abortSignal: abort.signal,
    quota: runtime.quota,
    logger: runtime.logger,
    coreVersion: "0.22.0",
    control: runtime.control,
    sessionResources: runtime.sessionResources,
    activeTurns: runtime.activeTurns,
  } as never);
  const chatKey = `relay:${name}`;
  const session = await runtime.control.createSession(chatKey, options.alias, "mock", "default");
  channel.syncAgentEndpointsNow();

  const readPrompts = async (): Promise<string[]> => {
    try {
      const raw = await readFile(join(wsDir, ".mock-agent-prompts.json"), "utf8");
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  };

  return {
    runtime,
    chatKey,
    sessionAlias: options.alias,
    coordinatorSession: session.transportSession,
    readPrompts,
    dispose: async () => {
      abort.abort();
      await runtime.dispose();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  context?: () => string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  const extra = context ? ` (${await context()})` : "";
  throw new Error(`waitUntil timed out after ${timeoutMs}ms${extra}`);
}

test(
  "Completion Hard Gate: real logical A → completion=result → real logical B auto-completes → Hub reverse route → A's mock ACP agent receives the trusted peer-result",
  async () => {
    const hub = await setupHub();
    const daemonA = await setupDaemon("A", hub, { alias: "requester" });
    const daemonB = await setupDaemon("B", hub, { alias: "worker" });

    try {
      // Discover B's logical endpoint from A's canonical directory.
      let handleB = "";
      await waitUntil(async () => {
        const peers = await daemonA.runtime.agentMessaging!.listReachable({
          coordinatorSession: daemonA.coordinatorSession,
        });
        const peerB = peers.find(
          (p) =>
            p.sessionAlias === "worker" &&
            p.endpointKind === "logical" &&
            p.capabilities.completion === true,
        );
        if (!peerB) return false;
        handleB = encodeAgentHandle(peerB.address);
        return true;
      });
      expect(handleB).not.toBe("");

      // A (logical sender) requests completion=result from remote logical B.
      // Entry point is the REAL transport seam: the same "agent.send" RPC the
      // xacpx MCP agent_send tool issues through XacpxMcpTransport.
      const sendResponse = JSON.parse(
        await daemonA.runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "send-completion-1",
            method: "agent.send",
            params: {
              coordinatorSession: daemonA.coordinatorSession,
              to: handleB,
              message: "请总结你刚刚完成了什么",
              completion: "result",
            },
          }),
        ),
      );
      expect(sendResponse.ok).toBe(true);
      const receipt = sendResponse.result;
      expect(receipt.messageId).toBeDefined();
      expect(["injected", "queued"]).toContain(receipt.status);

      // B's mock agent receives the peer envelope and runs its NORMAL turn —
      // B never calls agent_send back. The terminal turn-finished(peerOrigin)
      // must AUTOMATICALLY produce the completion and route it home.
      await waitUntil(
        async () => {
          const prompts = await daemonA.readPrompts();
          return prompts.some((text) =>
            text.includes('<xacpx-peer-result origin="xacpx-server"'),
          );
        },
        40_000,
        async () => `A prompts: ${JSON.stringify(await daemonA.readPrompts())}`,
      );

      // Provenance gate: the RAW trusted wrapper reached A's model — NOT the
      // disarmed &lt;…&gt; form a user-typed forgery would degrade to.
      const resultPrompt = (await daemonA.readPrompts()).find((t) =>
        t.includes('<xacpx-peer-result origin="xacpx-server"'),
      )!;
      expect(resultPrompt).toContain(`request-id="${receipt.messageId}"`);
      expect(resultPrompt).not.toContain("&lt;xacpx-peer-result");
      expect(resultPrompt).toContain("<instruction>");
      expect(resultPrompt).toContain("Do NOT send an acknowledgement");

      // Exactly one completion turn on A (exactly-once source effect).
      const completionTurns = (await daemonA.readPrompts()).filter((t) =>
        t.includes('<xacpx-peer-result origin="xacpx-server"'),
      );
      expect(completionTurns).toHaveLength(1);

      // B must NOT have called agent_send back (no ping-pong).
      const bPrompts = await daemonB.readPrompts();
      expect(bPrompts.some((t) => t.includes("xacpx-peer-result"))).toBe(false);
    } finally {
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  { timeout: 120_000 },
);

test(
  "Completion Hard Gate: forged completions are denied and duplicate deliveries are idempotent",
  async () => {
    const hub = await setupHub();
    const daemonA = await setupDaemon("A", hub, { alias: "requester" });
    const daemonB = await setupDaemon("B", hub, { alias: "worker" });

    try {
      let handleB = "";
      let nodeIdB = "";
      let endpointIdB = "";
      let nodeIdA = "";
      let endpointIdA = "";
      await waitUntil(async () => {
        const peersFromA = await daemonA.runtime.agentMessaging!.listReachable({
          coordinatorSession: daemonA.coordinatorSession,
        });
        const peerB = peersFromA.find(
          (p) => p.sessionAlias === "worker" && p.endpointKind === "logical",
        );
        if (!peerB) return false;
        handleB = encodeAgentHandle(peerB.address);
        nodeIdB = peerB.address.nodeId;
        endpointIdB = peerB.address.endpointId;
        // A's own canonical endpoint, as published to (and seen by) B.
        const peersFromB = await daemonB.runtime.agentMessaging!.listReachable({
          coordinatorSession: daemonB.coordinatorSession,
        });
        const peerA = peersFromB.find(
          (p) => p.sessionAlias === "requester" && p.endpointKind === "logical",
        );
        if (!peerA) return false;
        nodeIdA = peerA.address.nodeId;
        endpointIdA = peerA.address.endpointId;
        return true;
      });
      const noneReceipt = await daemonA.runtime.agentMessaging!.send(
        { coordinatorSession: daemonA.coordinatorSession },
        { to: handleB, content: "one way only" },
      );

      // Forgery 1: completion for a completion=none request → DELIVERY_DENIED.
      // Forgery 2: completion for a completely unknown request id → DELIVERY_DENIED.
      const forgedInputs = [
        {
          requestMessageId: noneReceipt.messageId,
          source: { nodeId: nodeIdB, endpointId: endpointIdB },
          target: { nodeId: nodeIdB, endpointId: endpointIdB },
          status: "completed" as const,
          result: "smuggled",
          completedAt: Date.now(),
        },
        {
          requestMessageId: "msg_totally_unknown",
          source: { nodeId: nodeIdB, endpointId: endpointIdB },
          target: { nodeId: nodeIdB, endpointId: endpointIdB },
          status: "completed" as const,
          result: "smuggled",
          completedAt: Date.now(),
        },
      ];
      for (const forged of forgedInputs) {
        let denied = false;
        try {
          await daemonA.runtime.control.deliverPeerCompletion(forged as never);
        } catch (error) {
          denied =
            error instanceof Error &&
            (error as Error & { code?: string }).code === "DELIVERY_DENIED";
        }
        expect(denied).toBe(true);
      }

      // Real request: A requests completion=result from B.
      const receipt = await daemonA.runtime.agentMessaging!.send(
        { coordinatorSession: daemonA.coordinatorSession },
        { to: handleB, content: "compute the answer", completion: "result" },
      );

      // Wait for the automatic round trip to land on A's mock agent.
      await waitUntil(
        async () => {
          const prompts = await daemonA.readPrompts();
          return prompts.some((t) =>
            t.includes('<xacpx-peer-result origin="xacpx-server"'),
          );
        },
        40_000,
      );

      // Duplicate Relay delivery (at-least-once transport): the source effect
      // must be idempotent — the router reports deduplicated and injects nothing.
      const dupRes = await daemonA.runtime.control.deliverPeerCompletion({
        requestMessageId: receipt.messageId,
        source: { nodeId: nodeIdA, endpointId: endpointIdA },
        target: { nodeId: nodeIdB, endpointId: endpointIdB },
        status: "completed",
        result: "replayed result",
        completedAt: Date.now(),
      } as never);
      expect(dupRes.deduplicated).toBe(true);
      const completionTurns = (await daemonA.readPrompts()).filter((t) =>
        t.includes('<xacpx-peer-result origin="xacpx-server"'),
      );
      expect(completionTurns).toHaveLength(1);

      // The replayed result body must NOT have leaked into the delivered turn.
      expect(completionTurns[0]!).not.toContain("replayed result");
    } finally {
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  { timeout: 120_000 },
);

test(
  "Completion Hard Gate (Gate R): archiving the source mid-flight does not strand the completion — status is recorded, source stays archived, no turn starts",
  async () => {
    const hub = await setupHub();
    const daemonA = await setupDaemon("A", hub, { alias: "requester" });
    const daemonB = await setupDaemon("B", hub, { alias: "worker" });

    try {
      let handleB = "";
      await waitUntil(async () => {
        const peers = await daemonA.runtime.agentMessaging!.listReachable({
          coordinatorSession: daemonA.coordinatorSession,
        });
        const peerB = peers.find(
          (p) => p.sessionAlias === "worker" && p.endpointKind === "logical",
        );
        if (!peerB) return false;
        handleB = encodeAgentHandle(peerB.address);
        return true;
      });

      const promptsBeforeArchive = (await daemonA.readPrompts()).length;

      // A requests completion=result; B starts its turn.
      const sendResponse = JSON.parse(
        await daemonA.runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "send-gate-r",
            method: "agent.send",
            params: {
              coordinatorSession: daemonA.coordinatorSession,
              to: handleB,
              message: "long running task",
              completion: "result",
            },
          }),
        ),
      );
      expect(sendResponse.ok).toBe(true);
      const receipt = sendResponse.result;

      // While B is working, the user archives A (A disappears from the
      // published directory — correct discoverability behavior).
      await daemonA.runtime.control.archiveSession(daemonA.chatKey, daemonA.sessionAlias);

      // The Hub routes the completion via the PRIVATE route grant recorded at
      // request time — not via the live directory. The archived source's
      // sender card is patched durably…
      await waitUntil(
        async () => {
          const page = hub.runtime.messages.listBySession(
            hub.account.id,
            (
              hub.instances.listByAccount(hub.account.id).find(
                (i) => i.name === "inst-A",
              ) ?? { id: "" }
            ).id,
            daemonA.sessionAlias,
          );
          const sentCard = page.messages.find(
            (m) =>
              m.structured?.agentMessage?.messageId === receipt.messageId &&
              m.structured.agentMessage.direction === "sent",
          );
          return sentCard?.structured?.agentMessage?.completionStatus === "completed";
        },
        40_000,
        async () =>
          `prompts=${JSON.stringify(await daemonA.readPrompts())}`,
      );

      // …and the card's original content is intact (patch-only semantics).
      const page2 = hub.runtime.messages.listBySession(
        hub.account.id,
        (
          hub.instances.listByAccount(hub.account.id).find(
            (i) => i.name === "inst-A",
          ) ?? { id: "" }
        ).id,
        daemonA.sessionAlias,
      );
      const card = page2.messages.find(
        (m) => m.structured?.agentMessage?.messageId === receipt.messageId,
      );
      expect(card?.structured?.agentMessage?.content).toBe("long running task");

      // A remains archived and NO new turn started on it.
      const promptsAfter = await daemonA.readPrompts();
      expect(promptsAfter.length).toBe(promptsBeforeArchive);
    } finally {
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  { timeout: 120_000 },
);

test(
  "Peer Interrupt Hard Gate (G10+G11): interrupting a completion-bearing peer turn cancels the old contract exactly once; the interrupt's own result contract stays independent",
  async () => {
    const hub = await setupHub();
    const daemonA = await setupDaemon("A", hub, { alias: "interruptor" });
    const daemonB = await setupDaemon("B", hub, { alias: "worker" });
    const daemonC = await setupDaemon("C", hub, { alias: "requester" });

    try {
      const discover = async (daemon: RealDaemon) => {
        let handle = "";
        await waitUntil(async () => {
          const peers = await daemon.runtime.agentMessaging!.listReachable({
            coordinatorSession: daemon.coordinatorSession,
          });
          const peerB = peers.find(
            (p) =>
              p.sessionAlias === "worker" &&
              p.endpointKind === "logical" &&
              p.capabilities.interrupt === true,
          );
          if (!peerB) return false;
          handle = encodeAgentHandle(peerB.address);
          return true;
        });
        return handle;
      };
      const handleB = await discover(daemonA);

      // 1. C → B: a completion=result peer request whose turn BLOCKS while
      // already emitting partial assistant text (real busy predecessor).
      const cSend = JSON.parse(
        await daemonC.runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "c-send-1",
            method: "agent.send",
            params: {
              coordinatorSession: daemonC.coordinatorSession,
              to: handleB,
              message: "delay-9000-partial old-schema migration",
              completion: "result",
            },
          }),
        ),
      );
      expect(cSend.ok).toBe(true);
      const cMsgId = cSend.result.messageId as string;

      // 2. B is really running C's peer turn, partial output already emitted.
      await waitUntil(
        async () =>
          (await daemonB.readPrompts()).some((t) => t.includes(cMsgId)),
        40_000,
      );

      // 3. A interrupts B through the REAL relay route.
      const aSend = JSON.parse(
        await daemonA.runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "a-send-1",
            method: "agent.send",
            params: {
              coordinatorSession: daemonA.coordinatorSession,
              to: handleB,
              message: "FINAL_INTERRUPT_RESULT switch to the new schema now",
              mode: "interrupt",
              completion: "result",
            },
          }),
        ),
      );
      expect(aSend.ok).toBe(true);
      // Busy-target receipt (spec §6.4): reservation held, cancel signalled.
      expect(aSend.result).toMatchObject({
        status: "queued",
        modeUsed: "interrupt",
        targetState: "running",
      });

      // 4. C's contract terminates EXACTLY once (G10). The terminal STATUS is
      // transport-owned: whether acpx's cancel unwinds the in-flight prompt as
      // "cancelled" or the provider finishes the turn is below the v0.4
      // boundary (plan principle 2 — no acpx/ACP changes). v0.4 owns the
      // exactly-once terminal routing and the lane ordering, both asserted
      // deterministically at the TurnQueue seam (G1.7a/b).
      await waitUntil(
        async () =>
          (await daemonC.readPrompts()).filter(
            (t) =>
              t.includes("xacpx-peer-completion") ||
              t.includes("xacpx-peer-result"),
          ).length === 1,
        40_000,
        async () =>
          `C prompts: ${JSON.stringify(await daemonC.readPrompts())} | B prompts: ${JSON.stringify((await daemonB.readPrompts()).map((t) => t.slice(0, 200)))}`,
      );
      const cCompletions = (await daemonC.readPrompts()).filter(
        (t) =>
          t.includes("xacpx-peer-completion") || t.includes("xacpx-peer-result"),
      );
      expect(cCompletions).toHaveLength(1);
      expect(cCompletions[0]).toContain(`request-id="${cMsgId}"`);

      // 5. A's own result contract completes with ONLY the new peer turn's
      // output — the cancelled predecessor's partial text never leaks (G11).
      await waitUntil(
        async () =>
          (await daemonA.readPrompts()).some((t) =>
            t.includes("<xacpx-peer-result"),
          ),
        40_000,
      );
      const aResults = (await daemonA.readPrompts()).filter((t) =>
        t.includes("<xacpx-peer-result"),
      );
      expect(aResults).toHaveLength(1);
      expect(aResults[0]).toContain('status="completed"');
      expect(aResults[0]).toContain("FINAL_INTERRUPT_RESULT");
      expect(aResults[0]).not.toContain("delay-9000-partial");

      // 6. B ran A's interrupt turn exactly once, after the old turn settled.
      const bPrompts = await daemonB.readPrompts();
      expect(
        bPrompts.filter((t) => t.includes("FINAL_INTERRUPT_RESULT")),
      ).toHaveLength(1);
    } finally {
      await daemonA.dispose();
      await daemonB.dispose();
      await daemonC.dispose();
      await hub.close();
    }
  },
  { timeout: 120_000 },
);

test(
  "Peer Interrupt Hard Gate (G13+G9): same-account relay interrupt runs once on the target daemon; archiving the target before settlement terminates the interrupt without resurrection",
  async () => {
    const hub = await setupHub();
    const daemonA = await setupDaemon("A", hub, { alias: "interruptor" });
    const daemonB = await setupDaemon("B", hub, { alias: "worker" });

    try {
      let handleB = "";
      await waitUntil(async () => {
        const peers = await daemonA.runtime.agentMessaging!.listReachable({
          coordinatorSession: daemonA.coordinatorSession,
        });
        const peerB = peers.find(
          (p) =>
            p.sessionAlias === "worker" &&
            p.endpointKind === "logical" &&
            p.capabilities.interrupt === true,
        );
        if (!peerB) return false;
        handleB = encodeAgentHandle(peerB.address);
        return true;
      });

      // B busy on a REAL human turn that blocks with partial output. Fire-and-
      // forget: control.prompt resolves only when the TURN completes, and the
      // gate must interrupt while it is still running. The promise resolves
      // {ok:false} once the interrupt cancels it — intentionally unobserved.
      void daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "delay-9000-partial human baseline work",
        senderId: "human",
      });
      await waitUntil(
        async () =>
          (await daemonB.readPrompts()).some((t) =>
            t.includes("human baseline work"),
          ),
        40_000,
      );

      // A → B interrupt across the hub. The source daemon never touches B's
      // lane: all preemption happens inside B's TurnQueue.
      const aSend = JSON.parse(
        await daemonA.runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "a-send-2",
            method: "agent.send",
            params: {
              coordinatorSession: daemonA.coordinatorSession,
              to: handleB,
              message: "RELAY_INTERRUPT_MARKER deliver next",
              mode: "interrupt",
              completion: "result",
            },
          }),
        ),
      );
      expect(aSend.ok).toBe(true);
      expect(aSend.result).toMatchObject({
        status: "queued",
        modeUsed: "interrupt",
        targetState: "running",
      });

      // Exactly one interrupt turn on B; its result crosses the hub back to A.
      await waitUntil(
        async () =>
          (await daemonB.readPrompts()).filter((t) =>
            t.includes("RELAY_INTERRUPT_MARKER"),
          ).length === 1,
        40_000,
      );
      await waitUntil(
        async () =>
          (await daemonA.readPrompts()).some((t) =>
            t.includes("<xacpx-peer-result") &&
            t.includes('status="completed"'),
          ),
        40_000,
      );
      // A's result can only arrive after B's interrupt turn FINISHED, so this
      // assertion needs no settle sleep: a duplicate execution would already
      // be visible here.
      expect(
        (await daemonB.readPrompts()).filter((t) =>
          t.includes("RELAY_INTERRUPT_MARKER"),
        ).length,
      ).toBe(1); // no duplicate execution after settle

      // --- Archive race (G9 through the real lifecycle): B busy again, A
      // interrupts, then B's session is cleared BEFORE the interrupt settles.
      void daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "delay-9000-partial human second round",
        senderId: "human",
      });
      await waitUntil(
        async () =>
          (await daemonB.readPrompts()).some((t) =>
            t.includes("human second round"),
          ),
        40_000,
      );
      const aSend2 = JSON.parse(
        await daemonA.runtime.orchestration.server.handleLine(
          JSON.stringify({
            id: "a-send-3",
            method: "agent.send",
            params: {
              coordinatorSession: daemonA.coordinatorSession,
              to: handleB,
              message: "ARCHIVE_RACE_MARKER never deliver",
              mode: "interrupt",
              completion: "result",
            },
          }),
        ),
      );
      expect(aSend2.ok).toBe(true);
      expect(aSend2.result.status).toBe("queued");
      const aMsg2 = aSend2.result.messageId as string;

      // Lifecycle teardown while the predecessor unwinds: drops the pending
      // interrupt and resolves A's contract as terminal cancelled.
      await daemonB.runtime.control.clearSession(daemonB.chatKey, daemonB.sessionAlias);

      await waitUntil(
        async () =>
          (await daemonA.readPrompts()).some(
            (t) =>
              t.includes("xacpx-peer-completion") &&
              t.includes(`request-id="${aMsg2}"`) &&
              t.includes('status="cancelled"'),
          ),
        40_000,
      );
      // No resurrection: the archived target never executes the interrupt.
      expect(
        (await daemonB.readPrompts()).filter((t) =>
          t.includes("ARCHIVE_RACE_MARKER"),
        ),
      ).toHaveLength(0);
    } finally {
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  { timeout: 180_000 },
);
