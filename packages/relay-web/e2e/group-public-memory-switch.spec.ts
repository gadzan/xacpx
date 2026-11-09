import type { Page } from "@playwright/test";
import type { ConversationPromptResponseDto, ConversationRunDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * Group public-memory switch, end to end through the dashboard.
 *
 * The browser cannot observe a provider prompt, so the mocked core here models
 * the one contract that matters for this flow: a Group's public messages are
 * projected into memory only while its switch is on, and a Direct prompt for a
 * member carries that projection as shared context. The assertions therefore
 * cover the whole chain the user drives — Group settings save, the wire
 * payload, and the context the core derives for the next Direct prompt — while
 * the store-level write/read gates are covered by the backend unit tests.
 */

const createdAt = "2026-11-09T00:00:00Z";
const groupScope = { conversationId: "group_memory", topicId: "topic_memory", createdAt };
const directScope = { conversationId: "bot_lead", topicId: "topic_direct", createdAt };
const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const groupTopic = { id: groupScope.topicId, conversationId: groupScope.conversationId, title: "Live round", status: "active", createdAt, updatedAt: createdAt };
const directTopic = { id: directScope.topicId, conversationId: directScope.conversationId, title: "Default", status: "active", defaultDirect: true, createdAt, updatedAt: createdAt };

const emptyTimeline = (scope: typeof groupScope) => ({
  conversationId: scope.conversationId,
  topicId: scope.topicId,
  entries: [],
  oldestSeq: 0,
  newestSeq: 0,
  hasMoreBefore: false,
  hasMoreAfter: false,
});

/** The header pencil at lg; below lg the same entry lives in the ⋯ sheet. */
async function openGroupSettings(page: Page): Promise<void> {
  const edit = page.getByTestId("group-edit-button");
  if (await edit.isVisible()) {
    await edit.click();
    return;
  }
  await page.getByTestId("mobile-group-more").click();
  await page.getByTestId("sheet-group-edit").click();
}

function accepted(scope: typeof groupScope, requestId: string, text: string, index: number): ConversationPromptResponseDto {
  const run: ConversationRunDto = {
    id: `run_${index}`,
    ...scope,
    requestMessageId: `msg_${index}`,
    requestId,
    mode: "explicit",
    state: "running",
    profileRevision: 1,
    createdAt,
  };
  return {
    reused: false,
    ...scope,
    requestId,
    message: {
      ...scope,
      id: `msg_${index}`,
      seq: index,
      role: "human",
      content: text,
      createdAt,
    },
    run,
    memberTurns: [],
    activeRunId: run.id,
  };
}

async function sendGroupMessage(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("group-composer-textarea");
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press("Enter");
}

/** Desktop keeps the sidebar visible; mobile shows one pane at a time. */
async function leavePane(page: Page): Promise<void> {
  const back = page.getByTestId("mobile-back");
  if (await back.isVisible()) await back.click();
}

async function sendDirectMessage(page: Page, text: string): Promise<void> {
  await leavePane(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();
  const input = page.locator('textarea[role="combobox"]');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill(text);
  await input.press("Enter");
  // The composer keeps the draft until the accept answer lands; a rejected
  // send would leave the text in place instead of clearing it.
  await expect(input).not.toHaveValue(text);
}

test("switching public memory off keeps Group messages out of Direct prompts, and on restores them", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));

  const group: GroupSummaryDto = {
    id: groupScope.conversationId,
    kind: "group",
    title: "Memory team",
    botIds: bots.map((bot) => bot.id),
    leadBotId: "lead",
    publicMemoryProjection: "on",
    createdAt,
    updatedAt: createdAt,
  };
  // The mocked core's projection state. Group messages are only recorded while
  // the switch is on, and a Direct prompt composes whatever is recorded.
  const core = { projection: "on" as "on" | "off", memory: [] as string[] };
  const updates: Array<Record<string, unknown>> = [];
  const prompts: Array<{ conversationId: string; text: string; context?: string }> = [];
  let messages = 0;

  await page.route("**/api/instances/i1/rpc", async (route) => {
    const payload = route.request().postDataJSON() as { type: string; payload?: Record<string, unknown> };
    const type = payload.type;
    const input = payload.payload ?? {};
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.bots.get": result = { bot: bots[0] }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [groupTopic] } }; break;
      case "control.groups.update": {
        updates.push(input);
        if (input.publicMemoryProjection === "on" || input.publicMemoryProjection === "off") {
          group.publicMemoryProjection = core.projection = input.publicMemoryProjection;
        }
        group.updatedAt = new Date().toISOString();
        result = { group };
        break;
      }
      case "control.conversations.list":
        result = {
          conversations: [{
            id: directScope.conversationId,
            kind: "bot",
            title: "Lead",
            botId: "lead",
            defaultTopicId: directScope.topicId,
            createdAt,
            updatedAt: createdAt,
          }],
        };
        break;
      case "control.topics.list": {
        const conversationId = String(input.conversationId ?? "");
        result = { topics: [conversationId === directScope.conversationId ? directTopic : groupTopic] };
        break;
      }
      case "control.conversation.history": {
        const scope = String(input.conversationId) === directScope.conversationId ? directScope : groupScope;
        result = { ...scope, messages: [], oldestSeq: 0, newestSeq: 0, hasMoreBefore: false, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": {
        const scope = String(input.conversationId) === directScope.conversationId ? directScope : groupScope;
        result = { runs: [], ...scope };
        break;
      }
      case "control.conversation.timeline": {
        const scope = String(input.conversationId) === directScope.conversationId ? directScope : groupScope;
        result = emptyTimeline(scope);
        break;
      }
      case "control.conversation.completions.get":
        result = {
          version: 1,
          scope: { conversationId: directScope.conversationId, topicId: directScope.topicId, botId: "lead" },
          revision: "e2e",
          commands: { status: "ready", items: [] },
          mentions: { status: "ready", items: [] },
        };
        break;
      case "control.conversation.prompt": {
        messages += 1;
        const conversationId = String(input.conversationId);
        const text = String(input.text ?? "");
        if (conversationId === groupScope.conversationId) {
          expect(input).not.toHaveProperty("target");
          if (core.projection === "on") core.memory.push(text);
          result = accepted(groupScope, String(input.requestId), text, messages);
          break;
        }
        prompts.push({
          conversationId,
          text,
          ...(core.projection === "on" && core.memory.length > 0
            ? { context: `Shared group context: ${core.memory.join(" | ")}` }
            : {}),
        });
        result = accepted(directScope, String(input.requestId), text, messages);
        break;
      }
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });

  await loginAndShowInstances(page);

  // 1. Switch projection off from Group settings.
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  await openGroupSettings(page);
  await expect(page.getByTestId("group-dialog-public-memory")).toBeVisible();
  await expect(page.getByTestId("group-dialog-public-memory-on").locator("input")).toBeChecked();
  await page.getByTestId("group-dialog-public-memory-off").locator("input").check();
  await page.getByTestId("group-dialog-save").click();

  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toEqual({ id: groupScope.conversationId, publicMemoryProjection: "off" });
  // The saved switch is visible again on the next open (the resolved DTO read).
  await openGroupSettings(page);
  await expect(page.getByTestId("group-dialog-public-memory-off").locator("input")).toBeChecked();
  await page.getByTestId("group-dialog").getByRole("button", { name: "Close" }).click();

  // 2. A Group message while off writes no projection.
  await sendGroupMessage(page, "ROLLOUT NOTES OFF");
  await expect.poll(() => messages).toBe(1);
  expect(core.memory).toEqual([]);

  // 3. The next Direct prompt carries no target-group context.
  await sendDirectMessage(page, "PRIVATE QUESTION OFF");
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toEqual({
    conversationId: directScope.conversationId,
    text: "PRIVATE QUESTION OFF",
  });

  // 4. Switch projection back on.
  await leavePane(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  await openGroupSettings(page);
  await page.getByTestId("group-dialog-public-memory-on").locator("input").check();
  await page.getByTestId("group-dialog-save").click();
  await expect.poll(() => updates.length).toBe(2);
  expect(updates[1]).toEqual({ id: groupScope.conversationId, publicMemoryProjection: "on" });

  // 5. A Group message while on is projected, and the next Direct prompt sees it
  //    again — nothing was deleted while off.
  await sendGroupMessage(page, "ROLLOUT NOTES ON");
  await expect.poll(() => core.memory).toEqual(["ROLLOUT NOTES ON"]);
  await sendDirectMessage(page, "PRIVATE QUESTION ON");
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts[1]).toEqual({
    conversationId: directScope.conversationId,
    text: "PRIVATE QUESTION ON",
    context: "Shared group context: ROLLOUT NOTES ON",
  });
});
