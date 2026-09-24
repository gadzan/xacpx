import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import { BotService } from "../../../src/bots/bot-service";
import { createDirectBindingId } from "../../../src/domain/ids";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";

const NOW = "2026-09-15T10:00:00.000Z";

class MemoryStateStore implements Pick<StateStore, "save"> {
  public saved: AppState[] = [];
  async save(state: AppState): Promise<void> {
    this.saved.push(structuredClone(state));
  }
}

function createService(state = createEmptyState()) {
  const store = new MemoryStateStore();
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" }, claude: { driver: "claude" } },
      workspaces: { backend: { cwd: "/tmp/backend" }, frontend: { cwd: "/tmp/frontend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => "bot_fixed" },
  );
  return { service, store, state };
}

test("createBot persists a profile with a stable id independent from its name", async () => {
  const { service, state } = createService();
  const bot = await service.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    role: "review",
  });
  expect(bot.id).toBe("bot_fixed");
  expect(bot.name).toBe("Reviewer");
  expect(bot.profileRevision).toBe(1);
  expect(state.bots.bot_fixed?.id).toBe("bot_fixed");
  await service.updateBot("bot_fixed", { name: "Senior Reviewer" });
  expect(service.getBot("bot_fixed").id).toBe("bot_fixed");
  expect(service.getBot("bot_fixed").name).toBe("Senior Reviewer");
  expect(service.getBot("bot_fixed").profileRevision).toBe(2);
});

test("createBot rejects an empty name and unknown agent or workspace", async () => {
  const { service } = createService();
  await expect(service.createBot({ name: "  ", agent: "codex", workspace: "backend" })).rejects.toMatchObject({
    code: "name_required",
  });
  await expect(service.createBot({ name: "R", agent: "nope", workspace: "backend" })).rejects.toBeInstanceOf(BotError);
  await expect(service.createBot({ name: "R", agent: "codex", workspace: "nope" })).rejects.toMatchObject({
    code: "workspace_not_registered",
  });
});

test("createBot rejects cwd instead of persisting a silent no-op", async () => {
  const { service, state } = createService();
  await expect(service.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    cwd: "/tmp/backend",
  } as never)).rejects.toMatchObject({ code: "cwd_unsupported" });
  expect(state.bots.bot_fixed).toBeUndefined();
});

test("updateBot rejects agent and workspace changes after a direct runtime exists", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  state.bot_runtime_bindings.bind_direct = {
    id: "bind_direct",
    scope: "bot-direct",
    conversationId: "conversation_direct",
    topicId: "topic_default",
    botId: "bot_fixed",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sessionAlias: "brt_bind_direct",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.updateBot("bot_fixed", { agent: "codex" })).resolves.toMatchObject({ agent: "codex" });
  await expect(service.updateBot("bot_fixed", { agent: "claude" })).rejects.toMatchObject({
    code: "runtime_identity_locked",
  });
  await expect(service.updateBot("bot_fixed", { workspace: "frontend" })).rejects.toMatchObject({
    code: "runtime_identity_locked",
  });
  expect(service.getBot("bot_fixed").agent).toBe("codex");
  expect(service.getBot("bot_fixed").workspace).toBe("backend");
});

