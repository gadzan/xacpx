import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine.ts";
import { DiscordChannel } from "../../../../../packages/channel-discord/src/channel.ts";
import type { DiscordClientLike } from "../../../../../packages/channel-discord/src/discord-client.ts";
import type {
  DiscordButtonInteraction,
  DiscordSelectInteraction,
  OutboundBody,
} from "../../../../../packages/channel-discord/src/types.ts";
import { setChannelLocale } from "../../../../../packages/channel-discord/src/i18n/index.ts";
import type { ChannelElicitationRequest } from "xacpx/plugin-api";

/**
 * Protocol-faithful ACP end-to-end for Discord form Elicitation.
 *
 * The chain under test is the production one, not a stubbed renderer:
 *
 *   mock ACP agent (protocol-faithful, real JSON-RPC)
 *     -> acpx
 *     -> runtime worker
 *     -> RuntimeEngine host handler
 *     -> REAL DiscordChannel.requestElicitation
 *     -> Discord interaction callback (the "user")
 *     -> engine decision
 *     -> acpx
 *     -> same prompt turn completes
 *
 * So this asserts the whole spine at once, with the only fake being Discord's
 * transport (no gateway socket), which is exactly the boundary a plugin owns.
 */
const MOCK_AGENT_SOURCE = resolve(process.cwd(), "tests/fixtures/mock-elicit-discord-agent.mjs");

setChannelLocale("en");

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

interface FakeDiscordClient extends DiscordClientLike {
  emitButton: (interaction: DiscordButtonInteraction) => void;
  emitSelect: (interaction: DiscordSelectInteraction) => void;
  sent: Array<{ channelId: string; body: OutboundBody }>;
  edited: Array<{ channelId: string; messageId: string; body: OutboundBody }>;
}

function makeFakeClient(): FakeDiscordClient {
  let onButton: ((i: DiscordButtonInteraction) => void) | null = null;
  let onSelect: ((i: DiscordSelectInteraction) => void) | null = null;
  const sent: Array<{ channelId: string; body: OutboundBody }> = [];
  const edited: Array<{ channelId: string; messageId: string; body: OutboundBody }> = [];
  const client: FakeDiscordClient = {
    start: async (input) => {
      onButton = input.handlers.onButton ?? null;
      onSelect = input.handlers.onSelect ?? null;
      return { botUserId: "bot1", botTag: "Bot#0001" };
    },
    probeBot: async () => ({ botUserId: "bot1", botTag: "Bot#0001" }),
    sendMessage: async (target, body) => {
      sent.push({ channelId: target.channelId, body });
      return { messageId: `m${sent.length}` };
    },
    editMessage: async (target, messageId, body) => {
      edited.push({ channelId: target.channelId, messageId, body });
    },
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
    emitButton: (interaction) => {
      onButton?.(interaction);
    },
    emitSelect: (interaction) => {
      onSelect?.(interaction);
    },
    sent,
    edited,
  };
  return client;
}

function button(client: FakeDiscordClient, customId: string, userId: string): DiscordButtonInteraction {
  return {
    customId,
    userId,
    channelId: "c1",
    acknowledge: async () => {},
    replyEphemeral: async () => {},
    showModal: async () => {
      throw new Error("the E2E never opens a modal: it answers through a select");
    },
  };
}

function controlsOf(client: FakeDiscordClient): string[] {
  const last = client.sent[client.sent.length - 1];
  return (last?.body.components ?? []).flatMap((row) => row.components.map((c) => c.customId));
}

function idFor(client: FakeDiscordClient, action: string, fieldKey?: string): string {
  const suffix = fieldKey ? `${action}:${fieldKey}` : action;
  const found = controlsOf(client).find((id) => id.endsWith(`:${suffix}`));
  if (!found) throw new Error(`no control "${suffix}" in ${controlsOf(client).join(",")}`);
  return found;
}

async function startDiscord(client: FakeDiscordClient): Promise<{ channel: DiscordChannel; abort: AbortController }> {
  const logger = { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} };
  const abort = new AbortController();
  const channel = new DiscordChannel(
    { token: "x", dmPolicy: "open", guildPolicy: "open", requireMention: false, enableAutocomplete: false },
    { logger: logger as never, createClient: () => client, identifyStaggerMs: 0 },
  );
  const startPromise = channel.start({
    logger,
    abortSignal: abort.signal,
    agent: { chat: async () => ({ text: "ok" }) },
    activeTurns: null,
    sessions: null,
    quota: { onInbound: () => {} },
    locale: "en",
  } as never);
  for (let i = 0; i < 500; i += 1) {
    try {
      await channel.sendCoordinatorMessage({ chatKey: "discord:default:g:__probe__", text: "" });
      break;
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("not started"))) throw error;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  void startPromise.catch(() => {});
  return { channel, abort };
}

