import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { MSG } from "@ganglion/xacpx-relay-protocol";
import { createSqlDriver, initSchema } from "../../packages/relay/src/db";
import { AccountStore } from "../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../packages/relay/src/stores/instances";
import { InstanceGateway } from "../../packages/relay/src/gateway/instance-gateway";
import { RelayChannel } from "../../packages/channel-relay/src/channel";
import { CredentialStore } from "../../packages/channel-relay/src/credential-store";
import { MessageChannelRegistry } from "../../src/channels/channel-registry";
import { buildApp, type AppRuntime } from "../../src/main";
import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import type { AgentEndpointView } from "../../src/orchestration/agent-messaging-types";

// REAL production-wiring hard gate: two real daemons (buildApp with the full
// runtime assembly) connected through a real Relay Hub, real SessionTransport
// (npm-installed acpx) + real mock ACP agent. The final proof comes from the
// mock agent's ACTUAL prompt record: the remote <xacpx-message> envelope was
// consumed as a real next turn — not from any mocked ACK or injected seam.

const MOCK_AGENT = fileURLToPath(
  new URL("../fixtures/mock-acp-agent.mjs", import.meta.url),
);
const ACPX = resolveAcpxCommand({});

interface HubHarness {
  gateway: InstanceGateway;
  instances: InstanceStore;
  account: { id: string };
  wss: WebSocketServer;
  hubUrl: string;
  close: () => Promise<void>;
}

async function setupHub(options?: {
  dropRequestResponse?: (
    instanceId: string,
    type: string,
    payload: unknown,
  ) => boolean;
}): Promise<HubHarness> {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const account = accounts.createAccount("alice");

  const gateway = new InstanceGateway({
    instances,
    accounts,
    // Realistic delivery timeout: a real (possibly cold) acpx injection can take
    // several seconds; 2s is only viable for the in-memory component tests.
    requestTimeoutMs: 30_000,
    ...(options?.dropRequestResponse
      ? { dropRequestResponse: options.dropRequestResponse }
      : {}),
  });

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));
  const port = (wss.address() as { port: number }).port;

  return {
    gateway,
    instances,
    account,
    wss,
    hubUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      wss.close();
    },
  };
}

interface RealDaemon {
  runtime: AppRuntime;
  home: string;
  workspace: string;
  channel: RelayChannel;
  channelStart: Promise<void>;
  abort: AbortController;
  chatKey: string;
  sessionAlias: string;
  coordinatorSession: string;
  /** This daemon's published directory (nodeId + endpoints), read from the
   *  real control facade. */
  publishedEndpoints: () => Promise<
    Array<{
      nodeId: string;
      endpointId: string;
      displayName?: string;
      agent: string;
      state: "idle" | "running";
      capabilities: {
        receive: boolean;
        steer: boolean;
        queue: boolean;
        interrupt: boolean;
      };
    }>
  >;
  promptsFile: string;
  dispose: () => Promise<void>;
}

const savedEnv = new Map<string, string | undefined>();

