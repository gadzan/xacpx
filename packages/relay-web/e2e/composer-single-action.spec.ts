import type { Page } from "@playwright/test";
import type { ConversationRunDetailDto } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

const createdAt = "2026-10-14T00:00:00Z";
const scope = { conversationId: "group_single_action", topicId: "topic_single_action", createdAt };
const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = { id: scope.conversationId, kind: "group", title: "Single action team", botIds: bots.map((bot) => bot.id), leadBotId: "lead", createdAt, updatedAt: createdAt };
const topic = { id: scope.topicId, conversationId: scope.conversationId, title: "Live round", status: "active", createdAt, updatedAt: createdAt };
const run: ConversationRunDetailDto = {
  ...scope,
  id: "run_single_action",
  requestMessageId: "request_single_action",
  requestId: "req_single_action",
  mode: "explicit",
  state: "running",
  profileRevision: 1,
  memberTurns: [
    { ...scope, id: "turn_single_action", runId: "run_single_action", botId: "tester", batch: 1, attempt: 1, origin: "human-explicit", state: "running" },
  ],
};

async function openLiveGroup(page: Page): Promise<void> {
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": {
        result = { ...scope, messages: [], oldestSeq: 0, newestSeq: 0, hasMoreBefore: false, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { runs: [run], activeRunId: run.id, activeRun: run }; break;
      case "control.runs.get": result = { run }; break;
      case "control.runs.details.batch": result = { runs: [run] }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
}

test("the composer offers exactly one action while a run is active", async ({ page }) => {
  await openLiveGroup(page);

  // Scope to the composer: the run detail header reuses the same stop test id.
  const composer = page.getByTestId("group-composer-textarea").locator("xpath=ancestor::form[1]");
  const stop = composer.getByTestId("group-stop-run-button");
  const send = composer.getByTestId("group-send-prompt-button");
  const textarea = page.getByTestId("group-composer-textarea");

  await expect(stop).toBeVisible();
  await expect(send).toHaveCount(0);

  await textarea.fill("next step");
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(stop).toHaveCount(0);

  await textarea.fill("");
  await expect(stop).toBeVisible();
  await expect(send).toHaveCount(0);
});
