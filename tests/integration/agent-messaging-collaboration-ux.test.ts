import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import { startRelayServer, type RelayServerHandle } from "../../packages/relay/src/server";
import {
  MSG,
  decodeEnvelope,
  parseWebServerEvent,
  webClientEnvelope,
  type PublishedAgentEndpointDto,
  type MessageRecordDto,
  type WebServerEvent,
} from "@ganglion/xacpx-relay-protocol";
import { InstanceStore } from "../../packages/relay/src/stores/instances";
import { MessageStore } from "../../packages/relay/src/stores/messages";
import { InstanceGateway } from "../../packages/relay/src/gateway/instance-gateway";
import { RelayChannel } from "../../packages/channel-relay/src/channel";
import { CredentialStore } from "../../packages/channel-relay/src/credential-store";
import { MessageChannelRegistry } from "../../src/channels/channel-registry";
import { buildApp, type AppRuntime } from "../../src/main";
import { resolveAcpxCommand } from "../../src/config/resolve-acpx-command";
import { encodeAgentHandle } from "../../src/orchestration/agent-handle";

const MOCK_AGENT = fileURLToPath(
  new URL("../fixtures/mock-acp-agent.mjs", import.meta.url),
);
const ACPX = resolveAcpxCommand({});

interface HubHarness {
  gateway: InstanceGateway;
  instances: InstanceStore;
  messages: MessageStore;
  accounts: AccountStore;
  account: { id: string; username: string };
  hubUrl: string;
  httpUrl: string;
  close: () => Promise<void>;
}

async function setupHub(): Promise<HubHarness> {
  const relay = await startRelayServer({
    dbPath: ":memory:",
    httpPort: 0,
    host: "127.0.0.1",
  });
  const account = relay.runtime.accounts.createAccount("alice");

  return {
    gateway: relay.runtime.gateway,
    instances: relay.runtime.instances,
    messages: relay.runtime.messages,
    accounts: relay.runtime.accounts,
    account: { id: account.id, username: "alice" },
    hubUrl: `ws://127.0.0.1:${relay.httpPort}`,
    httpUrl: `http://127.0.0.1:${relay.httpPort}`,
    close: async () => {
      await relay.close();
    },
  };
}

interface RealDaemon {
  runtime: AppRuntime;
  home: string;
  channel: RelayChannel;
  instanceId: string;
  wsDir: string;
  chatKey: string;
  sessionAlias: string;
  coordinatorSession: string;
  readPrompts: () => Promise<string[]>;
  dispose: () => Promise<void>;
}
async function setupDaemon(
  name: string,
  hub: HubHarness,
  options: {
    alias: string;
    displayName: string;
  },
): Promise<RealDaemon> {
  const root = await mkdtemp(join(tmpdir(), `xacpx-ux-hd-${name}-`));
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
  await runtime.control.setSessionDisplayName(
    chatKey,
    options.alias,
    options.displayName,
  );
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
    home,
    channel,
    instanceId: paired.instanceId,
    wsDir,
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
  timeoutMs = 20_000,
  context?: () => string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  const extra = context ? ` (${context()})` : "";
  throw new Error(`waitUntil timed out after ${timeoutMs}ms${extra}`);
}

