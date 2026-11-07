import { mkdirSync, writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationRunTraceEventDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";
import type { MockHub } from "./mock-hub";

const createdAt = "2026-11-07T12:00:00.000Z";
const scope = { conversationId: "group_live_feed", topicId: "topic_live_feed" };
const bots = ["reviewer", "tester"].map((id) => ({
  id, name: id === "reviewer" ? "Reviewer" : "Tester", agent: "codex", workspace: "repo",
  enabled: true, createdAt, updatedAt: createdAt,
}));
const group = {
  id: scope.conversationId, kind: "group", title: "Live feed team",
  botIds: bots.map(({ id }) => id), leadBotId: "reviewer", createdAt, updatedAt: createdAt,
};
const topics = [{ id: scope.topicId, conversationId: scope.conversationId, title: "Implementation", status: "active", createdAt, updatedAt: createdAt }];

const liveMember: MemberTurnSummaryDto = {
  ...scope, id: "turn_live", runId: "run_live", botId: "tester", batch: 1, memberIndex: 0, attempt: 1,
  origin: "human-explicit", state: "running", promptRequestId: "prompt_live", assignmentId: "assignment_live",
  task: "Stream a long process", createdAt, startedAt: createdAt,
};

const request: ConversationMessageDto = {
  ...scope, id: "msg_request", seq: 1, role: "human", content: "Run the long process", createdAt,
};

function runOf(state: ConversationRunDetailDto["state"] = "running"): ConversationRunDetailDto {
  return {
    ...scope, id: "run_live", requestMessageId: request.id, requestId: "request_live_nonce",
    mode: "explicit", state, profileRevision: 1, createdAt, startedAt: createdAt,
    ...(state === "running" ? {} : { finishedAt: createdAt }),
    memberTurns: [{ ...liveMember, ...(state === "running" ? {} : { state, finishedAt: createdAt }) }],
  };
}

function toolEvent(seq: number, index: number): ConversationRunTraceEventDto {
  return {
    seq, createdAt, kind: "tool",
    payload: { step: {
      toolCallId: `tool-${String(index).padStart(2, "0")}`,
      toolName: "read_file", kind: "read", status: "success",
      title: `Tool ${String(index).padStart(2, "0")}`,
      detail: { type: "text", text: `output ${index}`, output: `output ${index}` },
      durationMs: 12,
    } },
  };
}

const detail = (page: Page) => page.locator('[data-test="group-detail-card"], [data-test="group-detail-sheet"]');
const liveRow = (page: Page) => page.locator('[data-test="agent-turn-row"][data-member-turn-id="turn_live"]')
  .locator('[data-test="agent-thinking-bubble"], [data-test="trace-link"]');

function scroller(page: Page, mobile: boolean) {
  return mobile
    ? page.locator('[data-test="group-detail-sheet"] .thin-scroll')
    : page.locator(".group-detail-scroll");
}

function correlation() {
  return {
    ...scope, runId: liveMember.runId, memberTurnId: liveMember.id,
    botId: liveMember.botId, attempt: liveMember.attempt,
  };
}

function triggerStep(index: number) {
  return {
    toolCallId: `live-trigger-${index}`, toolName: "read_file", kind: "read", status: "running",
    title: `Trigger ${index}`, startedAt: Date.now(),
  };
}

const PROOF_DIR = "/tmp/xacpx-trace-live-proof";

async function screenshot(page: Page, info: TestInfo, name: string) {
  mkdirSync(PROOF_DIR, { recursive: true });
  const body = await page.screenshot();
  await info.attach(name, { body, contentType: "image/png" });
  writeFileSync(`${PROOF_DIR}/${name}.png`, body);
}

async function openLiveFeed(page: Page, hub: MockHub) {
  const events: ConversationRunTraceEventDto[] = [];
  for (let index = 1; index <= 36; index++) events.push(toolEvent(index, index));
  let current = runOf();
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload = {} } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics } }; break;
      case "control.topics.list": result = { topics }; break;
      case "control.conversation.history": result = {
        ...scope, messages: [request], oldestSeq: 1, newestSeq: 1, hasMoreBefore: false, hasMoreAfter: false,
      }; break;
      case "control.runs.list": result = {
        ...scope, runs: [current],
        ...(current.state === "running" ? { activeRunId: current.id, activeRun: current } : {}),
      }; break;
      case "control.runs.get": result = { run: current }; break;
      case "control.runs.details.batch": result = {
        runs: [current].filter((run) => payload.runIds.includes(run.id)), missingRunIds: [],
      }; break;
      case "control.runs.trace.get": {
        const remaining = events.filter((event) => event.seq > (payload.afterSeq ?? 0));
        const pageEvents = remaining.slice(0, payload.limit ?? 100);
        result = {
          memberTurnId: liveMember.id, attempt: 1,
          recordingState: current.state === "running" ? "recording" : "complete",
          events: pageEvents,
          nextSeq: pageEvents.at(-1)?.seq ?? payload.afterSeq ?? 0,
          hasMore: remaining.length > pageEvents.length,
          attempts: [1],
          plan: [],
        };
        break;
      }
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
  await expect(liveRow(page)).toHaveCount(1);
  await liveRow(page).click();
  await expect(detail(page)).toBeVisible();
  const triggerRefetch = (index: number) => hub.send({
    kind: "control-event", instanceId: "i1",
    event: {
      type: "tool-event", chatKey: "group-live-feed", sessionAlias: "test",
      step: triggerStep(index), conversation: correlation(),
    },
  });
  const appendEvents = (from: number, to: number) => {
    for (let index = from; index <= to; index++) events.push(toolEvent(index, index));
  };
  return { events, triggerRefetch, appendEvents, finish: () => { current = runOf("completed"); } };
}

