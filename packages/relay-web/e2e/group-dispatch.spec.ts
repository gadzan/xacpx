import type { Page } from "@playwright/test";
import type { ConversationMessageDto, ConversationRunDetailDto } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

const createdAt = "2026-10-14T00:00:00Z";
const scope = { conversationId: "group_dispatch", topicId: "topic_dispatch", createdAt };
const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "reviewer", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = { id: scope.conversationId, kind: "group", title: "Dispatch team", botIds: bots.map((bot) => bot.id), leadBotId: "lead", createdAt, updatedAt: createdAt };
const topic = { id: scope.topicId, conversationId: scope.conversationId, title: "Round", status: "active", createdAt, updatedAt: createdAt };
const run: ConversationRunDetailDto = {
  ...scope,
  id: "run_dispatch",
  requestMessageId: "request_1",
  requestId: "req",
  mode: "explicit",
  state: "running",
  profileRevision: 1,
  memberTurns: [
    { ...scope, id: "turn_lead", runId: "run_dispatch", botId: "lead", batch: 0, attempt: 1, origin: "human-explicit", state: "running", promptRequestId: "prompt_lead" },
    { ...scope, id: "turn_reviewer", runId: "run_dispatch", botId: "reviewer", batch: 1, attempt: 1, origin: "handoff", state: "completed", promptRequestId: "prompt_reviewer" },
    { ...scope, id: "turn_tester", runId: "run_dispatch", botId: "tester", batch: 1, attempt: 1, origin: "handoff", state: "running", promptRequestId: "prompt_tester" },
  ],
};

/** Two handoffs of one leader round, plus the reviewer's own reply. */
function handoff(id: string, seq: number, to: string, memberTurnId: string, task: string): ConversationMessageDto {
  return {
    ...scope,
    id,
    seq,
    runId: run.id,
    role: "system",
    senderBotId: "lead",
    content: "",
    handoff: { senderMemberTurnId: "turn_lead", to, assignmentId: `assignment_${to}`, memberTurnId, task },
  };
}

const leaderMessage: ConversationMessageDto = {
  ...scope,
  id: "msg_leader",
  seq: 1,
  runId: run.id,
  role: "bot",
  senderBotId: "lead",
  promptRequestId: "prompt_lead",
  content: "Dispatching two reviews",
  createdAt,
};
const first = handoff("handoff_first", 2, "reviewer", "turn_reviewer", "Review the release diff");
const second = handoff("handoff_second", 3, "tester", "turn_tester", "Test the release diff");
const reviewerReply: ConversationMessageDto = {
  ...scope,
  id: "reply_reviewer",
  seq: 4,
  runId: run.id,
  role: "bot",
  senderBotId: "reviewer",
  promptRequestId: "prompt_reviewer",
  content: "REVIEWER FINDINGS",
  createdAt,
};
// Trailing history so the reply sits below the fold: the jump must scroll.
const trailing: ConversationMessageDto[] = Array.from({ length: 12 }, (_, index) => ({
  ...scope,
  id: `after_${index}`,
  seq: 5 + index,
  role: "human",
  content: `After the reply ${index}`,
  createdAt,
}));
const history: ConversationMessageDto[] = [leaderMessage, first, second, reviewerReply, ...trailing];

async function openGroup(page: Page, locale = "en") {
  await page.addInitScript((value) => localStorage.setItem("relay-locale", value), locale);
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": {
        result = { ...scope, messages: history, oldestSeq: 1, newestSeq: 4, hasMoreBefore: false, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { runs: [run], activeRunId: run.id, activeRun: run }; break;
      case "control.runs.get": result = { run }; break;
      case "control.runs.details.batch": result = { runs: payload.runIds.includes(run.id) ? [run] : [] }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
}

test("the dispatch row expands into a card listing every bot of the round", async ({ page }, info) => {
  await openGroup(page);
  const row = page.getByTestId("group-dispatch-row");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("group-dispatch-card")).toHaveCount(0);

  await row.click();
  const card = page.getByTestId("group-dispatch-card");
  await expect(card).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  // The dispatch content is named once for the whole round.
  await expect(page.getByTestId("group-dispatch-instructions-label")).toHaveCount(1);
  await expect(page.getByTestId("group-dispatch-instructions")).toHaveText("Review the release diff");
  // One line per dispatched bot, with its state and reply preview.
  const members = card.getByTestId("group-dispatch-member");
  await expect(members).toHaveCount(2);
  await expect(members.nth(0).getByTestId("group-dispatch-member-name")).toHaveText("Reviewer");
  await expect(members.nth(0).getByTestId("group-dispatch-member-status")).toHaveText("Completed");
  await expect(members.nth(0).getByTestId("group-dispatch-member-preview")).toHaveText("REVIEWER FINDINGS");
  await expect(members.nth(1).getByTestId("group-dispatch-member-name")).toHaveText("Tester");
  await expect(members.nth(1).getByTestId("group-dispatch-member-status")).toHaveText("Running");
  // A bot that has not answered shows no preview and cannot be jumped to.
  await expect(members.nth(1).getByTestId("group-dispatch-member-preview")).toHaveCount(0);
  await expect(members.nth(1)).toBeDisabled();
  await page.screenshot({ path: info.outputPath("dispatch-card.png") });

  // Clicking a bot with a reply jumps to that reply.
  await members.nth(0).click();
  const target = page.locator('[data-message-id="reply_reviewer"]');
  const offset = await target.evaluate((row) => row.getBoundingClientRect().top
    - row.closest('[data-test="group-transcript-scroller"]')!.getBoundingClientRect().top);
  expect(Math.abs(offset)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-message-id"))).toBe("reply_reviewer");

  // The card collapses again.
  await row.click();
  await expect(page.getByTestId("group-dispatch-card")).toHaveCount(0);
  await expect(row).toHaveAttribute("aria-expanded", "false");
});

test("the dispatch card opens from the keyboard and stays within the transcript width", async ({ page }) => {
  await openGroup(page);
  const row = page.getByTestId("group-dispatch-row");
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("group-dispatch-card")).toBeVisible();
  const scroller = page.getByTestId("group-transcript-scroller");
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Space");
  await expect(page.getByTestId("group-dispatch-card")).toHaveCount(0);
});

test("the dispatch content is localized", async ({ page }) => {
  await openGroup(page, "zh-CN");
  await page.getByTestId("group-dispatch-row").click();
  await expect(page.getByTestId("group-dispatch-instructions-label")).toHaveText("派发内容");
});

test("the leader pill below the dispatch row stops only the leader", async ({ page }, info) => {
  const cancelled: unknown[] = [];
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
    if (type === "control.runs.cancelMember") {
      cancelled.push(payload);
      await route.fulfill({ json: { result: { run } } });
      return;
    }
    await route.fallback();
  });
  await openGroup(page);

  const pill = page.getByTestId("group-dispatch-stop-leader");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveText("Stop Lead");
  await pill.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("dispatch-leader-pill.png") });

  await pill.click();
  // The scoped stop asks for no confirmation: the dispatched members keep running.
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect.poll(() => cancelled.length).toBe(1);
  expect(cancelled[0]).toEqual({ runId: run.id, memberTurnId: "turn_lead" });
});