test("group-member runtime locks agent but not the workspace default", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  state.conversation_topics.topic_g = {
    id: "topic_g",
    conversationId: "team",
    title: "Sprint",
    status: "active",
    executionTarget: { workspace: "backend", isolation: "shared-single-writer" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.bot_runtime_bindings.bind_g = {
    id: "bind_g",
    scope: "group-member",
    conversationId: "team",
    topicId: "topic_g",
    botId: "bot_fixed",
    logicalSessionId: "22222222-2222-4222-8222-222222222222",
    sessionAlias: "brt_bind_g",
    createdAt: NOW,
    updatedAt: NOW,
  };
  expect(service.hasRuntime("bot_fixed")).toBe(true);
  // Agent is identity: locked by any runtime including group-member.
  await expect(service.updateBot("bot_fixed", { agent: "claude" })).rejects.toMatchObject({
    code: "runtime_identity_locked",
  });
  // Workspace default is not consumed by member sessions (the Topic owns its
  // explicit workspace), so changing it must not fail closed here.
  await expect(service.updateBot("bot_fixed", { workspace: "frontend" })).resolves.toMatchObject({
    workspace: "frontend",
  });
  expect(service.getBot("bot_fixed").agent).toBe("codex");
});

test("updateBot clears instructions so the next profile has no stale persona text", async () => {
  const { service } = createService();
  await service.createBot({
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    instructions: "Focus on races.",
  });
  const updated = await service.updateBot("bot_fixed", { instructions: null });
  expect(updated.instructions).toBeUndefined();
});

test("deleteBot fails closed when a Group conversation still references the Bot", async () => {
  const state = createEmptyState();
  state.conversations.team = {
    id: "team",
    kind: "group",
    title: "Release",
    botIds: ["bot_fixed", "bot_other"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const { service } = createService(state);
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_group",
    details: { conversationIds: ["team"] },
  });
  expect(service.getBot("bot_fixed").name).toBe("Reviewer");
});

test("updateBot can change agent and workspace before any runtime exists", async () => {
  const { service } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const updated = await service.updateBot("bot_fixed", { agent: "claude", workspace: "frontend" });
  expect(updated.agent).toBe("claude");
  expect(updated.workspace).toBe("frontend");
});

test("createTopic-only conversation does not lock identity but keeps delete fail-closed", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  // A persisted Direct Conversation row with no binding and no owned session
  // (exactly what createDirectTopic persists before any execution).
  state.conversations.direct = {
    id: "direct",
    kind: "bot",
    title: "Reviewer",
    botIds: ["bot_fixed"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  expect(service.hasRuntime("bot_fixed")).toBe(false);
  // agent/workspace stay editable: no actual runtime materialized.
  const updated = await service.updateBot("bot_fixed", { agent: "claude", workspace: "frontend" });
  expect(updated.agent).toBe("claude");
  expect(updated.workspace).toBe("frontend");
  // delete stays fail-closed via bot_in_use while the Conversation row exists.
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_use",
  });
  expect(service.getBot("bot_fixed").name).toBe("Reviewer");
});

test("deleteBot fails closed when a direct conversation still references the Bot", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  state.conversations.direct = {
    id: "direct",
    kind: "bot",
    title: "Reviewer",
    botIds: ["bot_fixed"],
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_use",
  });
  expect(service.getBot("bot_fixed").name).toBe("Reviewer");
});

test("deleteBot fails closed when an owned session exists without a binding", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const bindingId = createDirectBindingId("bot_fixed");
  state.sessions[`brt_${bindingId}`] = {
    alias: `brt_${bindingId}`,
    agent: "codex",
    workspace: "backend",
    transport_session: `backend:brt_${bindingId}`,
    logical_session_id: "11111111-1111-4111-8111-111111111111",
    created_at: NOW,
    last_used_at: NOW,
    owner: { kind: "bot-direct", bindingId },
  };
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({
    code: "bot_in_use",
  });
});

test("deleteBot removes a Bot that has no conversations or runtime", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await service.deleteBot("bot_fixed");
  expect(state.bots.bot_fixed).toBeUndefined();
  expect(() => service.getBot("bot_fixed")).toThrow(BotError);
});

test("createBot uses saveNow before publishing live state", async () => {
  const state = createEmptyState();
  const store = {
    saved: [] as AppState[],
    durable: [] as AppState[],
    async save(next: AppState) {
      this.saved.push(structuredClone(next));
    },
    async saveNow(next: AppState) {
      this.durable.push(structuredClone(next));
    },
  };
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => "bot_fixed" },
  );
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  expect(store.durable).toHaveLength(1);
  expect(store.saved).toHaveLength(0);
  expect(store.durable[0]?.bots.bot_fixed?.name).toBe("Reviewer");
  expect(state.bots.bot_fixed?.name).toBe("Reviewer");
});

test("deleteBot fails closed when ConversationStore still has durable work", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  service.setConversationWork({ hasDurableBotWork: (botId) => botId === "bot_fixed" });
  await expect(service.deleteBot("bot_fixed")).rejects.toMatchObject({ code: "bot_in_use" });
  expect(state.bots.bot_fixed).toBeDefined();
});