/** Wait for the Discord wizard to appear. */
async function waitForCard(client: FakeDiscordClient): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (client.sent.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (client.sent.length === 0) throw new Error("elicitation card never appeared");
}

test("a protocol-faithful agent elicits, Discord renders it, the same turn resumes (accept)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-discord-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-agent.mjs");
  await writeFile(agentFile, await Bun.file(MOCK_AGENT_SOURCE).text());

  const client = makeFakeClient();
  const { channel: discord, abort: discordAbort } = await startDiscord(client);
  let liveRejection: Error | null = null;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async (payload) => {
      // The HOST handler: this is the real production entry point the daemon
      // uses. It must hand the request to the renderer that owns the chatKey.
      const chatKey = (payload as { chatKey?: string }).chatKey ?? "discord:default:g:c1";
      const request: ChannelElicitationRequest = {
        requestId: String((payload as { elicitationRequestId?: string }).elicitationRequestId ?? "e2e-1"),
        chatKey,
        // This turn is a DM, so the route is provably private and a form may be
        // rendered at all. In production this comes from the channel's own
        // `ChatRequestMetadata`; the E2E states it explicitly for the same reason.
        chatType: "direct",
        requester: { senderId: "user-A", senderName: "Ada", isOwner: true },
        agent: {
          name: "mock-agent",
          ...(((payload as { agent?: { sessionAlias?: string } }).agent?.sessionAlias)
            ? { sessionAlias: (payload as { agent: { sessionAlias: string } }).agent.sessionAlias }
            : {}),
        },
        message: "Which environment should I deploy to?",
        mode: "form",
        fields: [
          {
            kind: "single-select",
            key: "env",
            title: "Environment",
            required: true,
            options: [
              { value: "prod", label: "Production" },
              { value: "staging", label: "Staging" },
            ],
          },
        ],
        expiresAt: Date.now() + 60_000,
        signal: (payload as { signal?: AbortSignal }).signal ?? new AbortController().signal,
      };
      const promise = discord.requestElicitation(request);
      // The engine also holds this promise; if the turn/turn-disposal rejects
      // it, the rejection must be observed here so teardown does not surface an
      // unhandled error.
      const observed = promise.catch((error: Error) => {
        liveRejection = error;
        return null;
      });
      void observed;

      // Drive the wizard exactly as a Discord user would: the opening card is
      // sent by requestElicitation itself, so its controls exist once it
      // appears. Start -> answer -> review -> submit.
      const deadline = Date.now() + 10_000;
      while (client.sent.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      client.emitButton(button(client, idFor(client, "start"), "user-A"));
      await new Promise((r) => setTimeout(r, 5));
      // Answer through the String Select VALUE — the same control a real user
      // picks — so the E2E exercises the renderer's answer path rather than a
      // test seam.
      const selectId = client.edited[client.edited.length - 1]!.body.selectRows?.[0]?.components[0]?.customId;
      if (!selectId) throw new Error("no select row on the field card");
      client.emitSelect({
        customId: selectId,
        userId: "user-A",
        channelId: "c1",
        values: ["prod"],
        acknowledge: async () => {},
        replyEphemeral: async () => {},
      });
      await new Promise((r) => setTimeout(r, 5));
      // The field card carries the review entry point.
      client.emitButton(button(client, idFor(client, "review"), "user-A"));
      await new Promise((r) => setTimeout(r, 5));
      // The review card is now the last card rendered.
      client.emitButton(button(client, idFor(client, "submit"), "user-A"));
      return promise;
    },
  } as never);

  try {
    const outcome = await engine.prompt({
      agent: "mock-agent",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "e2e-session",
      logicalSessionId: "e2e-1",
      text: "which env",
    } as never, async () => {});

    // The card really was rendered through the Discord plugin.
    expect(client.sent.length).toBeGreaterThanOrEqual(1);
    expect(client.sent[0]!.body.content).toContain("Which environment");
    // Agent identity came from the correlated request, not from the message.
    expect(client.sent[0]!.body.content).toContain("mock-agent");
    // The turn completed on the SAME prompt (no second prompt created): the
    // mock agent's only completion path is end_turn on the prompt that elicited.
    expect(outcome).toBeDefined();
    // No external abort leaked into the renderer: an accept is the terminal.
    expect(liveRejection).toBeNull();
  } finally {
    await engine.shutdown().catch(() => {});
    discordAbort.abort();
    await discord.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 60_000);

