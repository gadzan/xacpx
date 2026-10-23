import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import { asPublicControl } from "../../../src/control/public-control";

import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
  resolveConversationStorePath,
} from "../../../src/conversations/conversation-composition";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { ChatRequest } from "../../../src/weixin/agent/interface";

class MemoryStateStore {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
  async saveNow(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

function createConfig(): AppConfig {
  return {
    transport: { type: "acpx-cli", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1, perf: { enabled: false } },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 30,
      maxParallelTasksPerAgent: 1,
    },
  };
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function boot(input: {
  sqlitePath: string;
  state: AppState;
  stateStore: MemoryStateStore;
  authorityEpoch: string;
  ownerId: string;
  autoKick?: boolean;
  origins: string[];
  received?: ChatRequest[];
  uploadRoot?: string;
}) {
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, input.stateStore, input.state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({
    agent: {
      chat: async (request: ChatRequest) => {
        if (request.metadata?.origin) input.origins.push(request.metadata.origin);
        input.received?.push(request);
        return { text: "recovered-reply" };
      },
    },
    sessions,
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
    workspaces: {
      list: () => [{ name: "backend", cwd: "/tmp/backend" }],
      create: async () => ({ name: "backend", cwd: "/tmp/backend" }),
      remove: async () => {},
    },
    uploadStore: { root: input.uploadRoot, save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state: input.state,
    stateStore: input.stateStore,
    sessions,
    control: kernel,
    sqlitePath: input.sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: input.autoKick ?? false,
    authorityEpoch: input.authorityEpoch,
    ownerId: input.ownerId,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  if (input.autoKick) {
    await runtime.activateAfterConsumerLock();
  }
  return { control, runtime, sessions };
}

test("resolveConversationStorePath uses the daemon runtime directory", () => {
  expect(resolveConversationStorePath("/home/me/.xacpx/config.json")).toBe(
    join("/home/me/.xacpx/runtime", "conversations.sqlite"),
  );
});

test("accept persisted then new process recovers once with orchestration origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-restart-"));
  const sqlitePath = join(dir, "runtime", "conversations.sqlite");
  const stateStore = new MemoryStateStore();
  const stateA = createEmptyState();
  const origins: string[] = [];
  const processA = await boot({
    sqlitePath,
    state: stateA,
    stateStore,
    authorityEpoch: "epoch-a",
    ownerId: "owner-a",
    autoKick: false,
    origins,
  });
  const bot = await processA.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const accepted = await processA.control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-restart",
    text: "hello",
  });
  expect(accepted.run.state).toBe("queued");
  expect(origins).toEqual([]);
  await processA.runtime.shutdown();

  const restored = structuredClone(stateStore.saved.at(-1)!);
  const processB = await boot({
    sqlitePath,
    state: restored,
    stateStore: new MemoryStateStore(),
    authorityEpoch: "epoch-b",
    ownerId: "owner-b",
    autoKick: false,
    origins,
  });
  expect(processB.runtime.authorityEpoch).toBe("epoch-b");
  expect(processB.control.getRun(accepted.run.id).state).toBe("queued");
  await processB.runtime.kick();
  await waitUntil(() => processB.control.getRun(accepted.run.id).state === "completed");
  const detail = processB.control.getRun(accepted.run.id);
  expect(detail.state).toBe("completed");
  expect(detail.memberTurns).toHaveLength(1);
  expect(detail.memberTurns[0]?.origin).toBe("followup");
  expect(origins).toEqual(["orchestration"]);
  const history = processB.control.conversationHistory({ conversationId, topicId, afterSeq: 0 });
  expect(history.messages.filter((m) => m.role === "bot").map((m) => m.content)).toEqual(["recovered-reply"]);
  await processB.runtime.shutdown();
});