test("createGroup validates membership, lead, and opaque identity", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW) },
  );
  const a = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  // min two members
  await expect(service.createGroup({ title: "Solo", botIds: [a.id] })).rejects.toMatchObject({
    code: "group_membership_min",
  });
  // duplicate members
  await expect(service.createGroup({ title: "Dup", botIds: [a.id, a.id] })).rejects.toMatchObject({
    code: "group_membership_duplicate",
  });
  // missing bot
  await expect(service.createGroup({ title: "Ghost", botIds: [a.id, "bot_missing"] })).rejects.toMatchObject({
    code: "bot_not_found",
  });
  // lead outside membership
  await expect(
    service.createGroup({ title: "Bad lead", botIds: [a.id, b.id], leadBotId: "bot_missing" }),
  ).rejects.toMatchObject({ code: "group_lead_not_member" });
  const group = await service.createGroup({
    title: "Release Team",
    description: "Ships it",
    botIds: [a.id, b.id],
    leadBotId: a.id,
  });
  expect(group.kind).toBe("group");
  expect(group.botIds).toEqual([a.id, b.id]);
  expect(group.leadBotId).toBe(a.id);
  expect(group.id.startsWith("conversation_")).toBe(true);
  expect(group.id).not.toContain("Release");
  expect(state.conversations[group.id]?.kind).toBe("group");
  // update: remove lead, shrink membership fails closed
  const noLead = await service.updateGroup(group.id, { leadBotId: null });
  expect(noLead.leadBotId).toBeUndefined();
  await expect(service.updateGroup(group.id, { botIds: [a.id] })).rejects.toMatchObject({
    code: "group_membership_min",
  });
  await service.deleteGroup(group.id);
  expect(state.conversations[group.id]).toBeUndefined();
});

test("updateGroup repairs membership dangling from a load-quarantined Bot", async () => {
  const { parseState } = await import("../../../src/state/state-store");
  const dropped: { section: string; key: string; reason: string }[] = [];
  const parsed = parseState({
    bots: {
      bot_a: {
        id: "bot_a", name: "A", agent: "codex", workspace: "backend", enabled: true,
        profileRevision: 1, createdAt: NOW, updatedAt: NOW,
      },
      bot_b: {
        id: "bot_b", name: "B", agent: "codex", workspace: "backend", enabled: true,
        profileRevision: 1, createdAt: NOW, updatedAt: NOW,
      },
      bad_c: { id: "bad_c", name: "C" },
    },
    conversations: {
      team: {
        id: "team", kind: "group", title: "Team", botIds: ["bot_a", "bot_b", "bad_c"],
        createdAt: NOW, updatedAt: NOW,
      },
    },
  }, "state.json", dropped);
  // The Group record survives (repair must be possible); the dangling
  // reference is reported explicitly in the load report.
  expect(parsed.conversations.team).toBeDefined();
  expect(parsed.bots.bad_c).toBeUndefined();
  expect(dropped.some((entry) =>
    entry.section === "conversations"
    && entry.key === "team"
    && entry.reason.includes('missing bot "bad_c"'),
  )).toBe(true);
  // Repair: removing the dead member succeeds even though it cannot gate,
  // and a title-only patch on the dangling Group succeeds too.
  const { service } = createService(parsed);
  const repaired = await service.updateGroup("team", { botIds: ["bot_a", "bot_b"] });
  expect(repaired.botIds).toEqual(["bot_a", "bot_b"]);
  const renamed = await service.updateGroup("team", { title: "Team 2" });
  expect(renamed.title).toBe("Team 2");
});

