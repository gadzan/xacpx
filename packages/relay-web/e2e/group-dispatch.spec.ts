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

/**
 * The round's detail surface: desktop expands an inline card below the row,
 * mobile opens a bottom sheet. Both name the dispatch content once and list
 * one line per dispatched bot with its name and state.
 */
function details(page: Page, mobile: boolean) {
  return mobile
    ? {
      surface: page.getByTestId("group-dispatch-sheet"),
      label: page.getByTestId("group-dispatch-sheet-instructions-label"),
      instructions: page.getByTestId("group-dispatch-sheet-instructions"),
      members: page.getByTestId("group-dispatch-sheet-row"),
      name: "group-dispatch-sheet-member-name",
      status: "group-dispatch-sheet-member-status",
    }
    : {
      surface: page.getByTestId("group-dispatch-card"),
      label: page.getByTestId("group-dispatch-instructions-label"),
      instructions: page.getByTestId("group-dispatch-instructions"),
      members: page.getByTestId("group-dispatch-member"),
      name: "group-dispatch-member-name",
      status: "group-dispatch-member-status",
    };
}

test("the dispatch row opens the round details listing every bot of the round", async ({ page, isMobile }, info) => {
  await openGroup(page);
  const row = page.getByTestId("group-dispatch-row");
  const view = details(page, isMobile);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(view.surface).toHaveCount(0);

  await row.click();
  await expect(view.surface).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  if (isMobile) {
    // The sheet is a viewport overlay: fully on screen, close control included.
    await expect(view.surface).toBeInViewport({ ratio: 1 });
    await expect(view.surface.getByTestId("sheet-close")).toBeInViewport({ ratio: 1 });
    await expect(row).toHaveAttribute("aria-haspopup", "dialog");
    await expect(view.surface).toHaveAttribute("role", "dialog");
    await expect(view.surface).toHaveAccessibleName("Sent to 2 bots");
    await expect(view.surface.getByRole("heading", { name: "Sent to 2 bots" })).toBeVisible();
  }
  // The dispatch content is named once for the whole round.
  await expect(view.label).toHaveCount(1);
  await expect(view.label).toHaveText("Instructions");
  await expect(view.instructions).toHaveText("Review the release diff");
  // One line per dispatched bot, with its state.
  await expect(view.members).toHaveCount(2);
  await expect(view.members.nth(0).getByTestId(view.name)).toHaveText("Reviewer");
  await expect(view.members.nth(0).getByTestId(view.status)).toHaveText("Completed");
  await expect(view.members.nth(0)).toHaveAttribute("data-member-turn-id", "turn_reviewer");
  await expect(view.members.nth(1).getByTestId(view.name)).toHaveText("Tester");
  await expect(view.members.nth(1).getByTestId(view.status)).toHaveText("Running");
  await expect(view.members.nth(1)).toHaveAttribute("data-member-turn-id", "turn_tester");
  await page.screenshot({ path: info.outputPath("dispatch-details.png") });

  // The details close again: desktop toggles the card, mobile closes the sheet.
  if (isMobile) await view.surface.getByTestId("sheet-close").click();
  else await row.click();
  await expect(view.surface).toHaveCount(0);
  await expect(row).toHaveAttribute("aria-expanded", "false");
});