test("the user's explicit decline resumes the same ACP turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-discord-decline-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-agent.mjs");
  await writeFile(agentFile, await Bun.file(MOCK_AGENT_SOURCE).text());

  const client = makeFakeClient();
  const { channel: discord, abort: discordAbort } = await startDiscord(client);
  let rejection: Error | null = null;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async (payload) => {
      const request = {
        requestId: "e2e-decline",
        chatKey: "discord:default:g:c1",
        // A DM route: provably private, so a form may be rendered.
        chatType: "direct" as const,
        requester: { senderId: "user-A" },
        agent: { name: "mock-agent" },
        message: "Which environment?",
        mode: "form" as const,
        fields: [
          {
            kind: "single-select" as const,
            key: "env",
            title: "Environment",
            required: true,
            options: [
              { value: "prod", label: "Production" },
              { value: "staging", label: "Staging" },
            ],
          },
        ],
        expiresAt: Date.now() + 60_000,
        signal: new AbortController().signal,
      };
      const promise = discord.requestElicitation(request);
      promise.catch((error: Error) => {
        rejection = error;
      });
      const deadline = Date.now() + 10_000;
      while (client.sent.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      // Decline straight from the opening card: never entering the wizard.
      client.emitButton(button(client, idFor(client, "decline"), "user-A"));
      const decision = await promise;
      expect(decision).toEqual({ action: "decline", responderId: "user-A" });
      // Core maps decline to end_turn, so the SAME turn completes.
      return decision;
    },
  } as never);

  try {
    const outcome = await engine.prompt({
      agent: "mock-agent",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "e2e-decline-session",
      logicalSessionId: "e2e-2",
      text: "which env",
    } as never, async () => {});
    expect(outcome).toBeDefined();
    expect(rejection).toBeNull();
  } finally {
    await engine.shutdown().catch(() => {});
    discordAbort.abort();
    await discord.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 60_000);

test("the user's explicit cancel resumes the same ACP turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-elicit-discord-cancel-"));
  const workerFile = await buildWorker(dir);
  const agentFile = join(dir, "mock-agent.mjs");
  await writeFile(agentFile, await Bun.file(MOCK_AGENT_SOURCE).text());

  const client = makeFakeClient();
  const { channel: discord, abort: discordAbort } = await startDiscord(client);
  let rejection: Error | null = null;
  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir: join(dir, "state", "sessions"),
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
    permissionMode: "approve-all",
    elicitationInteractionCapable: true,
    onElicitationRequest: async () => {
      const request = {
        requestId: "e2e-cancel",
        chatKey: "discord:default:g:c1",
        // A DM route: provably private, so a form may be rendered.
        chatType: "direct" as const,
        requester: { senderId: "user-A" },
        agent: { name: "mock-agent" },
        message: "Which environment?",
        mode: "form" as const,
        fields: [
          {
            kind: "single-select" as const,
            key: "env",
            title: "Environment",
            required: true,
            options: [{ value: "prod", label: "Production" }],
          },
        ],
        expiresAt: Date.now() + 60_000,
        signal: new AbortController().signal,
      };
      const promise = discord.requestElicitation(request);
      promise.catch((error: Error) => {
        rejection = error;
      });
      const deadline = Date.now() + 10_000;
      while (client.sent.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      client.emitButton(button(client, idFor(client, "cancel"), "user-A"));
      const decision = await promise;
      expect(decision).toEqual({ action: "cancel", responderId: "user-A" });
      return decision;
    },
  } as never);

  try {
    const outcome = await engine.prompt({
      agent: "mock-agent",
      agentArgv: [process.execPath, agentFile],
      cwd: dir,
      name: "e2e-cancel-session",
      logicalSessionId: "e2e-3",
      text: "which env",
    } as never, async () => {});
    expect(outcome).toBeDefined();
    expect(rejection).toBeNull();
  } finally {
    await engine.shutdown().catch(() => {});
    discordAbort.abort();
    await discord.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, 60_000);