test("stale membership probe widens gates instead of dropping a just-added member", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  let releaseU2!: () => void;
  const u2Parked = new Promise<void>((resolve) => { releaseU2 = resolve; });
  let parkU2 = true;
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    {
      now: () => new Date(NOW),
      beforeGroupGatesAcquired: async () => {
        if (parkU2) {
          parkU2 = false;
          await u2Parked;
        }
      },
    },
  );
  const a = await service.createBot({ name: "A", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "B", agent: "codex", workspace: "backend" });
  const c = await service.createBot({ name: "C", agent: "codex", workspace: "backend" });
  const d = await service.createBot({ name: "D", agent: "codex", workspace: "backend" });
  const group = await service.createGroup({ title: "Team", botIds: [a.id, b.id] });
  // U2 probes stale [A,B], parks pre-acquisition. U1 commits [A,B]->[A,C].
  const u2 = service.updateGroup(group.id, { botIds: [a.id, d.id] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await service.updateGroup(group.id, { botIds: [a.id, c.id] });
  expect(service.getGroup(group.id).botIds).toEqual([a.id, c.id]);
  // Hold C externally (paused C-materializer stand-in): U2's retry must
  // block on C's gate before it can commit the removal of C.
  let releaseC!: () => void;
  const cGate = new Promise<void>((resolve) => { releaseC = resolve; });
  const extHold = service.runLifecycle(c.id, () => cGate);
  releaseU2();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // U2 has not committed the stale removal while C's gate is held.
  expect(service.getGroup(group.id).botIds).toEqual([a.id, c.id]);
  releaseC();
  await extHold;
  const final = await u2;
  expect(final.botIds).toEqual([a.id, d.id]);
});

test("deleteBot stays fail-closed while Group membership references the Bot", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  let n = 0;
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => `bot_${(n += 1)}` },
  );
  const a = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const group = await service.createGroup({ title: "Release Team", botIds: [a.id, b.id] });
  await expect(service.deleteBot(a.id)).rejects.toMatchObject({ code: "bot_in_group" });
  expect(state.bots[a.id]).toBeDefined();
  await service.deleteGroup(group.id);
  // Still fail-closed on direct runtime refs path (no runtime here, so delete succeeds).
  await service.deleteBot(a.id);
  expect(state.bots[a.id]).toBeUndefined();
});

test("deleteGroup fails closed while topics, bindings, or durable rows exist", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  let n = 0;
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => `bot_${(n += 1)}` },
  );
  const a = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const group = await service.createGroup({ title: "Release Team", botIds: [a.id, b.id] });
  // A Topic alone blocks metadata delete.
  state.conversation_topics.topic_1 = {
    id: "topic_1",
    conversationId: group.id,
    title: "Sprint 1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_topics" });
  expect(state.conversations[group.id]).toBeDefined();
  // A bare binding row blocks even with no topics.
  delete state.conversation_topics.topic_1;
  state.bot_runtime_bindings.bind_1 = {
    id: "bind_1",
    scope: "group-member",
    conversationId: group.id,
    topicId: "topic_1",
    botId: a.id,
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sessionAlias: "brt_group_bind_1",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_runtime" });
  // Durable store rows block even with no AppState residue.
  delete state.bot_runtime_bindings.bind_1;
  service.setConversationWork({ hasDurableBotWork: () => false, hasDurableGroupWork: (id) => id === group.id });
  await expect(service.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_work" });
  service.setConversationWork({ hasDurableBotWork: () => false, hasDurableGroupWork: () => false });
  await service.deleteGroup(group.id);
  expect(state.conversations[group.id]).toBeUndefined();
});
test("deleteBot stays fail-closed on controller residue cross-kind to a Direct root", async () => {
  const { service, state } = createService();
  const bot = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const { createDirectConversationId, createDirectTopicId } = await import("../../../src/domain/ids");
  const conversationId = createDirectConversationId(bot.id);
  const topicId = createDirectTopicId(bot.id);
  state.sessions.controller_direct = {
    alias: "controller_direct",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:controller_direct",
    logical_session_id: "22222222-2222-4222-8222-222222222222",
    created_at: NOW,
    last_used_at: NOW,
    owner: { kind: "group-controller", bindingId: "missing_binding", conversationId, topicId },
  };
  await expect(service.deleteBot(bot.id)).rejects.toMatchObject({ code: "bot_in_use" });
  // The Bot root and the hidden session both survive: verified Direct
  // teardown stays available as the recovery path.
  expect(state.bots[bot.id]).toBeDefined();
  expect(state.sessions.controller_direct?.alias).toBe("controller_direct");
});

