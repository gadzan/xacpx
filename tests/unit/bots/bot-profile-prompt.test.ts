import { expect, test } from "bun:test";

import { composeBotTurnPrompt } from "../../../src/bots/bot-profile-prompt";
import type { BotProfile } from "../../../src/bots/bot-types";

const bot: BotProfile = {
  id: "bot_a",
  name: "Reviewer",
  role: "Code reviewer",
  instructions: "Focus on races.",
  agent: "codex",
  workspace: "backend",
  enabled: true,
  profileRevision: 1,
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:00:00.000Z",
};

test("composeBotTurnPrompt uses the durable profile and keeps user text", () => {
  expect(composeBotTurnPrompt(bot, "check the lock")).toBe(
    'You are acting as the Bot named "Reviewer".\n\nInstructions:\nFocus on races.\n\nThis Bot profile does not change the underlying model, tools, or permission policy.\n\ncheck the lock',
  );
});

test("composeBotTurnPrompt does not inject presentation role into model text", () => {
  const prompt = composeBotTurnPrompt(bot, "check the lock");
  expect(prompt.includes("Role:")).toBe(false);
  expect(prompt.includes("Code reviewer")).toBe(false);
  expect(prompt).toContain("Focus on races.");
});

test("composeBotTurnPrompt omits empty optional fields", () => {
  const prompt = composeBotTurnPrompt({ ...bot, role: undefined, instructions: undefined }, "hello");
  expect(prompt).toBe(
    'You are acting as the Bot named "Reviewer".\n\nThis Bot profile does not change the underlying model, tools, or permission policy.\n\nhello',
  );
});

test("composeBotTurnPrompt leaves whole-input runtime commands unmodified", () => {
  expect(composeBotTurnPrompt(bot, "/status")).toBe("/status");
  expect(composeBotTurnPrompt(bot, "  /session list  ")).toBe("  /session list  ");
});

test("a later profile edit changes the next composed prompt", () => {
  const first = composeBotTurnPrompt(bot, "go");
  const second = composeBotTurnPrompt({ ...bot, instructions: "Be terse." }, "go");
  expect(first).toContain("Focus on races.");
  expect(second).toContain("Be terse.");
  expect(second.includes("Focus on races.")).toBe(false);
});
