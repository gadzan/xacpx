import { expect, test } from "bun:test";

import { BotError } from "../../../src/bots/bot-error";
import { BotService } from "../../../src/bots/bot-service";
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
      agents: { codex: { driver: "codex" } },
      workspaces: { backend: { cwd: "/tmp/backend" } },
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
  expect(state.bots.bot_fixed?.id).toBe("bot_fixed");
  await service.updateBot("bot_fixed", { name: "Senior Reviewer" });
  expect(service.getBot("bot_fixed").id).toBe("bot_fixed");
  expect(service.getBot("bot_fixed").name).toBe("Senior Reviewer");
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

test("deleteBot removes a Bot that is not in any Group", async () => {
  const { service, state } = createService();
  await service.createBot({ name: "Reviewer", agent: "codex", workspace: "backend" });
  await service.deleteBot("bot_fixed");
  expect(state.bots.bot_fixed).toBeUndefined();
  expect(() => service.getBot("bot_fixed")).toThrow(BotError);
});