test("deleteBot stays fail-closed on a controller binding alone", async () => {
  const { service, state } = createService();
  const bot = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const { createDirectConversationId, createDirectTopicId } = await import("../../../src/domain/ids");
  const conversationId = createDirectConversationId(bot.id);
  state.bot_runtime_bindings.controller_only = {
    id: "controller_only",
    scope: "group-controller",
    conversationId,
    topicId: createDirectTopicId(bot.id),
    logicalSessionId: "33333333-3333-4333-8333-333333333333",
    sessionAlias: "group:controller-only",
    createdAt: NOW,
    updatedAt: NOW,
  };
  await expect(service.deleteBot(bot.id)).rejects.toMatchObject({ code: "bot_in_use" });
  expect(state.bots[bot.id]).toBeDefined();
  expect(state.bot_runtime_bindings.controller_only).toBeDefined();
});

test("deleteGroup stays fail-closed on binding-less controller sessions", async () => {
  const state = createEmptyState();
  const store = new MemoryStateStore();
  let n = 0;
  const service = new BotService(
    {
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
    },
    state,
    store,
    { now: () => new Date(NOW), createId: () => `bot_${(n += 1)}` },
  );
  const a = await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "Tester", agent: "codex", workspace: "backend" });
  const group = await service.createGroup({ title: "Release Team", botIds: [a.id, b.id] });
  state.conversation_topics.topic_1 = {
    id: "topic_1",
    conversationId: group.id,
    title: "Sprint 1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  // No binding row: the live topicId alone attributes the partial owner.
  state.sessions.controller_partial = {
    alias: "controller_partial",
    agent: "codex",
    workspace: "backend",
    transport_session: "backend:controller_partial",
    logical_session_id: "44444444-4444-4444-8444-444444444444",
    created_at: NOW,
    last_used_at: NOW,
    owner: { kind: "group-controller", bindingId: "missing_binding", topicId: "topic_1" },
  };
  await expect(service.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_topics" });
  delete state.conversation_topics.topic_1;
  // Topic row gone: the owner is now unattributable, which still blocks via
  // the ambiguous gate instead of orphaning silently.
  await expect(service.deleteGroup(group.id)).rejects.toMatchObject({ code: "group_has_runtime" });
  expect(state.conversations[group.id]).toBeDefined();
  expect(state.sessions.controller_partial?.alias).toBe("controller_partial");
});

test("group member classifiers prove exact triple ownership and fail closed on mismatch", async () => {
  const { classifyGroupMemberBindingOwnership, classifyGroupMemberSessionOwnership } =
    await import("../../../src/bots/bot-service");
  const { createScopedGroupMemberBindingId } = await import("../../../src/domain/ids");
  const binding = {
    id: createScopedGroupMemberBindingId("conv_g", "topic_t", "bot_a"),
    scope: "group-member" as const,
    conversationId: "conv_g",
    topicId: "topic_t",
    botId: "bot_a",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sessionAlias: "brt_group_x",
    createdAt: NOW,
    updatedAt: NOW,
  };
  expect(classifyGroupMemberBindingOwnership(binding, "bot_a", "conv_g", "topic_t")).toBe("owned");
  // Wrong Bot for the triple is a conflict, not silently foreign.
  expect(classifyGroupMemberBindingOwnership(binding, "bot_b", "conv_g", "topic_t")).toBe("conflict");
  // Wrong conversation is foreign (different scope entirely).
  expect(classifyGroupMemberBindingOwnership(binding, "bot_a", "conv_other", "topic_t")).toBe("foreign");
  // Direct scope never counts as member ownership.
  expect(classifyGroupMemberBindingOwnership({ ...binding, scope: "bot-direct" }, "bot_a", "conv_g", "topic_t")).toBe(
    "foreign",
  );
  const session = {
    owner: {
      kind: "group-member" as const,
      bindingId: binding.id,
      botId: "bot_a",
      conversationId: "conv_g",
      topicId: "topic_t",
    },
  };
  expect(classifyGroupMemberSessionOwnership(session, "bot_a", binding.id, "conv_g", "topic_t")).toBe("owned");
  expect(classifyGroupMemberSessionOwnership(session, "bot_b", binding.id, "conv_g", "topic_t")).toBe("conflict");
  expect(
    classifyGroupMemberSessionOwnership({ owner: { kind: "bot-direct", bindingId: binding.id } }, "bot_a", binding.id, "conv_g", "topic_t"),
  ).toBe("foreign");
});
