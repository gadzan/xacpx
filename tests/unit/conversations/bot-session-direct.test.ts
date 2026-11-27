import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { registerKnownChannelId } from "../../../src/channels/channel-scope";
import type { AppConfig } from "../../../src/config/types";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import { createControlEventBus } from "../../../src/control/control-event-bus";
import {
  createConversationRuntime,
  createProductionOwnedSessionRelease,
} from "../../../src/conversations/conversation-composition";
import {
  DirectMessagingService,
  type SessionPeerDeliveryInput,
} from "../../../src/conversations/direct-messaging";
import { renderDirectMentionsBlock, parseDirectInputMetadata } from "../../../src/conversations/direct-input-metadata";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import { SessionService } from "../../../src/sessions/session-service";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createEmptyState, type AppState, type LogicalSession } from "../../../src/state/types";
import type { Agent } from "../../../src/weixin/agent/interface";

registerKnownChannelId("relay");

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

async function compose(stateStore: MemoryStateStore, options: { agent?: Agent } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-bot-session-"));
  const state = createEmptyState();
  const sqlitePath = join(dir, "conversations.sqlite");
  const config = createConfig();
  const stateMutex = new AsyncMutex();
  const sessions = new SessionService(config, stateStore, state, { stateMutex });
  const events = createControlEventBus();
  const control = new ControlService({
    agent: options.agent ?? { chat: async () => ({ text: "ok" }) },
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
    uploadStore: { save: async () => ({ id: "u", path: "/tmp/u", filename: "f", mimeType: "text/plain", size: 1 }) },
  } as never);
  const kernel = conversationKernel(control);
  const runtime = await createConversationRuntime({
    config,
    state,
    stateStore,
    sessions,
    control: kernel,
    sqlitePath,
    releaseOwnedSession: createProductionOwnedSessionRelease({
      sessions,
      transport: { async deleteSession() {}, async releaseLogicalSession() {} },
    }),
    onProductEvent: (event) => kernel.emitConversationProduct(event),
    autoKick: false,
    stateMutex,
  });
  kernel.bindConversationRuntime(runtime);
  return { state, sessions, control, runtime, sqlitePath };
}

function fakeSession(alias: string, extra?: Partial<LogicalSession>): LogicalSession {
  return {
    alias,
    agent: "codex",
    workspace: "/tmp/backend",
    transport_session: `backend:${alias}`,
    logical_session_id: `ls-${alias}`,
    ...extra,
  } as unknown as LogicalSession;
}

test("peerScope session shape: deterministic topic per session, hidden from listTopics", async () => {
  const current = await compose(new MemoryStateStore());
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const conv = createDirectConversationId(a.id);
    const first = await current.runtime.runs.ensurePeerTopic(a.id, {
      sourceKind: "session",
      sourceSessionAlias: "backend",
      sourceChatKey: "chat-1",
    });
    const replay = await current.runtime.runs.ensurePeerTopic(a.id, {
      sourceKind: "session",
      sourceSessionAlias: "backend",
      sourceChatKey: "chat-1",
    });
    expect(replay.id).toBe(first.id);
    expect(first.id.startsWith("topic_peer_")).toBe(true);
    expect(first.peerScope).toEqual({
      sourceKind: "session",
      sourceSessionAlias: "backend",
      sourceChatKey: "chat-1",
    });
    const otherChat = await current.runtime.runs.ensurePeerTopic(a.id, {
      sourceKind: "session",
      sourceSessionAlias: "backend",
      sourceChatKey: "chat-2",
    });
    expect(otherChat.id).not.toBe(first.id);
    const botScope = await current.runtime.runs.ensurePeerTopic(a.id, {
      sourceConversationId: conv,
      sourceTopicId: createDirectTopicId(a.id),
      sourceBotId: a.id,
    });
    expect(botScope.id).not.toBe(first.id);
    expect(botScope.peerScope?.sourceKind ?? "bot").toBe("bot");
    const listed = current.control.listTopics(conv).map((t) => t.id);
    expect(listed).not.toContain(first.id);
    expect(listed).not.toContain(botScope.id);
    expect(current.runtime.runs.isPeerTopic(first.id)).toBe(true);
  } finally {
    await current.runtime.shutdown();
  }
});

