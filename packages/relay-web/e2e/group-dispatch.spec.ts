import type { Page } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationTimelineDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * Handoffs on the one timeline (design §8.1): each dispatch is one line under
 * its sender, never a card. The Run-wide drawer is the only detail surface; it
 * lists every member of the Run with its durable state.
 */

const createdAt = "2026-10-14T00:00:00Z";
const scope = { conversationId: "group_dispatch", topicId: "topic_dispatch", createdAt };
const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "reviewer", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = { id: scope.conversationId, kind: "group", title: "Dispatch team", botIds: bots.map((bot) => bot.id), leadBotId: "lead", createdAt, updatedAt: createdAt };
const topic = { id: scope.topicId, conversationId: scope.conversationId, title: "Round", status: "active", createdAt, updatedAt: createdAt };

function member(id: string, botId: string, index: number, state: MemberTurnSummaryDto["state"], patch: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    ...scope,
    id,
    runId: "run_dispatch",
    botId,
    batch: 1,
    memberIndex: index,
    attempt: 1,
    origin: "handoff",
    state,
    createdAt,
    ...patch,
  };
}

const run: ConversationRunDetailDto = {
  ...scope,
  id: "run_dispatch",
  requestMessageId: "msg_leader",
  requestId: "req",
  mode: "explicit",
  shape: "fanout",
  state: "running",
  profileRevision: 1,
  memberTurns: [
    member("turn_lead", "lead", 0, "running", { origin: "human-explicit", batch: 0 }),
    member("turn_reviewer", "reviewer", 1, "completed"),
    member("turn_tester", "tester", 2, "running"),
  ],
};

const leaderMessage: ConversationMessageDto = {
  ...scope,
  id: "msg_leader",
  seq: 1,
  runId: run.id,
  role: "bot",
  senderBotId: "lead",
  memberTurnId: "turn_lead",
  content: "Dispatching two reviews",
  createdAt,
};
function handoff(id: string, seq: number, to: string, memberTurnId: string, task: string): ConversationMessageDto {
  return {
    ...scope,
    id,
    seq,
    runId: run.id,
    role: "system",
    senderBotId: "lead",
    memberTurnId: "turn_lead",
    content: "",
    handoff: { senderMemberTurnId: "turn_lead", to, assignmentId: `assignment_${to}`, memberTurnId, task },
  };
}
const reviewerReply: ConversationMessageDto = {
  ...scope,
  id: "reply_reviewer",
  seq: 4,
  runId: run.id,
  role: "bot",
  senderBotId: "reviewer",
  memberTurnId: "turn_reviewer",
  content: "REVIEWER FINDINGS",
  createdAt,
};

const timeline: ConversationTimelineDto = {
  conversationId: scope.conversationId,
  topicId: scope.topicId,
  entries: [
    { kind: "message", key: "message:msg_leader", anchorSeq: 1, runId: run.id, memberTurnId: "turn_lead", ownership: "exact", message: leaderMessage },
    { kind: "message", key: "message:handoff_reviewer", anchorSeq: 2, runId: run.id, memberTurnId: "turn_reviewer", ownership: "exact", message: handoff("handoff_reviewer", 2, "reviewer", "turn_reviewer", "Review the release diff") },
    { kind: "message", key: "message:handoff_tester", anchorSeq: 3, runId: run.id, memberTurnId: "turn_tester", ownership: "exact", message: handoff("handoff_tester", 3, "tester", "turn_tester", "Test the release diff") },
    { kind: "message", key: "message:reply_reviewer", anchorSeq: 4, runId: run.id, memberTurnId: "turn_reviewer", ownership: "exact", message: reviewerReply },
  ],
  hasMoreBefore: false,
  hasMoreAfter: false,
} as never;

async function openGroup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": {
        result = { ...scope, messages: [leaderMessage, reviewerReply], oldestSeq: 1, newestSeq: 4, hasMoreBefore: false, hasMoreAfter: false };
        break;
      }
      case "control.conversation.timeline": result = timeline; break;
      case "control.runs.list": result = { runs: [run], activeRunId: run.id, activeRun: run }; break;
      case "control.runs.get": result = { run }; break;
      case "control.runs.details.batch": result = { runs: payload.runIds.includes(run.id) ? [run] : [], missingRunIds: [] }; break;
      case "control.runs.trace.get": result = { memberTurnId: payload.memberTurnId, attempt: payload.attempt, recordingState: "complete", events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [] }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
}

const drawer = (page: Page) => page.locator('[data-test="group-detail-card"], [data-test="group-detail-sheet"]');

test("consecutive handoffs share one compact row, and the Run drawer lists every member", async ({ page }) => {
  await openGroup(page);
  const scroller = page.getByTestId("conversation-timeline-scroller");
  await expect(scroller.getByTestId("timeline-bot-message").first()).toContainText("Dispatching two reviews");
  await expect(scroller.getByTestId("timeline-handoffs")).toHaveCount(1);
  await expect(scroller.getByTestId("timeline-handoff")).toHaveCount(2);
  await expect(scroller.getByTestId("timeline-handoff").nth(0)).toContainText("Lead");
  await expect(scroller.getByTestId("timeline-handoff").nth(0)).toContainText("Reviewer");
  await expect(scroller.getByTestId("timeline-handoff").nth(0)).toContainText("Review the release diff");
  await expect(scroller.getByTestId("timeline-handoff").nth(1)).toContainText("Test the release diff");
  // The deleted aggregate/card surfaces must not come back.
  await expect(scroller.getByTestId("group-dispatch-row")).toHaveCount(0);

  await scroller.getByTestId("timeline-open-detail").first().click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
  await expect(drawer(page).getByTestId("run-member-row")).toHaveCount(3);
  await expect(drawer(page).getByTestId("run-member-name")).toHaveText(["Lead", "Reviewer", "Tester"]);
  await expect(drawer(page).getByTestId("run-stop-member")).toHaveCount(1);
  await expect(drawer(page).getByTestId("group-stop-run-button")).toHaveCount(0);
});

test("a handoff line opens the drawer on the dispatched member", async ({ page }) => {
  await openGroup(page);
  const scroller = page.getByTestId("conversation-timeline-scroller");
  await scroller.getByTestId("timeline-handoff").nth(1).click();
  const surface = drawer(page);
  await expect(surface).toBeVisible();
  await expect(surface.getByTestId("run-selected-member")).toHaveAttribute("data-member-turn-id", "turn_tester");
  await expect(surface.getByTestId("run-selected-member")).toContainText("Tester");
});

test("the drawer closes on Escape and returns focus to the trigger", async ({ page, isMobile }) => {
  test.skip(isMobile, "desktop focus restore for the drawer");
  await openGroup(page);
  const trigger = page.getByTestId("conversation-timeline-scroller").getByTestId("timeline-open-detail").first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
