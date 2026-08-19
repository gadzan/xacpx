import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { Hono } from "hono";
import { startRelayServer, type RelayServerHandle } from "../../packages/relay/src/server";
import { MSG, type PublishedAgentEndpointDto, type MessageRecordDto } from "@ganglion/xacpx-relay-protocol";
import { AccountStore } from "../../packages/relay/src/stores/accounts";
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

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
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

    try {
      // Warm up sessions so acpx initializes the queue owners
      const warmB = await daemonB.runtime.control.prompt({
        chatKey: daemonB.chatKey,
        sessionAlias: daemonB.sessionAlias,
        text: "warmup-B",
        senderId: "test",
        isOwner: true,
      });
      expect(warmB.ok).toBe(true);

      // 1. Wait for both daemons to connect and sync their canonical published directories to Hub
      await waitUntil(() => {
        const endpoints = hub.gateway.getPublishedEndpoints(hub.account.id);
        const hasA = endpoints.some((e) => e.displayName === "Main Coordinator");
        const hasB = endpoints.some((e) => e.displayName === "Backend Service");
        return hasA && hasB;
      });

      const published = hub.gateway.getPublishedEndpoints(hub.account.id);
      const epA = published.find((e) => e.displayName === "Main Coordinator")!;
      const epB = published.find((e) => e.displayName === "Backend Service")!;
      expect(epA).toBeDefined();
      expect(epB).toBeDefined();

      const handleA = encodeAgentHandle({ nodeId: epA.nodeId, endpointId: epA.endpointId });
      const handleB = encodeAgentHandle({ nodeId: epB.nodeId, endpointId: epB.endpointId });

      // 2. Simulate Web Client submitting prompt to Session A with structured mention for B
      const turnPromise = daemonA.runtime.control.prompt({
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
      });
      const receiptA = await daemonA.runtime.agentMessaging!.send(
        { coordinatorSession: daemonA.coordinatorSession },
        {
          to: handleB,
          content: "Can we drop legacy_id in v2?",
        },
      );
      expect(receiptA.status).toBe("queued");
      expect(receiptA.messageId).toBeDefined();

      // 5. Hard Gate: Active+idle Session B receives message and WAKES UP to execute turn
      await waitUntil(async () => {
        const promptsB = await daemonB.readPrompts();
        return promptsB.some((t) => t.includes("<xacpx-message") && t.includes("Can we drop legacy_id in v2?"));
      });
      const promptB = (await daemonB.readPrompts()).find((t) => t.includes("Can we drop legacy_id in v2?"))!;
      expect(promptB).toContain(`from="${handleA}"`);
      expect(promptB).toContain(`id="${receiptA.messageId}"`);

      // 6. Session B replies to Session A
      const replyReceipt = await daemonB.runtime.agentMessaging!.send(
        { coordinatorSession: daemonB.coordinatorSession },
        {
          to: handleA,
          content: "Yes, legacy_id is deprecated and safe to drop.",
          replyTo: receiptA.messageId,
        },
      );
      expect(replyReceipt.status).toBe("queued");

      // 7. Verify reply arrives on Session A
      await waitUntil(async () => {
        const pA = await daemonA.readPrompts();
        return pA.some((t) => t.includes("Yes, legacy_id is deprecated and safe to drop."));
      });

      // 8. Verify Timeline History Persistence in Relay Hub DB
      const instA = hub.instances.listByAccount(hub.account.id).find((i) => i.name === "inst-daemonA")!;
      const instB = hub.instances.listByAccount(hub.account.id).find((i) => i.name === "inst-daemonB")!;
      const pageA = hub.messages.listBySession(hub.account.id, instA.id, "coordinator");
      const pageB = hub.messages.listBySession(hub.account.id, instB.id, "backend");
      const messagesA = pageA.messages;
      const messagesB = pageB.messages;
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
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  60_000,
);