test("dispatchedSession persists across SQLite reopen", async () => {
  const current = await compose(new MemoryStateStore());
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    const conversationId = createDirectConversationId(a.id);
    const topicId = createDirectTopicId(a.id);
    const written = current.runtime.store.appendSystemDispatchedSessionMessage({
      conversationId,
      topicId,
      content: "dispatched to backend",
      dispatchedSession: {
        sessionAlias: "backend",
        displayName: "Backend",
        agent: "codex",
        workspace: "/tmp/backend",
        taskPreview: "hello",
      },
      senderBotId: a.id,
    });
    expect(written.dispatchedSession?.sessionAlias).toBe("backend");
    expect(current.runtime.store.getMessage(written.id)?.dispatchedSession).toEqual(
      written.dispatchedSession,
    );
    await current.runtime.shutdown();
    const reopened = await SqliteConversationStore.open(current.sqlitePath);
    try {
      expect(reopened.getMessage(written.id)?.dispatchedSession).toEqual(written.dispatchedSession);
      // Idempotent migration: a second open over the migrated schema works.
      const again = reopened.appendSystemDispatchedSessionMessage({
        conversationId,
        topicId,
        content: "second receipt",
        dispatchedSession: { sessionAlias: "backend", agent: "codex", workspace: "/tmp/backend" },
      });
      expect(again.dispatchedSession?.sessionAlias).toBe("backend");
    } finally {
      reopened.close();
    }
  } finally {
    await current.runtime.shutdown().catch(() => {});
  }
});

test("bot->session send calls deliverToSession with replyTo; brt_ and archived excluded", async () => {
  const delivered: SessionPeerDeliveryInput[] = [];
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let seen = 0;
  let accepted: { run: { id: string } } | undefined;
  let current!: Awaited<ReturnType<typeof compose>>;
  current = await compose(new MemoryStateStore(), {
    agent: {
      chat: async (request) => {
        // First turn is the source Bot execution: drive bot->session sends inline.
        if (++seen === 1) {
          const token = (request.metadata as { directExecutionToken?: string })?.directExecutionToken;
          expect(token?.startsWith("direct-execution:")).toBe(true);
          const store = current.runtime.store;
          const member = store.listMemberTurns(accepted!.run.id).find((m) => m.state === "running")!;
          const dispatch = store.getDispatchForMemberTurn(member.id)!;
          const dms = new DirectMessagingService({
            state: current.state,
            bots: current.runtime.bots,
            store,
            runs: current.runtime.runs,
            nodeId: "test-node",
            listSessions: () => [
              { alias: "backend", displayName: "Backend", agent: "codex", workspace: "/tmp/backend", archived: false },
              { alias: "brt_hidden", agent: "codex", workspace: "/tmp/backend", archived: false },
              { alias: "old", agent: "codex", workspace: "/tmp/backend", archived: true },
            ],
            deliverToSession: async (input) => {
              delivered.push(input);
            },
          });
          const listed = dms.registry.list(member.botId).filter((e) => e.kind === "session");
          expect(listed.map((e) => e.handle)).toEqual(["backend"]);
          expect(listed[0]?.sessionAlias).toBe("backend");
          const resolved = dms.registry.resolve(member.botId, "backend");
          expect(resolved.kind).toBe("session");
          const binding = dms.bindExecution({
            memberTurnId: member.id,
            sourceTurnId: member.sourceTurnId!,
            dispatchId: dispatch.id,
            owner: dispatch.owner!,
            generation: dispatch.generation,
          });
          // NOTE: sends must use THIS registry instance's binding token — the
          // dispatcher's metadata token belongs to a different service instance.
          const handle = { coordinatorSession: binding.token, sourceHandle: binding.token };
          const one = await dms.send(handle, { to: "backend", content: "hello from bot", replyTo: "orig-1" });
          const two = await dms.send(handle, { to: "backend", content: "hello from bot", replyTo: "orig-1" });
          expect(one.status).toBe("queued");
          expect(two.messageId).toBe(one.messageId);
          expect(delivered).toHaveLength(2);
          expect(delivered[0]).toMatchObject({
            toSessionAlias: "backend",
            fromBotId: member.botId,
            fromName: "A",
            content: "hello from bot",
            messageId: one.messageId,
            replyTo: "orig-1",
          });
          resolveGate();
          await gate;
        }
        return { text: "ok" };
      },
    },
  });
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    accepted = await current.control.promptConversation({
      conversationId: createDirectConversationId(a.id),
      topicId: createDirectTopicId(a.id),
      requestId: "bot-session-source",
      text: "source work",
    });
    await current.runtime.dispatcher.kick();
    const detail = await current.control.getRun(accepted.run.id);
    expect(detail.state).toBe("completed");
    expect(delivered).toHaveLength(2);
  } finally {
    resolveGate?.();
    await current.runtime.shutdown();
  }
});