test("the dispatch card shows reply previews and jumps to a member's reply", async ({ page, isMobile }) => {
  test.skip(isMobile, "inline reply previews and jump exist only in the desktop card; the mobile sheet lists name and state");
  await openGroup(page);
  const row = page.getByTestId("group-dispatch-row");
  await row.click();
  const card = page.getByTestId("group-dispatch-card");
  const members = card.getByTestId("group-dispatch-member");
  await expect(members.nth(0).getByTestId("group-dispatch-member-preview")).toHaveText("REVIEWER FINDINGS");
  // A bot that has not answered shows no preview and cannot be jumped to.
  await expect(members.nth(1).getByTestId("group-dispatch-member-preview")).toHaveCount(0);
  await expect(members.nth(1)).toBeDisabled();

  // Clicking a bot with a reply jumps to that reply.
  await members.nth(0).click();
  const target = page.locator('[data-message-id="reply_reviewer"]');
  const offset = await target.evaluate((row) => row.getBoundingClientRect().top
    - row.closest('[data-test="group-transcript-scroller"]')!.getBoundingClientRect().top);
  expect(Math.abs(offset)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-message-id"))).toBe("reply_reviewer");
});

test("the dispatch details open from the keyboard and stay within the viewport width", async ({ page, isMobile }) => {
  await openGroup(page);
  const row = page.getByTestId("group-dispatch-row");
  const view = details(page, isMobile);
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(view.surface).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  const scroller = page.getByTestId("group-transcript-scroller");
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  if (isMobile) {
    // The sheet fits the viewport and owns focus; Escape closes it and
    // returns focus to the row.
    await expect(view.surface).toBeInViewport({ ratio: 1 });
    const box = (await view.surface.boundingBox())!;
    const width = page.viewportSize()!.width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(await view.surface.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => view.surface.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(view.surface).toHaveCount(0);
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeFocused();
  } else {
    // Desktop: Escape collapses the card and hands focus back to the capsule,
    // wherever inside the card focus had moved to.
    await page.getByTestId("group-dispatch-member").first().focus();
    await page.keyboard.press("Escape");
    await expect(view.surface).toHaveCount(0);
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeFocused();
    await page.keyboard.press("Space");
    await expect(view.surface).toBeVisible();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(view.surface).toHaveCount(0);
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await expect(row).toBeFocused();
  }
});

test("the dispatch content is localized", async ({ page, isMobile }) => {
  await openGroup(page, "zh-CN");
  const view = details(page, isMobile);
  await expect(page.getByTestId("group-dispatch-row")).toHaveAccessibleName("派发给 2 个 Bot · 1 执行中 · 展开派发详情");
  await page.getByTestId("group-dispatch-row").click();
  await expect(page.getByTestId("group-dispatch-row")).toHaveAccessibleName("派发给 2 个 Bot · 1 执行中 · 收起派发详情");
  await expect(view.label).toHaveText("派发内容");
  await expect(view.members.nth(0).getByTestId(view.status)).toHaveText("已完成");
  await expect(view.members.nth(1).getByTestId(view.status)).toHaveText("执行中");
  if (isMobile) await expect(view.surface).toHaveAccessibleName("派发给 2 个 Bot");
  else await expect(page.getByTestId("group-dispatch-title")).toHaveText("派发给 2 个 Bot");
  // The leader stop label joins verb and name without a space.
  await expect(page.getByTestId("group-dispatch-stop-leader")).toHaveText("停止 Lead");
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

// ---------------------------------------------------------------------------
// Handoff rounds (migrated from group-handoff.spec.ts). A leader turn that
// dispatches handoffs renders ONE aggregated dispatch row at the first
// handoff; the per-handoff entry no longer has an entry point. These cases
// keep the old guarantees — exact result association, inert task text,
// scroll stability on expand and prepend, live-delivery dedupe and reconnect
// identity — asserted through the aggregated row.
// ---------------------------------------------------------------------------
const roundScope = { conversationId: "group_handoff", topicId: "topic_handoff", createdAt };
const roundBots = [
  { id: "reviewer", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const roundGroup = { id: roundScope.conversationId, kind: "group", title: "Handoff team", botIds: roundBots.map((bot) => bot.id), leadBotId: "reviewer", createdAt, updatedAt: createdAt };
const roundTopic = { id: roundScope.topicId, conversationId: roundScope.conversationId, title: "Release", status: "active", createdAt, updatedAt: createdAt };
const roundHistorical: ConversationRunDetailDto = {
  ...roundScope, id: "run_history", requestMessageId: "request_old", requestId: "old", mode: "explicit", state: "completed", profileRevision: 1,
  memberTurns: [
    { ...roundScope, id: "turn_first", runId: "run_history", botId: "tester", batch: 1, attempt: 1, origin: "handoff", state: "indeterminate", assignmentId: "first", promptRequestId: "prompt_first" },
    { ...roundScope, id: "turn_second", runId: "run_history", botId: "tester", batch: 1, attempt: 1, origin: "handoff", state: "completed", assignmentId: "second", promptRequestId: "prompt_second" },
  ],
};
const roundCurrent: ConversationRunDetailDto = {
  ...roundScope, id: "run_current", requestMessageId: "request_live", requestId: "live", mode: "explicit", state: "running", profileRevision: 1,
  memberTurns: [{ ...roundScope, id: "turn_live", runId: "run_current", botId: "reviewer", batch: 1, attempt: 1, origin: "human-explicit", state: "running" }],
};
function roundHandoff(id: string, seq: number, assignment: string, task: string): ConversationMessageDto {
  return { ...roundScope, id, seq, runId: roundHistorical.id, role: "system", senderBotId: "reviewer", content: "", handoff: {
    senderMemberTurnId: "turn_sender", to: "tester", assignmentId: assignment, memberTurnId: `turn_${assignment}`,
    task, expectedOutput: "A concise report",
  } };
}
const roundFirst = roundHandoff("handoff_first", 21, "first", "<img src=x onerror=alert(1)> Review first task");
const roundSecond = roundHandoff("handoff_second", 22, "second", "Test second task");
const roundResult: ConversationMessageDto = { ...roundScope, id: "reply_second", seq: 23, runId: roundHistorical.id, role: "bot", senderBotId: "tester", promptRequestId: "prompt_second", content: "SECOND ASSIGNMENT RESULT" };
const roundInitial: ConversationMessageDto[] = [roundFirst, roundSecond, roundResult, ...Array.from({ length: 47 }, (_, i) => ({ ...roundScope, id: `tail_${i}`, seq: i + 24, role: "human" as const, content: `Ordinary message ${i}` }))];

async function openRound(page: Page, locale = "en", messages = roundInitial) {
  const roundHistory = [...messages];
  await page.addInitScript((value) => localStorage.setItem("relay-locale", value), locale);
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots: roundBots }; break;
      case "control.groups.list": result = { groups: [roundGroup] }; break;
      case "control.groups.get": result = { group: { ...roundGroup, topics: [roundTopic] } }; break;
      case "control.topics.list": result = { topics: [roundTopic] }; break;
      case "control.conversation.history": {
        const older = Array.from({ length: 20 }, (_, i) => ({ ...roundScope, id: `older_${i}`, seq: i + 1, role: "human", content: `Older message ${i}` }));
        const rows = payload.beforeSeq ? older : payload.afterSeq ? roundHistory.filter((message) => message.seq > payload.afterSeq) : roundHistory;
        result = { ...roundScope, messages: rows, oldestSeq: rows[0]?.seq, newestSeq: rows.at(-1)?.seq, hasMoreBefore: !payload.beforeSeq && !payload.afterSeq, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { runs: [roundCurrent, roundHistorical], activeRunId: roundCurrent.id, activeRun: roundCurrent }; break;
      case "control.runs.get": result = { run: payload.runId === roundHistorical.id ? roundHistorical : roundCurrent }; break;
      case "control.runs.details.batch": result = { runs: [roundHistorical, roundCurrent].filter((r) => payload.runIds.includes(r.id)) }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
  await expect(page.getByTestId("group-target-button")).toBeEnabled();
  return roundHistory;
}


// A round with exactly one dispatched member: the same aggregate row, with
// the lone bot named instead of counted.
const soloScope = { conversationId: "group_solo", topicId: "topic_solo", createdAt };
const soloBots = [{ id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt }];
const soloGroup = { id: soloScope.conversationId, kind: "group", title: "Solo team", botIds: soloBots.map((bot) => bot.id), leadBotId: "tester", createdAt, updatedAt: createdAt };
const soloTopic = { id: soloScope.topicId, conversationId: soloScope.conversationId, title: "Solo", status: "active", createdAt, updatedAt: createdAt };
const soloRun: ConversationRunDetailDto = {
  ...soloScope, id: "run_solo", requestMessageId: "request_solo", requestId: "solo", mode: "explicit", state: "running", profileRevision: 1,
  memberTurns: [
    { ...soloScope, id: "turn_solo_lead", runId: "run_solo", botId: "tester", batch: 0, attempt: 1, origin: "human-explicit", state: "running", promptRequestId: "prompt_solo_lead" },
    { ...soloScope, id: "turn_solo_member", runId: "run_solo", botId: "tester", batch: 1, attempt: 1, origin: "handoff", state: "running" },
  ],
};
const soloHandoff: ConversationMessageDto = {
  ...soloScope, id: "handoff_solo", seq: 2, runId: soloRun.id, role: "system", senderBotId: "tester", content: "",
  handoff: {
    senderMemberTurnId: "turn_solo_lead", to: "tester", assignmentId: "assignment_solo",
    memberTurnId: "turn_solo_member", task: "Review the solo diff",
  },
};

async function openSoloRound(page: Page, locale = "en") {
  // No leader reply is loaded, so the round anchors at its own handoff.
  const history: ConversationMessageDto[] = [soloHandoff];
  await page.addInitScript((value) => localStorage.setItem("relay-locale", value), locale);
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots: soloBots }; break;
      case "control.groups.list": result = { groups: [soloGroup] }; break;
      case "control.groups.get": result = { group: { ...soloGroup, topics: [soloTopic] } }; break;
      case "control.topics.list": result = { topics: [soloTopic] }; break;
      case "control.conversation.history": {
        result = { ...soloScope, messages: history, oldestSeq: 2, newestSeq: 2, hasMoreBefore: false, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { runs: [soloRun], activeRunId: soloRun.id, activeRun: soloRun }; break;
      case "control.runs.get": result = { run: soloRun }; break;
      case "control.runs.details.batch": result = { runs: payload.runIds.includes(soloRun.id) ? [soloRun] : [] }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
}
for (const locale of ["en", "zh-CN"]) {
  test(`a handoff round stays compact and associates only exact results in ${locale}`, async ({ page, isMobile }, info) => {
    await openRound(page, locale);
    const anchor = page.locator('[data-message-id="handoff_first"]');
    const row = anchor.getByTestId("group-dispatch-row");
    const view = details(page, isMobile);
    const title = locale === "en" ? "Sent to 2 bots" : "派发给 2 个 Bot";
    // One aggregated row for the round; the second handoff collapses into it
    // and the per-handoff entry never renders.
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId("group-dispatch-row")).toHaveCount(1);
    await expect(page.locator('[data-message-id="handoff_second"]')).toHaveCount(0);
    await expect(page.getByTestId("group-handoff")).toHaveCount(0);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toHaveAttribute("aria-expanded", "false");
    // A partly done round words its done count compactly ("1 已完成", not the
    // all-done "1 个已完成").
    const partial = locale === "en" ? "1 done" : "1 已完成";
    if (isMobile) {
      await expect(row.getByTestId("group-dispatch-summary")).toContainText(locale === "en" ? "2 bots" : "2 个 Bot");
      await expect(row.getByTestId("group-dispatch-summary")).toContainText(partial);
    } else {
      await expect(row.getByTestId("group-dispatch-title")).toHaveText(title);
      await expect(row.getByTestId("group-dispatch-status-done")).toHaveText(`✓ ${partial}`);
    }
    // The unknown count comes last and says so in muted tone, never in red.
    const unknown = locale === "en" ? "1 unknown" : "1 个结果未知";
    if (isMobile) {
      // The mobile pill has no room for the long wording.
      await expect(row.getByTestId("group-dispatch-summary")).toContainText(locale === "en" ? "1 unknown" : "1 未知");
    } else {
      await expect(row.getByTestId("group-dispatch-status-indeterminate")).toContainText(unknown);
      await expect(row.getByTestId("group-dispatch-status-indeterminate")).toHaveClass(/text-fg-muted/);
    }
    // Same bot dispatched twice: one avatar per member turn, never per bot.
    await expect(row.getByTestId("group-dispatch-avatars").locator(":scope > span")).toHaveCount(2);
    expect(await anchor.locator('[data-avatar-key="row"]').count()).toBe(0);
    await page.screenshot({ path: info.outputPath(`dispatch-round-${locale}-collapsed.png`) });

    await row.focus();
    await page.keyboard.press("Enter");
    await expect(row).toHaveAttribute("aria-expanded", "true");
    await expect(view.surface).toBeVisible();
    if (isMobile) {
      await expect(view.surface).toHaveAccessibleName(title);
      await expect(view.surface).toBeInViewport({ ratio: 1 });
    }
    // Task text is rendered inert.
    await expect(view.instructions).toHaveText("<img src=x onerror=alert(1)> Review first task");
    await expect(view.surface.locator("img")).toHaveCount(0);
    // Exact association: one line per member turn, each with its own state.
    await expect(view.members).toHaveCount(2);
    const firstMember = view.members.and(page.locator('[data-member-turn-id="turn_first"]'));
    const secondMember = view.members.and(page.locator('[data-member-turn-id="turn_second"]'));
    await expect(firstMember.getByTestId(view.status)).toHaveText(locale === "en" ? "Outcome unknown" : "结果未知");
    await expect(secondMember.getByTestId(view.status)).toHaveText(locale === "en" ? "Completed" : "已完成");
    await expect(firstMember).not.toContainText(roundResult.content);
    const scroller = page.getByTestId("group-transcript-scroller");
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`dispatch-round-${locale}-expanded.png`) });
    if (isMobile) {
      const box = (await view.surface.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      await page.keyboard.press("Escape");
      await expect(view.surface).toHaveCount(0);
      await expect(row).toBeFocused();
    } else {
      for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        await row.scrollIntoViewIfNeeded();
        expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await row.focus();
      await page.keyboard.press("Space");
      await expect(row).toBeFocused();
      await expect(view.surface).toHaveCount(0);
    }
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    // Expansion is view state: a reload restores the collapsed row with the
    // same exact association.
    await page.reload();
    const restored = page.locator('[data-message-id="handoff_first"]').getByTestId("group-dispatch-row");
    await expect(restored).toHaveAttribute("aria-expanded", "false");
    await restored.click();
    await expect(view.members.and(page.locator('[data-member-turn-id="turn_second"]')).getByTestId(view.status))
      .toHaveText(locale === "en" ? "Completed" : "已完成");
  });

  test(`a handoff round previews only the exact result in ${locale}`, async ({ page, isMobile }) => {
    test.skip(isMobile, "inline reply previews exist only in the desktop card; the mobile sheet lists name and state");
    await openRound(page, locale);
    const anchor = page.locator('[data-message-id="handoff_first"]');
    await anchor.getByTestId("group-dispatch-row").click();
    const card = anchor.getByTestId("group-dispatch-card");
    const firstMember = card.locator('[data-test="group-dispatch-member"][data-member-turn-id="turn_first"]');
    const secondMember = card.locator('[data-test="group-dispatch-member"][data-member-turn-id="turn_second"]');
    await expect(firstMember.getByTestId("group-dispatch-member-preview")).toHaveCount(0);
    await expect(firstMember).toBeDisabled();
    await expect(secondMember.getByTestId("group-dispatch-member-preview")).toHaveText("SECOND ASSIGNMENT RESULT");
    await expect(secondMember).toBeEnabled();
    await page.reload();
    await page.locator('[data-message-id="handoff_first"]').getByTestId("group-dispatch-row").click();
    await expect(page.locator('[data-test="group-dispatch-member"][data-member-turn-id="turn_second"]').getByTestId("group-dispatch-member-preview"))
      .toHaveText("SECOND ASSIGNMENT RESULT");
  });
}

for (const locale of ["en", "zh-CN"]) {
  test(`a lone dispatch renders the same aggregate row in ${locale}`, async ({ page, isMobile }) => {
    await openSoloRound(page, locale);
    const anchor = page.locator('[data-message-id="handoff_solo"]');
    const row = anchor.getByTestId("group-dispatch-row");
    const view = details(page, isMobile);
    // The old per-handoff entry is gone: the round has exactly one row.
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId("group-handoff")).toHaveCount(0);
    // A lone dispatch names its bot instead of counting it.
    const title = locale === "en" ? "Sent to Tester" : "派发给 Tester";
    const active = locale === "en" ? "1 running" : "1 执行中";
    if (isMobile) {
      await expect(row.getByTestId("group-dispatch-summary")).toContainText(title);
      await expect(row.getByTestId("group-dispatch-summary")).toContainText(active);
    } else {
      await expect(row.getByTestId("group-dispatch-title")).toHaveText(title);
      await expect(row.getByTestId("group-dispatch-status-active")).toHaveText(active);
    }
    await row.click();
    // The card holds exactly one member row.
    await expect(view.members).toHaveCount(1);
    await expect(view.members.nth(0).getByTestId(view.name)).toHaveText("Tester");
    await expect(view.members.nth(0).getByTestId(view.status)).toHaveText(locale === "en" ? "Running" : "执行中");
    await expect(view.members.nth(0)).toHaveAttribute("data-member-turn-id", "turn_solo_member");
  });
}

test("prepend, duplicate live delivery and reconnect preserve the dispatch row identity and scroll", async ({ page, hub, isMobile }) => {
  const roundHistory = await openRound(page);
  const scroller = page.getByTestId("group-transcript-scroller");
  const anchor = page.locator('[data-message-id="handoff_first"]');
  const row = anchor.getByTestId("group-dispatch-row");
  const view = details(page, isMobile);
  const third = () => view.members.and(page.locator('[data-member-turn-id="turn_third"]'));
  /** Mobile: the sheet is modal, so it is closed before touching the transcript. */
  async function closeSheet() {
    if (!isMobile) return;
    await expect(view.surface).toBeInViewport({ ratio: 1 });
    await view.surface.getByTestId("sheet-close").click();
    await expect(view.surface).toHaveCount(0);
  }
  async function open() {
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
    await expect(view.surface).toBeVisible();
  }
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const topBefore = await scroller.evaluate((el) => el.scrollTop);
  await row.click();
  const anchorBefore = await anchor.evaluate((el) => el.getBoundingClientRect().top);
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(view.members).toHaveCount(2);
  // Opening the details never moves the reader.
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(topBefore);

  // A live handoff of the same leader turn joins the round; delivering the
  // same event twice must not add it twice.
  const live: ConversationMessageDto = roundHandoff("live_handoff", 71, "third", "Test third task");
  roundHistory.push(live);
  const event = { kind: "control-event" as const, instanceId: "i1", event: { type: "conversation-message" as const, message: live } };
  hub.send(event);
  hub.send(event);
  await expect(view.members).toHaveCount(3);
  await expect(third()).toHaveCount(1);
  if (isMobile) await expect(view.surface).toHaveAccessibleName("Sent to 3 bots");
  else await expect(row.getByTestId("group-dispatch-title")).toHaveText("Sent to 3 bots");
  await expect(page.getByTestId("group-dispatch-row")).toHaveCount(1);
  await expect(page.locator('[data-message-id="live_handoff"]')).toHaveCount(0);
  expect(await anchor.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(anchorBefore, 0);
  await closeSheet();

  // Prepending older history keeps the anchor in place (and the desktop card open).
  await page.getByTestId("group-load-older-button").click();
  await expect(page.locator('[data-message-id="older_0"]')).toHaveCount(1);
  if (!isMobile) await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => anchor.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(anchorBefore, 0);
  const ids = await scroller.locator("[data-message-id]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-message-id")));
  expect(ids.slice(20, 22)).toEqual(["handoff_first", "reply_second"]);

  // Reconnect reloads history; the round keeps one row and three members.
  const oldSockets = new Set(hub.sockets);
  const reloaded = page.waitForResponse((response) => response.url().endsWith("/rpc")
    && response.request().postDataJSON()?.type === "control.conversation.history");
  hub.closeSockets();
  await expect.poll(() => hub.sockets.some((socket) => !oldSockets.has(socket) && socket.readyState === 1), { timeout: 20_000 }).toBe(true);
  await reloaded;
  await expect(page.getByTestId("group-dispatch-row")).toHaveCount(1);
  await expect(page.locator('[data-message-id="live_handoff"]')).toHaveCount(0);
  await open();
  await expect(view.members).toHaveCount(3);
  await expect(third()).toHaveCount(1);
});

for (const distance of ["nearby", "distant"] as const) {
  test(`dispatch member navigation transfers keyboard focus and Tab stays at the ${distance} reply`, async ({ page, isMobile }, info) => {
    test.skip(isMobile, "member jump lives in the desktop dispatch card; the mobile sheet has no jump");
    const between: ConversationMessageDto[] = distance === "distant"
      ? Array.from({ length: 80 }, (_, index) => ({
        ...roundScope, id: `between_${index}`, seq: index + 23, role: "human",
        content: Array.from({ length: 1 + (index % 7) * 4 }, (_, line) => `History ${index}, line ${line}`).join("\n"),
      }))
      : [];
    const replySeq = between.length + 23;
    await openRound(page, "en", [
      roundFirst, roundSecond, ...between, { ...roundResult, seq: replySeq },
      ...Array.from({ length: 12 }, (_, index) => ({
        ...roundScope, id: `after_${index}`, seq: replySeq + index + 1, role: "human" as const,
        content: `After the result ${index}`,
      })),
    ]);
    const row = page.locator('[data-message-id="handoff_first"]').getByTestId("group-dispatch-row");
    await row.scrollIntoViewIfNeeded();
    await row.focus();
    await page.keyboard.press("Enter");
    const jump = page.locator('[data-test="group-dispatch-member"][data-member-turn-id="turn_second"]');
    await expect(jump).toBeVisible();
    await expect(jump).toBeEnabled();
    await jump.focus();
    await page.keyboard.press("Enter");
    const target = page.locator('[data-message-id="reply_second"]');
    await expect.poll(() => target.evaluate((r) => Math.abs(r.getBoundingClientRect().top
      - r.closest('[data-test="group-transcript-scroller"]')!.getBoundingClientRect().top))).toBeLessThanOrEqual(1);
    const replyText = target.getByText("SECOND ASSIGNMENT RESULT", { exact: true });
    await expect(replyText).toBeInViewport({ ratio: 1 });
    const focusedAfterJump = await page.evaluate(() => document.activeElement?.getAttribute("data-message-id"));
    await page.keyboard.press("Tab");
    await page.screenshot({ path: info.outputPath(`dispatch-result-${distance}-keyboard.png`) });
    expect(focusedAfterJump).toBe("reply_second");
    await expect(target.getByTestId("agent-thinking-bubble")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(target.getByRole("button", { name: "Copy", exact: true })).toBeFocused();
    await expect(replyText).toBeInViewport({ ratio: 1 });
  });
}