for (const groupPrompt of [false, true]) {
  test(`${groupPrompt ? "Group" : "Direct"} attachment-only request reaches the runner after restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "xacpx-media-restart-"));
    const sqlitePath = join(dir, "conversations.sqlite");
    const uploadRoot = join(dir, "uploads");
    const media: PromptAttachmentRef[] = [
      { id: "image", filePath: join(uploadRoot, "photo.png"), fileName: "photo.png", mimeType: "image/png", kind: "image", size: 4, previewUrl: "data:image/png;base64,AAAA" },
      { id: "document", filePath: join(uploadRoot, "report.txt"), fileName: "report.txt", mimeType: "text/plain", kind: "file", size: 8 },
    ];
    const stateStore = new MemoryStateStore();
    const first = await boot({ sqlitePath, state: createEmptyState(), stateStore, authorityEpoch: "media-a", ownerId: "media-a", origins: [], uploadRoot });
    const bot = await first.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
    let conversationId = createDirectConversationId(bot.id);
    let topicId = createDirectTopicId(bot.id);
    if (groupPrompt) {
      const colleague = await first.control.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
      const group = await first.control.createGroup({ title: "Files", botIds: [bot.id, colleague.id] });
      conversationId = group.id;
      topicId = (await first.control.createGroupTopic(group.id, "Uploads", { workspace: "backend", isolation: "shared" })).id;
    }
    const request = { conversationId, topicId, requestId: "media-restart", text: "", media,
      ...(groupPrompt ? { target: { botId: bot.id } } : {}) };
    const accepted = await asPublicControl(first.control).promptConversation(request);
    expect(accepted.message.attachments).toHaveLength(2);
    expect("filePath" in accepted.message.attachments![0]!).toBe(false);
    expect(first.runtime.store.getMessage(accepted.message.id)?.media).toEqual(media);
    await first.runtime.shutdown();
    const received: ChatRequest[] = [];
    const second = await boot({ sqlitePath, state: structuredClone(stateStore.saved.at(-1)!), stateStore: new MemoryStateStore(),
      authorityEpoch: "media-b", ownerId: "media-b", origins: [], uploadRoot, received });
    try {
      const replay = await asPublicControl(second.control).promptConversation(request);
      expect(replay.reused).toBe(true);
      expect(replay.run.id).toBe(accepted.run.id);
      await expect(second.control.promptConversation({ ...request, media: [{ ...media[0]!, fileName: "changed.png" }] }))
        .rejects.toMatchObject({ code: "request_payload_conflict" });
      expect(second.control.conversationHistory({ conversationId, topicId, afterSeq: 0 }).messages[0]!.attachments).toEqual(accepted.message.attachments);
      await second.runtime.kick();
      await waitUntil(() => second.control.getRun(accepted.run.id).state === "completed");
      expect(received).toHaveLength(1);
      expect(received[0]!.media).toEqual([
        { kind: "image", filePath: media[0]!.filePath, fileName: "photo.png", mimeType: "image/png", sizeBytes: 4,
          source: { channelId: "relay", accountId: "control", chatKey: `bot:${conversationId}:${topicId}`, messageId: "image" } },
        { kind: "file", filePath: media[1]!.filePath, fileName: "report.txt", mimeType: "text/plain", sizeBytes: 8,
          source: { channelId: "relay", accountId: "control", chatKey: `bot:${conversationId}:${topicId}`, messageId: "document" } },
      ]);
    } finally {
      await second.runtime.shutdown();
    }
  });
}

test("history after client disconnect replays the final assistant message once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-replay-"));
  const sqlitePath = join(dir, "conversations.sqlite");
  const stateStore = new MemoryStateStore();
  const origins: string[] = [];
  const live = await boot({
    sqlitePath,
    state: createEmptyState(),
    stateStore,
    authorityEpoch: "epoch-live",
    ownerId: "owner-live",
    autoKick: true,
    origins,
  });
  const bot = await live.control.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  const accepted = await live.control.promptConversation({
    conversationId,
    topicId,
    requestId: "req-replay",
    text: "hello",
  });
  await waitUntil(() => live.control.getRun(accepted.run.id).state === "completed");
  await live.runtime.shutdown();

  const restored = structuredClone(stateStore.saved.at(-1)!);
  const reconnect = await boot({
    sqlitePath,
    state: restored,
    stateStore: new MemoryStateStore(),
    authorityEpoch: "epoch-reconnect",
    ownerId: "owner-reconnect",
    autoKick: false,
    origins: [],
  });
  const page = reconnect.control.conversationHistory({ conversationId, topicId, afterSeq: 0 });
  expect(page.messages.filter((m) => m.role === "bot")).toHaveLength(1);
  expect(page.messages.find((m) => m.role === "bot")?.content).toBe("recovered-reply");
  await reconnect.runtime.shutdown();
  expect(() => reconnect.control.conversationHistory({ conversationId, topicId, afterSeq: 0 }))
    .toThrow(/closed/);
});
