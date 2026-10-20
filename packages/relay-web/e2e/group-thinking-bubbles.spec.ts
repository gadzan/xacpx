import type { Locator, Page, TestInfo } from "@playwright/test";
import type {
  ConversationMessageDto, ConversationRunDetailDto, ConversationRunTraceDto,
  ConversationRunTraceEventDto, MemberTurnSummaryDto, RunsTraceGetPayload,
} from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

const createdAt = "2026-10-19T12:00:00.000Z";
const scope = { conversationId: "group_thinking", topicId: "topic_thinking" };
const bots = ["reviewer", "tester"].map((id) => ({
  id, name: id === "reviewer" ? "Reviewer" : "Tester", agent: "codex", workspace: "repo", enabled: true, createdAt, updatedAt: createdAt,
}));
const group = { id: scope.conversationId, kind: "group", title: "Thinking team", botIds: bots.map(({ id }) => id), leadBotId: "reviewer", createdAt, updatedAt: createdAt };
const topics = [
  { id: scope.topicId, conversationId: scope.conversationId, title: "Implementation", status: "active", createdAt, updatedAt: createdAt },
  { id: "topic_other", conversationId: scope.conversationId, title: "Other topic", status: "active", createdAt, updatedAt: createdAt },
];
type Scenario = "one" | "multi" | "same-bot";
function member(id: string, botId: string, index: number, runId = "run_history"): MemberTurnSummaryDto {
  return {
    ...scope, id, runId, botId, batch: index + 1, memberIndex: index, attempt: 1,
    origin: index === 0 ? "human-explicit" : "followup", state: "completed",
    promptRequestId: `prompt_${id}`, assignmentId: `assignment_${id}`, task: `Public task for ${id}`,
    expectedOutput: "A concise public report",
    ...(index > 0 ? { dependsOn: ["assignment_turn_first"] } : {}),
    createdAt, startedAt: createdAt, finishedAt: "2026-10-19T12:00:04.000Z",
  };
}
function message(id: string, seq: number, content: string, extra: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return { ...scope, id, seq, role: "human", content, createdAt, ...extra };
}
function bubble(page: Page, memberId: string): Locator {
  return page.locator(`[data-test="agent-turn-row"][data-member-turn-id="${memberId}"]`).getByTestId("agent-thinking-bubble");
}
const detail = (page: Page) => page.getByTestId("group-detail-card");
async function screenshot(page: Page, info: TestInfo, name: string) {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}
async function expectInsideViewport(page: Page) {
  const card = page.getByTestId("group-detail-card");
  await expect(card).toBeVisible();
  await expect.poll(async () => card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
  })).toBe(true);
  expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.getByTestId("group-transcript-scroller").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