test("session->bot deliverFromSession lands in private peer topic with replyTo", async () => {
  const current = await compose(new MemoryStateStore());
  try {
    const b = await current.control.createBot({ name: "B", agent: "codex", workspace: "backend" });
    current.state.sessions["backend"] = fakeSession("backend");
    const out = await current.runtime.directMessaging.deliverFromSession({
      fromSessionAlias: "backend",
      fromName: "Backend",
      content: "hi bot",
      messageId: "sess-1",
      replyTo: "r1",
      toBotId: b.id,
    });
    expect(out.messageId).toBe("sess-1");
    const conv = createDirectConversationId(b.id);
    const peer = Object.values(current.state.conversation_topics).find((t) => !!t.peerScope)!;
    expect(peer.conversationId).toBe(conv);
    expect(peer.peerScope).toEqual({
      sourceKind: "session",
      sourceSessionAlias: "backend",
      sourceChatKey: "backend",
    });
    expect(current.control.listTopics(conv).some((t) => t.id === peer.id)).toBe(false);
    const runs = current.runtime.store.listRuns(conv, peer.id);
    expect(runs).toHaveLength(1);
    const request = current.runtime.store.getMessage(runs[0]!.requestMessageId)!;
    expect(request.inputMetadata?.peer).toMatchObject({
      messageId: "sess-1",
      fromHandle: "backend",
      fromName: "Backend",
      fromKind: "session",
      replyTo: "r1",
      depth: 1,
    });
    // Idempotent on messageId: a retry replays the same durable admission.
    const replay = await current.runtime.directMessaging.deliverFromSession({
      fromSessionAlias: "backend",
      fromName: "Backend",
      content: "hi bot",
      messageId: "sess-1",
      toBotId: b.id,
    });
    expect(replay.messageId).toBe("sess-1");
    expect(current.runtime.store.listRuns(conv, peer.id)).toHaveLength(1);
  } finally {
    await current.runtime.shutdown();
  }
});

test("human @ mentions of sessions resolve and serialize to <xacpx-mentions>", async () => {
  const current = await compose(new MemoryStateStore());
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    current.state.sessions["backend"] = fakeSession("backend", { display_name: "Backend" });
    const dms = new DirectMessagingService({
      state: current.state,
      bots: current.runtime.bots,
      store: current.runtime.store,
      runs: current.runtime.runs,
      nodeId: "test-node",
    });
    const resolved = dms.registry.mentions(a.id, [{ range: [0, 8] as [number, number], handle: "backend" }]);
    expect(resolved[0]?.sessionAlias).toBe("backend");
    expect(resolved[0]?.displayName).toBe("Backend");
    dms.registry.revalidate(a.id, resolved);
    const block = renderDirectMentionsBlock(resolved);
    expect(block).toContain("<xacpx-mentions");
    expect(block).toContain('kind="session"');
    expect(block).toContain('target="backend"');
    // Legacy durable peer rows without identity fields still parse (bot back-compat).
    const legacy = parseDirectInputMetadata("hi", {
      version: 1,
      peer: {
        messageId: "m",
        sourceBotId: a.id,
        sourceConversationId: createDirectConversationId(a.id),
        sourceTopicId: createDirectTopicId(a.id),
        depth: 1,
      },
    });
    expect(legacy.peer?.depth).toBe(1);
  } finally {
    await current.runtime.shutdown();
  }
});