test(
  "Production Collaboration UX Hard Gate: Canonical Directory -> @Mention -> Directive -> Inbound Wake -> History Persistence",
  async () => {
    const hub = await setupHub();

    const daemonA = await setupDaemon("daemonA", hub, {
      alias: "coordinator",
      displayName: "Main Coordinator",
    });

    const daemonB = await setupDaemon("daemonB", hub, {
      alias: "backend",
      displayName: "Backend Service",
    });

    const webToken = hub.accounts.createWebSession(hub.account.id, "tok-1", 600_000);
    const webWs = new WsClient(`${hub.hubUrl}/ws`, {
      headers: { cookie: `xrelay_session=${webToken}` },
    });
    const webEvents: WebServerEvent[] = [];
    webWs.on("message", (raw) => {
      const decoded = decodeEnvelope(String(raw));
      if (decoded.ok) {
        const ev = parseWebServerEvent(decoded.envelope);
        if (ev) webEvents.push(ev);
      }
    });
    await new Promise<void>((resolve, reject) => {
      webWs.on("open", () => resolve());
      webWs.on("error", reject);
    });

    try {
      const warmB = await daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "warmup-B",
        senderId: "test",
        isOwner: true,
      });
      expect(warmB.ok).toBe(true);

      let instA!: { id: string };
      let instB!: { id: string };
      await waitUntil(() => {
        const list = hub.instances.listByAccount(hub.account.id);
        const a = list.find((i) => i.name === "inst-daemonA");
        const b = list.find((i) => i.name === "inst-daemonB");
        if (a && b) {
          instA = a;
          instB = b;
          return true;
        }
        return false;
      });

      // Subscribe web client to instances
      webWs.send(JSON.stringify(webClientEnvelope({ kind: "subscribe", instanceIds: [instA.id, instB.id] })));

      await waitUntil(() => {
        const lastDir = webEvents.filter((e): e is Extract<WebServerEvent, { kind: "agent-directory" }> => e.kind === "agent-directory").pop();
        if (!lastDir) return false;
        const hasA = lastDir.endpoints.some((e) => e.displayName === "Main Coordinator");
        const hasB = lastDir.endpoints.some((e) => e.displayName === "Backend Service");
        return hasA && hasB;
      });
      // 2. Web client fetches canonical directory from HTTP bootstrap endpoint
      const dirRes = await fetch(`${hub.httpUrl}/api/agent-directory`, {
        headers: { cookie: `xrelay_session=${webToken}` },
      });
      expect(dirRes.status).toBe(200);
      const dirData = (await dirRes.json()) as { endpoints: PublishedAgentEndpointDto[] };
      const epA = dirData.endpoints.find((e) => e.displayName === "Main Coordinator")!;
      const epB = dirData.endpoints.find((e) => e.displayName === "Backend Service")!;
      expect(epA).toBeDefined();
      expect(epB).toBeDefined();
      const handleA = encodeAgentHandle({ nodeId: epA.nodeId, endpointId: epA.endpointId });
      const handleB = encodeAgentHandle({ nodeId: epB.nodeId, endpointId: epB.endpointId });
      const rpcRes = (await hub.gateway.sendRequest(instA.id, "control.prompt", {
        chatKey: daemonA.chatKey,
        sessionAlias: daemonA.sessionAlias,
        text: "Please coordinate with @Backend Service regarding schema migration",
        senderId: "user-alice",
        agentMentions: [
          {
            range: [23, 39],
            handle: handleB, // Canonical handle from published directory
          },
        ],
      })) as { ok?: boolean };
      expect(rpcRes.ok).toBe(true);
      // 4. Verify Session A executed with the trusted collaboration directive
      await waitUntil(async () => {
        const p = await daemonA.readPrompts();
        return p.some((text) => text.includes("<xacpx-collaboration-directive origin=\"xacpx-server\">"));
      });
      const turnPromptA = (await daemonA.readPrompts()).find((t) => t.includes("<xacpx-collaboration-directive origin=\"xacpx-server\">"))!;
      expect(turnPromptA).toContain(`handle="${handleB}"`);
      expect(turnPromptA).toContain('display-name="Backend Service"');
      expect(turnPromptA).toContain("<user-prompt>\nPlease coordinate with @Backend Service regarding schema migration\n</user-prompt>");
      // 5. Session A sends peer message to Session B
      const receiptA = await daemonA.runtime.agentMessaging!.send(
        { coordinatorSession: daemonA.coordinatorSession },
        {
          to: handleB,
          content: "Can we drop legacy_id in v2?",
        },
      );
      expect(receiptA.status).toBe("queued");
      expect(receiptA.messageId).toBeDefined();
      // 6. Hard Gate: Active+idle Session B WAKES UP and Relay Web receives live turn pipeline!
      await waitUntil(
        () => {
          const bStarted = webEvents.some(
            (e) => e.kind === "control-event" && e.instanceId === instB.id && e.event?.type === "turn-started",
          );
          const bOutput = webEvents.some(
            (e) => e.kind === "control-event" && e.instanceId === instB.id && e.event?.type === "turn-output",
          );
          const bFinished = webEvents.some(
            (e) => e.kind === "control-event" && e.instanceId === instB.id && e.event?.type === "turn-finished" && e.event?.ok === true,
          );
          return bStarted && bOutput && bFinished;
        },
        20_000,
        () => `webEvents=${JSON.stringify(webEvents)}`,
      );
      // Verify Session B mock agent actually consumed the inbound message
      await waitUntil(async () => {
        const promptsB = await daemonB.readPrompts();
        return promptsB.some((t) => t.includes("<xacpx-message") && t.includes("Can we drop legacy_id in v2?"));
      });
      const promptB = (await daemonB.readPrompts()).find((t) => t.includes("Can we drop legacy_id in v2?"))!;
      expect(promptB).toContain(`from="${handleA}"`);
      expect(promptB).toContain(`id="${receiptA.messageId}"`);
      // 7. Session B replies to Session A
      const replyReceipt = await daemonB.runtime.agentMessaging!.send(
        { coordinatorSession: daemonB.coordinatorSession },
        {
          to: handleA,
          content: "Yes, legacy_id is deprecated and safe to drop.",
          replyTo: receiptA.messageId,
        },
      );
      expect(replyReceipt.status).toBe("queued");
      // Verify reply arrives on Session A
      await waitUntil(async () => {
        const pA = await daemonA.readPrompts();
        return pA.some((t) => t.includes("Yes, legacy_id is deprecated and safe to drop."));
      });
      // 8. Hard Gate: Verify History Persistence in Relay Hub SQLite DB
      const pageA = hub.messages.listBySession(hub.account.id, instA.id, "coordinator");
      const pageB = hub.messages.listBySession(hub.account.id, instB.id, "backend");
      const messagesA = pageA.messages;
      const messagesB = pageB.messages;

      // Session A must have the Outbound Sent card and Inbound Received reply card
      const sentOnA = messagesA.find((m) => m.structured?.agentMessage?.direction === "sent");
      expect(sentOnA).toBeDefined();
      expect(sentOnA!.structured?.agentMessage?.content).toBe("Can we drop legacy_id in v2?");
      expect(sentOnA!.structured?.agentMessage?.peer.displayName).toBe("Backend Service");

      const replyOnA = messagesA.find((m) => m.structured?.agentMessage?.direction === "received");
      expect(replyOnA).toBeDefined();
      expect(replyOnA!.structured?.agentMessage?.content).toBe("Yes, legacy_id is deprecated and safe to drop.");
      expect(replyOnA!.structured?.agentMessage?.replyTo).toBe(receiptA.messageId);

      // Session B must have the Inbound Received card and Outbound Sent reply card
      const receivedOnB = messagesB.find((m) => m.structured?.agentMessage?.direction === "received");
      expect(receivedOnB).toBeDefined();
      expect(receivedOnB!.structured?.agentMessage?.content).toBe("Can we drop legacy_id in v2?");
      expect(receivedOnB!.structured?.agentMessage?.peer.displayName).toBe("Main Coordinator");

      const sentReplyOnB = messagesB.find((m) => m.structured?.agentMessage?.direction === "sent");
      expect(sentReplyOnB).toBeDefined();
      expect(sentReplyOnB!.structured?.agentMessage?.content).toBe("Yes, legacy_id is deprecated and safe to drop.");
      expect(sentReplyOnB!.structured?.agentMessage?.replyTo).toBe(receiptA.messageId);
    } finally {
      webWs.close();
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  60_000,
);