async function openGroup(page: Page, options: { scenario?: Scenario; longHistory?: boolean; theme?: "light" | "dark"; locale?: string } = {}) {
  const turns = [member("turn_first", "reviewer", 0)];
  if (options.scenario !== "one") turns.push(member("turn_second", options.scenario === "multi" ? "tester" : "reviewer", 1));
  const historical: ConversationRunDetailDto = {
    ...scope, id: "run_history", requestMessageId: "request_history", requestId: "request_history_nonce",
    mode: options.scenario === "one" ? "explicit" : "automatic", state: "completed", profileRevision: 3,
    maxMemberTurns: 6, consumedMemberTurns: turns.length, createdAt,
    ...(options.scenario === "one" ? {} : { routingState: "done", routingReason: "Sequential review then verification" }),
    startedAt: createdAt, finishedAt: "2026-10-19T12:00:09.000Z", memberTurns: turns,
  };
  const liveMember = { ...member("turn_live", "tester", 0, "run_current"), state: "running" as const, finishedAt: undefined };
  let current: ConversationRunDetailDto = {
    ...scope, id: "run_current", requestMessageId: "request_current", requestId: "request_current_nonce", mode: "explicit",
    state: "running", profileRevision: 3, createdAt, startedAt: createdAt, memberTurns: [liveMember],
  };
  const messages = [message("request_history", 21, "Review the change"), ...turns.map((turn, index) => message(`reply_${turn.id}`, 22 + index, `CANONICAL ${turn.id}`, {
    role: "bot", senderBotId: turn.botId, runId: historical.id, promptRequestId: turn.promptRequestId,
  })), message("request_current", 27, "Verify the current change")];
  if (options.longHistory) messages.push(...Array.from({ length: 45 }, (_, index) => message(`tail_${index}`, 28 + index, `Later history ${index}\nSecond line of ordinary conversation`)));
  const older = Array.from({ length: 20 }, (_, index) => message(`older_${index}`, index + 1, `Earlier history ${index}`));
  const traceRequests: RunsTraceGetPayload[] = [];
  const cancels: string[] = [];
  const events = new Map<string, ConversationRunTraceEventDto[]>();
  for (const turn of [...turns, liveMember]) {
    const chunks: ConversationRunTraceEventDto[] = Array.from({ length: 99 }, (_, index) => ({
      seq: index + 1, createdAt, kind: "text" as const, payload: { text: `RECORDED ${turn.id} chunk ${index + 1}` },
    }));
    chunks.push(
      { seq: 100, createdAt, kind: "text", payload: { text: `Reasoning for ${turn.id}` } },
      { seq: 101, createdAt, kind: "tool", payload: { step: { toolCallId: `tool_${turn.id}`, toolName: "read_file", kind: "read", status: "success", title: `Read ${turn.id}.ts`, durationMs: 12 } } },
      ...(turn.id === liveMember.id ? [] : [{ seq: 102, createdAt, kind: "terminal" as const, payload: { ok: true } }]),
    );
    events.set(turn.id, chunks);
  }
  await page.addInitScript(({ theme, locale }) => {
    localStorage.setItem("relay-locale", locale);
    localStorage.setItem("relay-theme", theme);
  }, { theme: options.theme ?? "light", locale: options.locale ?? "en" });
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload = {} } = route.request().postDataJSON();
    const other = payload.topicId === "topic_other";
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics } }; break;
      case "control.topics.list": result = { topics }; break;
      case "control.conversation.history": {
        const rows = other ? [] : payload.beforeSeq ? older.filter((row) => row.seq < payload.beforeSeq) : payload.afterSeq ? messages.filter((row) => row.seq > payload.afterSeq) : messages;
        result = { ...scope, topicId: other ? "topic_other" : scope.topicId, messages: rows, oldestSeq: rows[0]?.seq, newestSeq: rows.at(-1)?.seq,
          hasMoreBefore: !other && !!options.longHistory && !payload.beforeSeq && !payload.afterSeq, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { ...scope, topicId: other ? "topic_other" : scope.topicId, runs: other ? [] : [current, historical],
        ...(!other && current.state === "running" ? { activeRunId: current.id, activeRun: current } : {}) }; break;
      case "control.runs.get": result = { run: payload.runId === historical.id ? historical : current }; break;
      case "control.runs.details.batch": result = { runs: [historical, current].filter((run) => payload.runIds.includes(run.id)), missingRunIds: [] }; break;
      case "control.runs.trace.get": {
        traceRequests.push(payload);
        expect(payload.conversationId).toBe(scope.conversationId);
        expect(payload.topicId).toBe(scope.topicId);
        const turn = [...turns, liveMember].find((candidate) => candidate.id === payload.memberTurnId);
        expect(turn, "trace lookup uses an existing durable member").toBeDefined();
        expect(payload.runId).toBe(turn!.runId);
        expect(payload.attempt).toBe(turn!.attempt);
        const all = events.get(turn!.id)!;
        const remaining = all.filter((event) => event.seq > (payload.afterSeq ?? 0));
        const pageEvents = remaining.slice(0, payload.limit ?? 100);
        result = {
          memberTurnId: turn!.id, attempt: turn!.attempt, recordingState: turn!.id === liveMember.id && current.state === "running" ? "recording" : "complete",
          events: pageEvents, nextSeq: pageEvents.at(-1)?.seq ?? payload.afterSeq ?? 0, hasMore: remaining.length > pageEvents.length,
          attempts: [1], plan: [{ content: "Recorded public plan", status: "completed" }],
        } satisfies ConversationRunTraceDto;
        break;
      }
      case "control.runs.cancel":
        cancels.push(payload.runId);
        current = { ...current, state: "cancelled", memberTurns: [{ ...liveMember, state: "cancelled" }] };
        result = { run: current }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
  await expect(bubble(page, "turn_first")).toHaveCount(1);
  return { historical, current, liveMember, messages, events, traceRequests, cancels, turns };
}

for (const scenario of ["one", "multi", "same-bot"] as const) {
  test(`${scenario}: durable member bubbles own exact canonical replies and isolated paged traces`, async ({ page }, info) => {
    const fixture = await openGroup(page, { scenario });
    await expect(page.getByTestId("group-run-card")).toHaveCount(0);
    const anchorIds = await page.locator("[data-anchor-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-anchor-id")));
    expect(new Set(anchorIds).size).toBe(anchorIds.length);
    expect(fixture.traceRequests).toHaveLength(0);
    for (const turn of fixture.turns) {
      const trigger = bubble(page, turn.id);
      await expect(trigger).toHaveCount(1);
      const reply = page.locator(`[data-row-id="reply_${turn.id}"]`);
      await expect(reply).toContainText(`CANONICAL ${turn.id}`);
      await expect(reply.getByTestId("agent-thinking-bubble")).toHaveCount(1);
      await expect(page.getByText(`CANONICAL ${turn.id}`, { exact: true })).toHaveCount(1);
      await trigger.click();
      await expect(detail(page)).toHaveAttribute("data-member-turn-id", turn.id);
      await expect(detail(page)).toHaveAttribute("data-run-id", fixture.historical.id);
      await expect(detail(page)).toContainText(`RECORDED ${turn.id} chunk 1`);
      await expect(detail(page)).toContainText(`RECORDED ${turn.id} chunk 99`);
      await expect(detail(page)).toContainText(turn.task!);
      await expect(detail(page)).toContainText(turn.assignmentId!);
      await expect(detail(page)).toContainText("Recorded public plan");
      await expect(detail(page).getByTestId("group-stop-run-button")).toHaveCount(0);
      await expect(page.getByTestId("group-trace-load-more")).toBeVisible();
      await page.getByTestId("group-trace-load-more").click();
      await expect(detail(page)).toContainText(`Read ${turn.id}.ts`);
      for (const sibling of fixture.turns.filter((candidate) => candidate.id !== turn.id)) {
        await expect(detail(page)).not.toContainText(`RECORDED ${sibling.id}`);
        await expect(detail(page)).not.toContainText(`Read ${sibling.id}.ts`);
      }
      await screenshot(page, info, `${scenario}-${turn.id}-recorded-process`);
      await page.keyboard.press("Escape");
    }
    await bubble(page, "turn_live").click();
    await expect(detail(page).getByTestId("group-stop-run-button")).toHaveAccessibleName("Stop this run");
    await expect(detail(page)).toHaveAttribute("data-run-id", fixture.current.id);
    await detail(page).getByTestId("group-stop-run-button").click();
    await expect.poll(() => fixture.cancels).toEqual([fixture.current.id]);
    await expect(detail(page).getByTestId("group-stop-run-button")).toHaveCount(0);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: anchored edge geometry, keyboard, outside pointer and reduced motion`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openGroup(page, { scenario: "same-bot", theme });
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
    const trigger = bubble(page, "turn_live");
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const controls = await trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(detail(page)).toHaveAttribute("id", controls!);
    await expectInsideViewport(page);
    const hitArea = await trigger.boundingBox();
    expect(hitArea!.width).toBeGreaterThanOrEqual(44);
    expect(hitArea!.height).toBeGreaterThanOrEqual(44);
    const animations = await trigger.evaluate((el) => [el, ...el.querySelectorAll("*")].map((node) => getComputedStyle(node).animationName));
    expect(animations.every((name) => name === "none")).toBe(true);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await detail(page).getByRole("button", { name: "Close detail", exact: true }).click();
    await expect(detail(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Space");
    await expect(detail(page)).toBeVisible();
    await trigger.click();
    await expect(detail(page)).toHaveCount(0);
    await trigger.click();
    await bubble(page, "turn_first").click();
    await expect(detail(page)).toHaveCount(1);
    await expect(page.getByTestId("group-detail-card")).toContainText("Reviewer");
    // Opening the topic panel must close the detail. Dismiss the panel again
    // (sheet close below lg, pill toggle above) so nothing intercepts taps.
    await page.getByTestId("group-topic-pill").click();
    await expect(detail(page)).toHaveCount(0);
    const panelClose = page.getByTestId("sheet-close");
    if (await panelClose.isVisible()) await panelClose.click();
    else await page.getByTestId("group-topic-pill").click();
    await expect(page.getByTestId("group-topic-pill")).toHaveAttribute("aria-expanded", "false");
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      await expect(detail(page)).toContainText("RECORDED turn_live chunk 1");
      await expectInsideViewport(page);
      const anchor = await page.locator('[data-test="agent-thinking-bubble"][aria-expanded="true"]').first().evaluate((el) => el.getBoundingClientRect());
      const r = await page.getByTestId("group-detail-card").evaluate((el) => el.getBoundingClientRect());
      expect(Math.min(Math.abs(r.top - anchor.bottom), Math.abs(anchor.top - r.bottom))).toBeLessThanOrEqual(24);
      expect(r.width).toBeLessThanOrEqual(viewport.width);
      await screenshot(page, info, `${theme}-${viewport.width}-anchored-reduced-motion`);
      if (info.project.name.includes("mobile")) await page.getByTestId("group-topic-pill").tap();
      else await page.getByTestId("group-topic-pill").click();
      await expect(detail(page)).toHaveCount(0);
      // Below lg the pill opens a sheet; close it so the next iteration's
      // bubble is not behind the backdrop.
      const sheetClose = page.getByTestId("sheet-close");
      if (await sheetClose.isVisible()) await sheetClose.click();
    }
    await trigger.click();
    await expect(detail(page)).toBeVisible();
    await expectInsideViewport(page);
    if (info.project.name.includes("mobile")) await bubble(page, "turn_first").tap();
    else await bubble(page, "turn_first").click();
    await expect(detail(page)).toHaveAttribute("data-member-turn-id", "turn_first");
  });
}

async function switchTopic(page: Page, topicId: string) {
  await page.getByTestId("group-topic-pill").click();
  await page.locator(`[data-test="topic-row"][data-topic-id="${topicId}"]`).getByRole("button").first().click();
  await expect(page.getByTestId("group-topic-pill")).toContainText(topicId === scope.topicId ? "Implementation" : "Other topic");
}

test("reload, topic re-entry and socket reconnect re-read committed member traces", async ({ page, hub }) => {
  const fixture = await openGroup(page, { scenario: "same-bot" });
  const openFirst = async () => {
    await bubble(page, "turn_first").click();
    await expect(detail(page)).toContainText("RECORDED turn_first chunk 1");
  };
  await openFirst();
  const beforeReload = fixture.traceRequests.length;
  await page.reload();
  await expect(bubble(page, "turn_first")).toHaveAttribute("aria-expanded", "false");
  await openFirst();
  expect(fixture.traceRequests.length).toBeGreaterThan(beforeReload);
  await switchTopic(page, "topic_other");
  await expect(detail(page)).toHaveCount(0);
  await expect(bubble(page, "turn_first")).toHaveCount(0);
  const beforeSwitch = fixture.traceRequests.length;
  await switchTopic(page, scope.topicId);
  await openFirst();
  expect(fixture.traceRequests.length).toBeGreaterThan(beforeSwitch);
  const committed = fixture.events.get("turn_first")!;
  committed.push({ seq: 103, createdAt, kind: "text", payload: { text: "Durable chunk recorded during disconnect" } });
  const beforeReconnect = fixture.traceRequests.length;
  const oldSockets = new Set(hub.sockets);
  hub.closeSockets();
  await expect.poll(() => hub.sockets.some((socket) => !oldSockets.has(socket) && socket.readyState === 1), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => fixture.traceRequests.length).toBeGreaterThan(beforeReconnect);
  const more = page.getByTestId("group-trace-load-more");
  if (await more.isVisible()) await more.click();
  await expect(detail(page)).toContainText("Durable chunk recorded during disconnect");
  await expect(page.locator('[data-row-id="reply_turn_first"]')).toHaveCount(1);
  await expect(detail(page).getByTestId("group-stop-run-button")).toHaveCount(0);
});

test("an open process catches up during streaming and shows the sealed tail without reopening", async ({ page, hub }, info) => {
  const fixture = await openGroup(page, { scenario: "multi" });
  const trigger = bubble(page, fixture.liveMember.id);
  await trigger.click();
  await expect(detail(page)).toContainText("RECORDED turn_live chunk 99");
  const committed = fixture.events.get(fixture.liveMember.id)!;
  committed.push({ seq: 102, createdAt, kind: "text", payload: { text: "LIVE COMMITTED UPDATE" } });
  const conversation = { ...scope, runId: fixture.current.id, memberTurnId: fixture.liveMember.id,
    botId: fixture.liveMember.botId, attempt: fixture.liveMember.attempt };
  hub.send({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "group-test", sessionAlias: "test",
    chunk: "LIVE COMMITTED UPDATE", conversation } });
  await expect(detail(page)).toContainText("LIVE COMMITTED UPDATE");
  await expect(detail(page)).toContainText("Read turn_live.ts");
  committed.push({ seq: 103, createdAt, kind: "text", payload: { text: "SEALED FINAL UPDATE" } },
    { seq: 104, createdAt, kind: "terminal", payload: { ok: true } });
  fixture.current.state = "completed";
  const finished = { ...fixture.liveMember, state: "completed" as const, finishedAt: createdAt };
  hub.send({ kind: "control-event", instanceId: "i1", event: { type: "member-turn-finished", run: fixture.current, memberTurn: finished } });
  await expect(detail(page)).toContainText("SEALED FINAL UPDATE");
  await expect(detail(page)).toContainText("Recorded process (complete)");
  await expect(detail(page).getByTestId("group-stop-run-button")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expectInsideViewport(page);
  await screenshot(page, info, "open-process-sealed-tail");
});

test("history prepend, duplicate live messages and canonical promotion preserve the reading anchor", async ({ page, hub }, info) => {
  const fixture = await openGroup(page, { scenario: "same-bot", longHistory: true });
  const scroller = page.getByTestId("group-transcript-scroller");
  const anchor = page.locator('[data-row-id="reply_turn_first"]');
  const trigger = bubble(page, "turn_first");
  const rowAbove = page.locator('[data-row-id="request_history"]');
  // `content-visibility: auto` lays an unpainted row out at its size estimate
  // and swaps in the measured height when it paints. Render the row above the
  // reader first and let the position settle, or the baseline holds an estimate
  // the browser replaces later and the anchor looks like it moved on its own.
  await rowAbove.scrollIntoViewIfNeeded();
  await scroller.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  const offset = () => anchor.evaluate((el) => el.getBoundingClientRect().top);
  let previous = Number.NaN;
  await expect.poll(async () => {
    const current = await offset();
    const settled = current === previous;
    previous = current;
    return settled;
  }).toBe(true);
  const before = await offset();
  await trigger.click();
  await expect(detail(page)).toContainText("RECORDED turn_first chunk 1");
  await expect.poll(offset).toBeCloseTo(before, 0);
  await page.keyboard.press("Escape");
  await expect.poll(offset).toBeCloseTo(before, 0);
  await trigger.click();
  await page.getByTestId("group-load-older-button").click();
  await expect(page.locator('[data-message-id="older_0"]')).toHaveCount(1);
  await expect.poll(offset).toBeCloseTo(before, 0);
  // The prepend click is an outside pointer, so the anchored detail closes;
  // the reading position survives and the same bubble reopens it.
  await expect(detail(page)).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const canonical = message("reply_live", 73, "LIVE CANONICAL REPLY", {
    role: "bot", senderBotId: "tester", runId: fixture.current.id, promptRequestId: fixture.liveMember.promptRequestId,
  });
  fixture.messages.push(canonical);
  const delivery = { kind: "control-event" as const, instanceId: "i1", event: { type: "conversation-message" as const, message: canonical } };
  hub.send(delivery);
  hub.send(delivery);
  await expect(page.locator('[data-row-id="reply_live"]')).toHaveCount(1);
  await expect(bubble(page, "turn_live")).toHaveCount(1);
  await expect(page.locator('[data-row-id="reply_live"]').getByTestId("agent-thinking-bubble")).toHaveCount(1);
  await expect.poll(offset).toBeCloseTo(before, 0);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const ordered = await scroller.locator("[data-row-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id")));
  expect(ordered.indexOf("reply_live")).toBeGreaterThan(ordered.indexOf("tail_44"));
  await screenshot(page, info, "historical-anchor-after-live-promotion");
});
