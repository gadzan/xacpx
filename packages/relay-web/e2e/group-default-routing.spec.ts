import type { Page } from "@playwright/test";
import type { ConversationPromptResponseDto, ConversationRunDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

const createdAt = "2026-11-01T00:00:00Z";
const scope = { conversationId: "group_default_routing", topicId: "topic_default_routing", createdAt };
const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const topic = { id: scope.topicId, conversationId: scope.conversationId, title: "Live round", status: "active", createdAt, updatedAt: createdAt };
const timeline = {
  conversationId: scope.conversationId,
  topicId: scope.topicId,
  entries: [],
  oldestSeq: 0,
  newestSeq: 0,
  hasMoreBefore: false,
  hasMoreAfter: false,
};

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

/** Open the Group and serve the RPCs the pane needs, keeping the Group's
 *  `defaultRouting` mutable so a settings save is visible to the next send. */
async function openGroup(page: Page, sent: Array<Record<string, unknown> | undefined>): Promise<{ group: GroupSummaryDto }> {
  const group: GroupSummaryDto = {
    id: scope.conversationId,
    kind: "group",
    title: "Routing team",
    botIds: bots.map((bot) => bot.id),
    leadBotId: "lead",
    defaultRouting: "lead",
    createdAt,
    updatedAt: createdAt,
  };
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const payload = route.request().postDataJSON() as { type: string; payload?: Record<string, unknown> };
    const type = payload.type;
    const input = payload.payload ?? {};
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.groups.update": {
        Object.assign(group, input);
        group.updatedAt = new Date().toISOString();
        result = { group };
        break;
      }
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversations.router.get": result = { status: "ready", configPath: "conversations.router" }; break;
      case "control.conversation.history": {
        result = { ...scope, messages: [], oldestSeq: 0, newestSeq: 0, hasMoreBefore: false, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { runs: [], conversationId: scope.conversationId, topicId: scope.topicId }; break;
      case "control.conversation.timeline": result = timeline; break;
      case "control.conversation.prompt": {
        sent.push(input.target as Record<string, unknown> | undefined);
        const requestId = String(input.requestId);
        const run: ConversationRunDto = {
          id: `run_${sent.length}`,
          conversationId: scope.conversationId,
          topicId: scope.topicId,
          requestMessageId: `msg_${sent.length}`,
          requestId,
          mode: sent.at(-1) === undefined ? "explicit" : "automatic",
          state: "running",
          profileRevision: 1,
          createdAt,
        };
        result = {
          reused: false,
          conversationId: scope.conversationId,
          topicId: scope.topicId,
          requestId,
          message: {
            id: `msg_${sent.length}`,
            conversationId: scope.conversationId,
            topicId: scope.topicId,
            seq: sent.length,
            role: "human",
            content: String(input.text ?? ""),
            createdAt,
          },
          run,
          memberTurns: [],
          activeRunId: run.id,
        } satisfies ConversationPromptResponseDto;
        break;
      }
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  return { group };
}

test("the Group default send setting decides the plain-send wire target", async ({ page }) => {
  const sent: Array<Record<string, unknown> | undefined> = [];
  await openGroup(page, sent);

  // Lead (default): a plain message carries no target, so the server resolves
  // the live Lead inside its accept gates.
  await page.getByTestId("group-composer-textarea").fill("first pass");
  await page.getByTestId("group-send-prompt-button").click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toBeUndefined();

  // Automatic is a Group setting, never a composer mode.
  await openGroupSettings(page);
  const automatic = page.getByTestId("group-dialog-default-routing-automatic");
  await expect(automatic).toBeVisible();
  await automatic.getByRole("radio").check();
  await page.getByTestId("group-dialog-save").click();
  await expect(page.getByTestId("group-dialog")).toHaveCount(0);

  await page.getByTestId("group-composer-textarea").fill("route this");
  await page.getByTestId("group-send-prompt-button").click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual({ mode: "automatic" });

  // Switch back: the same plain message returns to the Lead shape, so the
  // setting is stickiness per Group, not a one-way upgrade.
  await openGroupSettings(page);
  await page.getByTestId("group-dialog-default-routing-lead").getByRole("radio").check();
  await page.getByTestId("group-dialog-save").click();
  await expect(page.getByTestId("group-dialog")).toHaveCount(0);

  await page.getByTestId("group-composer-textarea").fill("back to lead");
  await page.getByTestId("group-send-prompt-button").click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toBeUndefined();
});
