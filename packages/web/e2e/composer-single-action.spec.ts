import type { Page } from "@playwright/test";
import type { ConversationRunDetailDto, ConversationTimelineDto } from "@ganglion/xacpx-relay-protocol";
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

/** The run has no public message yet, so the timeline carries one activity row. */
const timeline = {
  conversationId: scope.conversationId,
  topicId: scope.topicId,
  entries: [{
    kind: "activity",
    key: "activity:turn_single_action",
    anchorSeq: 1,
    runId: run.id,
    memberTurn: run.memberTurns[0],
  }],
  oldestSeq: 0,
  newestSeq: 1,
  hasMoreBefore: false,
  hasMoreAfter: false,
} as unknown as ConversationTimelineDto;

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
      case "control.runs.details.batch": result = { runs: [run], missingRunIds: [] }; break;
      case "control.conversation.timeline": result = timeline; break;
      case "control.runs.trace.get": result = { memberTurnId: "turn_single_action", attempt: 1, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [] }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
}

test("a running Group has exactly one Stop, and it is the status bar's", async ({ page }) => {
  await openLiveGroup(page);

  // Stop all is the single stop control; the composer only ever offers Send.
  await expect(page.getByTestId("conversation-stop-all")).toBeVisible();
  const composer = page.getByTestId("group-composer-textarea").locator("xpath=ancestor::form[1]");
  await expect(composer.getByTestId("group-stop-run-button")).toHaveCount(0);
  await expect(composer.getByTestId("group-send-prompt-button")).toBeVisible();

  // Typing a draft flips Send to Send (never a second Stop) and clears back.
  const textarea = page.getByTestId("group-composer-textarea");
  await textarea.fill("next step");
  await expect(page.getByTestId("group-send-prompt-button")).toBeEnabled();
  await expect(page.getByTestId("group-stop-run-button")).toHaveCount(0);
  await textarea.fill("");
  await expect(page.getByTestId("conversation-stop-all")).toBeVisible();
  await expect(page.getByTestId("group-stop-run-button")).toHaveCount(0);
});