async function expectLiveFeed(page: Page, hub: MockHub, info: TestInfo, mobile: boolean) {
  const fixture = await openLiveFeed(page, hub);
  const detailEl = detail(page);
  const scroll = scroller(page, mobile);
  const stackRows = page.locator('[data-test="trace-live-item"]');

  await expect(detailEl).toContainText("Tool 01");
  await expect(detailEl).toContainText("Tool 36");
  await expect(detailEl.getByTestId("group-trace-step")).toHaveCount(36);
  await expect(page.getByTestId("group-trace-fold")).toHaveCount(0);

  await expect(stackRows).toHaveCount(mobile ? 2 : 3);
  await expect(stackRows.first()).toContainText("Tool 36");
  await expect(stackRows.nth(1)).toContainText("Tool 35");
  await scroll.evaluate((el) => { el.scrollTop = 900; });
  const stackDelta = await page.getByTestId("trace-live-stack").evaluate((el) => {
    const owner = el.closest(".group-detail-scroll, .thin-scroll")!;
    return el.getBoundingClientRect().top - owner.getBoundingClientRect().top;
  });
  expect(stackDelta).toBeGreaterThanOrEqual(0);
  expect(stackDelta).toBeLessThanOrEqual(40);
  await scroll.evaluate((el) => { el.scrollTop = 0; });
  await screenshot(page, info, mobile ? "mobile-live-stack" : "desktop-live-stack");

  const plainRow = detailEl.locator('[data-trace-key="tool:tool-20"]');
  expect(await plainRow.evaluate((el) => getComputedStyle(el).contentVisibility)).toBe("auto");

  await detailEl.getByTestId("group-trace-step-head").first().click();
  await expect(detailEl.getByTestId("tool-step-body").first()).toContainText("output 1");
  expect(await detailEl.locator('[data-trace-key="tool:tool-01"]').evaluate((el) => getComputedStyle(el).contentVisibility))
    .toBe("visible");
  fixture.appendEvents(37, 56);
  fixture.triggerRefetch(1);
  await expect(detailEl.getByTestId("group-trace-step")).toHaveCount(56);
  await expect(detailEl.getByTestId("tool-step-body").first()).toContainText("output 1");
  await expect(detailEl.locator('[data-trace-key="tool:tool-01"]')).toHaveAttribute("data-state", "success");
  await expect(stackRows.first()).toContainText("Tool 56");
  await screenshot(page, info, mobile ? "mobile-expanded-after-append" : "desktop-expanded-after-append");

  const newEvents = page.getByTestId("group-trace-new-events");
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(newEvents).toHaveCount(0);
  await scroll.evaluate((el) => {
    // Clear the tail by more than a viewport, otherwise the bottom is still
    // on screen and follow mode is (correctly) still active.
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 800);
    el.dispatchEvent(new Event("scroll"));
  });
  // The acceptance contract is "the reader's viewport does not move", not "the
  // scrollTop number is frozen". Under CPU load the renderer can still be
  // showing 72px intrinsic estimates for rows it has not painted; a reader only
  // ever sees rendered rows, so wait for the row under the viewport top to be
  // rendered, then track it across the append.
  await expect.poll(async () => scroll.evaluate((el) => {
    const ownerTop = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-trace-key]"))
      .find((candidate) => candidate.getBoundingClientRect().bottom > ownerTop + 80);
    if (!row) return false;
    const style = getComputedStyle(row);
    const match = /([\d.]+)px\s*$/.exec(style.containIntrinsicSize ?? "");
    if (!match) return true;
    return Math.abs(row.getBoundingClientRect().height - Number.parseFloat(match[1]!)) >= 0.5;
  })).toBe(true);
  let previous = -1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await scroll.evaluate((el) => el.scrollTop);
    if (current === previous) break;
    previous = current;
    await page.waitForTimeout(100);
  }
  const anchor = await scroll.evaluate((el) => {
    const ownerTop = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-trace-key]"))
      .find((candidate) => candidate.getBoundingClientRect().bottom > ownerTop + 80);
    return { key: row?.getAttribute("data-trace-key") ?? "", offset: row ? row.getBoundingClientRect().top - ownerTop : 0 };
  });
  expect(anchor.key).not.toBe("");
  fixture.appendEvents(57, 76);
  fixture.triggerRefetch(2);
  await expect(detailEl.getByTestId("group-trace-step")).toHaveCount(76);
  const drift = async () => Math.abs(await detailEl.locator(`[data-trace-key="${anchor.key}"]`).evaluate((el) => {
    const owner = el.closest(".group-detail-scroll, .thin-scroll")!;
    return el.getBoundingClientRect().top - owner.getBoundingClientRect().top;
  }) - anchor.offset);
  await expect.poll(drift).toBeLessThanOrEqual(1);
  console.log("FREEZE_DRIFT", mobile ? "mobile" : "desktop", await drift());
  await expect(newEvents).toBeVisible();
  await expect(newEvents).toContainText("20 new events");
  await screenshot(page, info, mobile ? "mobile-unread-chip" : "desktop-unread-chip");

  await newEvents.click();
  await expect.poll(async () => {
    const { top, height, scrollHeight } = await scroll.evaluate((el) => ({
      top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight,
    }));
    return Math.round(scrollHeight - top - height);
  }).toBeLessThanOrEqual(1);
  await expect(newEvents).toHaveCount(0);

  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(detail(page)).toHaveCount(0);
    await liveRow(page).click();
    await expect(detail(page)).toBeVisible();
    await expect(detail(page).getByTestId("tool-step-body").first()).toContainText("output 1");
  }

  fixture.appendEvents(77, 77);
  const finished = { ...liveMember, state: "completed" as const, finishedAt: createdAt };
  fixture.finish();
  hub.send({ kind: "control-event", instanceId: "i1", event: { type: "member-turn-finished", chatKey: "group-live-feed", sessionAlias: "test", run: runOf("completed"), memberTurn: finished } });
  await expect(page.getByTestId("trace-live-summary")).toContainText("Run complete");
  await expect(page.getByTestId("trace-live-item")).toHaveCount(0);
  await expect(detail(page).getByTestId("group-trace-step")).toHaveCount(77);
  await expect(detail(page).getByTestId("tool-step-body").first()).toContainText("output 1");
  await screenshot(page, info, mobile ? "mobile-terminal-summary" : "desktop-terminal-summary");
}

test("desktop drawer: full process, live stack, freeze and terminal summary", async ({ page, hub }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectLiveFeed(page, hub, info, false);
});

test("mobile sheet: two live rows, frozen viewport, expansion survives close and reopen", async ({ page, hub }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expectLiveFeed(page, hub, info, true);
});