async function makeRealDaemon(
  label: string,
  hubUrl: string,
  pairingToken: string,
): Promise<RealDaemon> {
  const home = await mkdtemp(join(tmpdir(), `xacpx-hardgate-home-${label}-`));
  const workspace = await mkdtemp(
    join(tmpdir(), `xacpx-hardgate-ws-${label}-`),
  );
  await writeFile(
    join(home, "config.json"),
    `${JSON.stringify(
      {
        transport: {
          type: "acpx-cli",
          command: ACPX,
          permissionMode: "approve-all",
          nonInteractivePermissions: "deny",
          // Longer TTL than the compat tests: the remote send happens after the
          // peer's warm-up turn plus directory propagation, so a 5s owner would
          // expire mid-test and force slow cold injections.
          queueOwnerTtlSeconds: 60,
          sessionInitTimeoutMs: 60_000,
        },
        agents: {
          custom: { driver: "mock", argv: ["node", MOCK_AGENT] },
        },
        workspaces: { ws: { cwd: workspace } },
        channels: [
          {
            id: "relay",
            type: "relay",
            enabled: true,
            options: {
              url: hubUrl,
              pairingToken,
              name: `daemon-${label}`,
              terminal: { enabled: false },
            },
          },
        ],
        logging: { level: "error" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(home, "state.json"), `${JSON.stringify({}, null, 2)}\n`);

  const channel = new RelayChannel(
    { url: hubUrl, pairingToken, name: `daemon-${label}` } as never,
    {
      credentialStore: new CredentialStore(join(home, "credential.json")),
      terminalRegistryDir: join(home, "relay"),
      endpointSyncDebounceMs: 50,
    },
  );
  const channels = new MessageChannelRegistry([channel]);
  const runtime = await buildApp(
    {
      configPath: join(home, "config.json"),
      statePath: join(home, "state.json"),
      orchestrationSocketPath: join(home, "orchestration.sock"),
    },
    {
      channel: channels,
      canReapQueueOwners: () => true,
    },
  );

  const abort = new AbortController();
  const channelStart = channels.startAll({
    agent: runtime.agent,
    abortSignal: abort.signal,
    quota: runtime.quota,
    logger: runtime.logger,
    coreVersion: "0.18.0",
    control: runtime.control,
    sessionResources: runtime.sessionResources,
    activeTurns: runtime.activeTurns,
  } as never);

  const chatKey = `relay:alice`;
  const sessionAlias = label.toLowerCase();

  return {
    runtime,
    home,
    workspace,
    channel,
    channelStart,
    abort,
    chatKey,
    sessionAlias,
    coordinatorSession: "",
    publishedEndpoints: async () =>
      await runtime.control.getPublishedAgentEndpoints(),
    promptsFile: join(workspace, ".mock-agent-prompts.json"),
    dispose: async () => {
      abort.abort();
      await channelStart.catch(() => {});
      await runtime.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function waitForPrompts(
  daemon: RealDaemon,
  expectedCount: number,
  deadlineMs = 30_000,
): Promise<string[]> {
  const deadline = Date.now() + deadlineMs;
  let observed: string[] = [];
  while (Date.now() < deadline) {
    try {
      observed = JSON.parse(await readFile(daemon.promptsFile, "utf8"));
      if (observed.length >= expectedCount) break;
    } catch {
      // file not written yet
    }
    await Bun.sleep(100);
  }
  return observed;
}

async function waitForPromptMarker(
  daemon: RealDaemon,
  marker: string,
  deadlineMs = 60_000,
): Promise<string[]> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const prompts = JSON.parse(await readFile(daemon.promptsFile, "utf8")) as string[];
      if (prompts.some((prompt) => prompt.includes(marker))) return prompts;
    } catch {
      // file not written yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`prompt marker did not arrive: ${marker}`);
}

async function waitForDirectory(
  daemon: RealDaemon,
  predicate: (endpoints: AgentEndpointView[]) => boolean,
  deadlineMs = 15_000,
): Promise<AgentEndpointView[]> {
  const deadline = Date.now() + deadlineMs;
  let list: AgentEndpointView[] = [];
  while (Date.now() < deadline) {
    list = await daemon.runtime.agentMessaging.listReachable({
      coordinatorSession: daemon.coordinatorSession,
    });
    if (predicate(list)) break;
    await Bun.sleep(100);
  }
  return list;
}

test(
  "Federation hard gate: real daemon A -> Relay Hub -> real daemon B with real acpx + mock ACP agent",
  // Real acpx cold starts, real prompt turns, and an intentional ACK loss (the
  // hub waits out its 2s request timeout) make this a slow, real-network test.
  async () => {
    // The first agentMessageDeliver response (B's ACK) is dropped at the hub:
    // A must retry with the same messageId and B must inject exactly once.
    let dropped = false;
    const hub = await setupHub({
      dropRequestResponse: (instanceId, type) => {
        if (!dropped && type === MSG.agentMessageDeliver) {
          dropped = true;
          return true;
        }
        return false;
      },
    });

    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const acpxHome = await mkdtemp(join(tmpdir(), "xacpx-hardgate-acpxhome-"));
    process.env.HOME = acpxHome;
    if (process.platform === "win32") process.env.USERPROFILE = acpxHome;

    const tokenA = hub.instances.issuePairingToken(
      hub.account.id,
      "nodeA",
      600_000,
    ).token;
    const tokenB = hub.instances.issuePairingToken(
      hub.account.id,
      "nodeB",
      600_000,
    ).token;

    const daemonA = await makeRealDaemon("A", hub.hubUrl, tokenA);
    const daemonB = await makeRealDaemon("B", hub.hubUrl, tokenB);

    try {
      // B: real session + warm-up turn through real acpx + mock ACP agent.
      const sessionB = await daemonB.runtime.control.createSession(
        daemonB.chatKey,
        daemonB.sessionAlias,
        "custom",
        "ws",
      );
      daemonB.coordinatorSession = sessionB.transportSession;
      const warmTurnB = await daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "turn-1",
        senderId: "hardgate",
        isOwner: true,
      });
      expect(warmTurnB.ok).toBe(true);

      // A: real session (its logical endpoint becomes the canonical sender).
      const sessionA = await daemonA.runtime.control.createSession(
        daemonA.chatKey,
        daemonA.sessionAlias,
        "custom",
        "ws",
      );
      daemonA.coordinatorSession = sessionA.transportSession;
      const warmTurnA = await daemonA.runtime.control.prompt({
        chatKey: daemonA.chatKey,
        sessionAlias: daemonA.sessionAlias,
        text: "turn-0",
        senderId: "hardgate",
        isOwner: true,
      });
      expect(warmTurnA.ok).toBe(true);

      // B's mock agent consumed its warm-up turn.
      const promptsB0 = await waitForPrompts(daemonB, 1);
      expect(promptsB0).toEqual(["turn-1"]);

      // Directory propagation: each daemon sees the other's real published
      // endpoint (debounced FULL sync -> hub broadcast -> snapshot replace).
      const bPublished = await daemonB.publishedEndpoints();
      const aPublished = await daemonA.publishedEndpoints();
      expect(bPublished.length).toBe(1);
      expect(aPublished.length).toBe(1);
      const bNodeId = bPublished[0]!.nodeId;
      const bEndpointId = bPublished[0]!.endpointId;
      const aNodeId = aPublished[0]!.nodeId;
      const aEndpointId = aPublished[0]!.endpointId;

      const seenByA = await waitForDirectory(daemonA, (list) =>
        list.some(
          (e) =>
            e.address.nodeId === bNodeId &&
            e.address.endpointId === bEndpointId,
        ),
      );
      expect(
        seenByA.some(
          (e) =>
            e.address.nodeId === bNodeId &&
            e.address.endpointId === bEndpointId,
        ),
      ).toBe(true);

      const seenByB = await waitForDirectory(daemonB, (list) =>
        list.some(
          (e) =>
            e.address.nodeId === aNodeId &&
            e.address.endpointId === aEndpointId,
        ),
      );
      expect(
        seenByB.some(
          (e) =>
            e.address.nodeId === aNodeId &&
            e.address.endpointId === aEndpointId,
        ),
      ).toBe(true);

      // A agent_send -> Hub -> B: the FIRST delivery's ACK is dropped; A's
      // source route retries with the SAME messageId; B deduplicates.
      const targetB = seenByA.find(
        (e) =>
          e.address.nodeId === bNodeId && e.address.endpointId === bEndpointId,
      )!;
      const receiptAtoB = await daemonA.runtime.agentMessaging.send(
        { coordinatorSession: daemonA.coordinatorSession },
        {
          to: targetB.handle,
          content: "remote-hello-from-A",
          mode: "auto",
        },
      );

      expect(dropped).toBe(true);
      expect(["injected", "queued"]).toContain(receiptAtoB.status);
      // ACK-loss retry surfaced the destination dedupe.
      expect(receiptAtoB.deduplicated).toBe(true);

      // The mock agent's ACTUAL prompt record proves the remote <xacpx-message>
      // was consumed as a real next turn — exactly once.
      const promptsB1 = await waitForPrompts(daemonB, 2);
      expect(promptsB1[0]).toBe("turn-1");
      const consumedEnvelope = promptsB1[1]!;
      expect(consumedEnvelope).toContain("&lt;xacpx-message ");
      expect(consumedEnvelope).toContain("remote-hello-from-A");
      expect(consumedEnvelope).toContain(
        'from="agent:' + aNodeId + ":" + aEndpointId + '"',
      );
      expect(consumedEnvelope).toContain('replyable="true"');
      expect(consumedEnvelope).toContain(
        'conversation-id="' + receiptAtoB.messageId + '"',
      );
      expect(consumedEnvelope.split("remote-hello-from-A").length - 1).toBe(1);
      expect(promptsB1).toHaveLength(2);

      // B replies to A over the same relay path (no ACK drop for this one).
      const targetA = seenByB.find(
        (e) =>
          e.address.nodeId === aNodeId && e.address.endpointId === aEndpointId,
      )!;
      const receiptBtoA = await daemonB.runtime.agentMessaging.send(
        { coordinatorSession: daemonB.coordinatorSession },
        {
          to: targetA.handle,
          content: "remote-reply-from-B",
          mode: "auto",
          replyTo: receiptAtoB.messageId,
        },
      );
      expect(["injected", "queued"]).toContain(receiptBtoA.status);
      expect(receiptBtoA.route).toBe("relay");

      const promptsA1 = await waitForPrompts(daemonA, 2);
      expect(promptsA1[0]).toBe("turn-0");
      const replyEnvelope = promptsA1[1]!;
      expect(replyEnvelope).toContain("&lt;xacpx-message ");
      expect(replyEnvelope).toContain("remote-reply-from-B");
      expect(replyEnvelope).toContain(
        'from="agent:' + bNodeId + ":" + bEndpointId + '"',
      );
      expect(replyEnvelope).toContain(
        'reply-to="' + receiptAtoB.messageId + '"',
      );

      // Target offline: stop daemon B; the hub removes B's endpoints and
      // broadcasts → A's remote agent_list auto-updates; routing fails fast.
      await daemonB.dispose();
      const gone = await waitForDirectory(
        daemonA,
        (list) =>
          !list.some(
            (e) =>
              e.address.nodeId === bNodeId &&
              e.address.endpointId === bEndpointId,
          ),
      );
      expect(
        gone.some(
          (e) =>
            e.address.nodeId === bNodeId &&
            e.address.endpointId === bEndpointId,
        ),
      ).toBe(false);

      await expect(
        daemonA.runtime.agentMessaging.send(
          { coordinatorSession: daemonA.coordinatorSession },
          {
            to: targetB.handle,
            content: "to-offline-B",
            mode: "auto",
          },
        ),
      ).rejects.toMatchObject({
        code: "ROUTE_UNAVAILABLE",
      });

    } finally {
      await daemonA.dispose().catch(() => {});
      await daemonB.dispose().catch(() => {});
      await hub.close();
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      savedEnv.clear();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      await rm(acpxHome, { recursive: true, force: true }).catch(() => {});
    }
  },
  { timeout: 240_000 },
);
test(
  "G13: real Relay ACK-loss retry of an interrupt is deduplicated with one reservation, one cancel request, and one interrupt turn",
  // This is a real two-daemon/acpx integration gate. The Hub deliberately
  // drops the first ACK; the retry waits on the real Relay request timeout.
  async () => {
    let dropped = false;
    const hub = await setupHub({
      dropRequestResponse: (_instanceId, type) => {
        if (!dropped && type === MSG.agentMessageDeliver) {
          dropped = true;
          return true;
        }
        return false;
      },
    });

    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const acpxHome = await mkdtemp(join(tmpdir(), "xacpx-g13-acpxhome-"));
    process.env.HOME = acpxHome;
    if (process.platform === "win32") process.env.USERPROFILE = acpxHome;

    const tokenA = hub.instances.issuePairingToken(
      hub.account.id,
      "nodeA",
      600_000,
    ).token;
    const tokenB = hub.instances.issuePairingToken(
      hub.account.id,
      "nodeB",
      600_000,
    ).token;
    const daemonA = await makeRealDaemon("G13-A", hub.hubUrl, tokenA);
    const daemonB = await makeRealDaemon("G13-B", hub.hubUrl, tokenB);

    try {
      const sessionB = await daemonB.runtime.control.createSession(
        daemonB.chatKey,
        daemonB.sessionAlias,
        "custom",
        "ws",
      );
      daemonB.coordinatorSession = sessionB.transportSession;
      const warmTurnB = await daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "G13_B_WARMUP",
        senderId: "hardgate",
        isOwner: true,
      });
      expect(warmTurnB.ok).toBe(true);
      const sessionA = await daemonA.runtime.control.createSession(
        daemonA.chatKey,
        daemonA.sessionAlias,
        "custom",
        "ws",
      );
      daemonA.coordinatorSession = sessionA.transportSession;
      const warmTurnA = await daemonA.runtime.control.prompt({
        chatKey: daemonA.chatKey,
        sessionAlias: daemonA.sessionAlias,
        text: "G13_A_WARMUP",
        senderId: "hardgate",
        isOwner: true,
      });
      expect(warmTurnA.ok).toBe(true);
      await waitForPrompts(daemonB, 1);
      await waitForPrompts(daemonA, 1);

      const bPublished = await daemonB.publishedEndpoints();
      const aPublished = await daemonA.publishedEndpoints();
      expect(bPublished).toHaveLength(1);
      expect(aPublished).toHaveLength(1);
      const bEndpoint = bPublished[0]!;
      const seenByA = await waitForDirectory(
        daemonA,
        (list) =>
          list.some(
            (endpoint) =>
              endpoint.address.nodeId === bEndpoint.nodeId &&
              endpoint.address.endpointId === bEndpoint.endpointId &&
              endpoint.capabilities.interrupt === true,
          ),
      );
      const targetB = seenByA.find(
        (endpoint) =>
          endpoint.address.nodeId === bEndpoint.nodeId &&
          endpoint.address.endpointId === bEndpoint.endpointId,
      )!;

      // A real unresolved predecessor on B. delay-9000-partial emits the
      // OLD_PREDECESSOR_OUTPUT marker immediately but keeps the turn active;
      // no deadline is asserted — early cancellation is transport-owned.
      void daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "G13_OLD_PREDECESSOR_OUTPUT delay-9000-partial",
        senderId: "hardgate",
      });
      await waitForPromptMarker(daemonB, "G13_OLD_PREDECESSOR_OUTPUT");

      // Ordinary FIFO items are submitted before the interrupt. The target
      // lane must drain interrupt first, then Q1, then Q2 after settlement.
      void daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "G13_FIFO_Q1",
        senderId: "hardgate",
      });
      void daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "G13_FIFO_Q2",
        senderId: "hardgate",
      });

      const receipt = await daemonA.runtime.agentMessaging.send(
        { coordinatorSession: daemonA.coordinatorSession },
        {
          to: targetB.handle,
          content: "G13_FINAL_INTERRUPT_RESULT",
          mode: "interrupt",
          completion: "result",
        },
      );
      expect(dropped).toBe(true);
      expect(receipt).toMatchObject({
        status: "queued",
        modeUsed: "interrupt",
        targetState: "running",
        deduplicated: true,
        route: "relay",
      });

      const promptsB = await waitForPromptMarker(daemonB, "G13_FIFO_Q2");
      const firstIndex = (marker: string): number => {
        const index = promptsB.findIndex((prompt) => prompt.includes(marker));
        expect(index, `marker must execute: ${marker}`).toBeGreaterThanOrEqual(0);
        return index;
      };
      const predecessorIndex = firstIndex("G13_OLD_PREDECESSOR_OUTPUT");
      const interruptIndex = firstIndex("G13_FINAL_INTERRUPT_RESULT");
      const q1Index = firstIndex("G13_FIFO_Q1");
      const q2Index = firstIndex("G13_FIFO_Q2");
      expect(interruptIndex).toBeGreaterThan(predecessorIndex);
      expect(interruptIndex).toBeLessThan(q1Index);
      expect(q1Index).toBeLessThan(q2Index);
      expect(
        promptsB.filter((prompt) => prompt.includes("G13_FINAL_INTERRUPT_RESULT")),
      ).toHaveLength(1);

      await waitForPromptMarker(daemonA, "G13_FINAL_INTERRUPT_RESULT");
      const completionPromptsA = (await readFile(daemonA.promptsFile, "utf8"))
        .split("\n")
        .filter((prompt) => prompt.includes("xacpx-peer-result"));
      expect(completionPromptsA).toHaveLength(1);
      expect(completionPromptsA[0]).toContain("G13_FINAL_INTERRUPT_RESULT");
    } finally {
      await daemonA.dispose().catch(() => {});
      await daemonB.dispose().catch(() => {});
      await hub.close();
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      await rm(acpxHome, { recursive: true, force: true }).catch(() => {});
    }
  },
  { timeout: 240_000 },
);