test("Bot→Bot task lands with from-kind bot; child replies via from to parent", async () => {
  let phase = 0;
  let parentRunId = "";
  let parentId = "";
  let childId = "";
  let current!: Awaited<ReturnType<typeof compose>>;
  const parentConv = () => createDirectConversationId(parentId);
  const parentTopic = () => createDirectTopicId(parentId);
  const childConv = () => createDirectConversationId(childId);
  current = await compose(new MemoryStateStore(), {
    agent: {
      chat: async () => {
        phase += 1;
        const dms = current.runtime.directMessaging;
        const store = current.runtime.store;
        if (phase === 1) {
          // Parent turn: deliver the task into the child's private peer topic
          // through the parent's own execution binding.
          const member = store.listMemberTurns(parentRunId).find((m) => m.state === "running")!;
          const dispatch = store.getDispatchForMemberTurn(member.id)!;
          const binding = dms.bindExecution({
            memberTurnId: member.id,
            sourceTurnId: member.sourceTurnId!,
            dispatchId: dispatch.id,
            owner: dispatch.owner!,
            generation: dispatch.generation,
          });
          try {
            await dms.send(
              { coordinatorSession: binding.token, sourceHandle: binding.token },
              {
                to: dms.registry.handle(childId),
                content: "parent task",
                mode: "auto",
                completion: "none",
              },
            );
          } finally {
            binding.release();
          }
          return { text: "parent ok" };
        }
        if (phase === 2) {
          // Child turn: answer the parent through the received `from` handle.
          const peerTopic = await current.runtime.runs.ensurePeerTopic(childId, {
            sourceConversationId: parentConv(),
            sourceTopicId: parentTopic(),
            sourceBotId: parentId,
          });
          const run = store.listRuns(childConv(), peerTopic.id).find((r) => r.state === "running")!;
          const member = store.listMemberTurns(run.id).find((m) => m.state === "running")!;
          const peer = store.getMessage(run.requestMessageId)?.inputMetadata?.peer;
          expect(peer?.fromKind).toBe("bot");
          expect(typeof peer?.fromHandle).toBe("string");
          const dispatch = store.getDispatchForMemberTurn(member.id)!;
          const binding = dms.bindExecution({
            memberTurnId: member.id,
            sourceTurnId: member.sourceTurnId!,
            dispatchId: dispatch.id,
            owner: dispatch.owner!,
            generation: dispatch.generation,
          });
          try {
            await dms.send(
              { coordinatorSession: binding.token, sourceHandle: binding.token },
              {
                to: peer!.fromHandle,
                content: "child reply",
                replyTo: peer!.messageId,
              },
            );
          } finally {
            binding.release();
          }
          return { text: "child ok" };
        }
        return { text: "ok" };
      },
    },
  });
  try {
    const parent = await current.control.createBot({ name: "P", agent: "codex", workspace: "backend" });
    const child = await current.control.createBot({ name: "C", agent: "codex", workspace: "backend" });
    parentId = parent.id;
    childId = child.id;
    const accepted = await current.control.promptConversation({
      conversationId: parentConv(),
      topicId: parentTopic(),
      requestId: "parent-source",
      text: "start",
    });
    parentRunId = accepted.run.id;
    await current.runtime.dispatcher.kick();
    expect((await current.control.getRun(parentRunId)).state).toBe("completed");
    await current.runtime.dispatcher.kick();
    const childPeer = await current.runtime.runs.ensurePeerTopic(childId, {
      sourceConversationId: parentConv(),
      sourceTopicId: parentTopic(),
      sourceBotId: parentId,
    });
    // The task ran in the child's private peer topic, never the default one.
    expect(childPeer.id.startsWith("topic_peer_")).toBe(true);
    const childRuns = current.runtime.store.listRuns(childConv(), childPeer.id);
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]!.state).toBe("completed");
    await current.runtime.dispatcher.kick();
    // The child's reply landed back in the parent's private peer topic.
    const parentReply = await current.runtime.runs.ensurePeerTopic(parentId, {
      sourceConversationId: childConv(),
      sourceTopicId: childPeer.id,
      sourceBotId: childId,
    });
    const replyRuns = current.runtime.store.listRuns(parentConv(), parentReply.id);
    expect(replyRuns).toHaveLength(1);
    expect(replyRuns[0]!.state).toBe("completed");
    const messages = current.runtime.store.listMessages({
      conversationId: parentConv(),
      topicId: parentReply.id,
      limit: 50,
    });
    expect(messages.some((m) => m.content.includes("child reply"))).toBe(true);
    expect(phase).toBe(3);
  } finally {
    await current.runtime.shutdown();
  }
});

test("registry hides owner-hidden sessions and shows display names", async () => {
  const current = await compose(new MemoryStateStore());
  try {
    const a = await current.control.createBot({ name: "A", agent: "codex", workspace: "backend" });
    current.state.sessions["relay:plain"] = fakeSession("relay:plain");
    current.state.sessions["relay:pretty"] = fakeSession("relay:pretty", { display_name: "Pretty" });
    current.state.sessions["relay:hidden"] = fakeSession("relay:hidden", {
      owner: { kind: "bot-direct", bindingId: "b", botId: a.id, conversationId: "c", topicId: "t" },
    });
    current.state.sessions["brt_shadow"] = fakeSession("brt_shadow");
    current.state.sessions["relay:old"] = fakeSession("relay:old", { archived: true });
    const listed = current.runtime.directMessaging.registry
      .list(a.id)
      .filter((e) => e.kind === "session");
    // Only ordinary visible sessions surface, keyed by internal alias.
    expect(listed.map((e) => e.handle).sort()).toEqual(["relay:plain", "relay:pretty"]);
    expect(listed.map((e) => e.displayName).sort()).toEqual(["Pretty", "plain"]);
    // Handles stay canonical: resolve() matches the internal alias exactly.
    const resolved = current.runtime.directMessaging.registry.resolve(a.id, "relay:pretty");
    expect(resolved.kind).toBe("session");
    if (resolved.kind === "session") {
      expect(resolved.sessionAlias).toBe("relay:pretty");
    }
  } finally {
    await current.runtime.shutdown();
  }
});
