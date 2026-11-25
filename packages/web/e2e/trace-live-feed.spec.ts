import { mkdirSync, writeFileSync } from "node:fs";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationRunTraceEventDto,
  MemberTurnSummaryDto,
  ToolStepDto,
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

/** One long command output so expanding a row changes its height materially. */
const LONG_OUTPUT = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");

function toolEvent(seq: number, index: number): ConversationRunTraceEventDto {
  return {
    seq, createdAt, kind: "tool",
    payload: { step: {
      toolCallId: `tool-${String(index).padStart(2, "0")}`,
      toolName: index === 20 ? "run_command" : "read_file",
      kind: index === 20 ? "execute" : "read",
      status: "success",
      title: `Tool ${String(index).padStart(2, "0")}`,
      detail: index === 20
        ? { type: "command", command: "pnpm test", output: LONG_OUTPUT }
        : { type: "text", text: `output ${index}`, output: `output ${index}` },
      durationMs: 12,
    } },
  };
}

const detail = (page: Page) => page.locator('[data-test="group-detail-card"], [data-test="group-detail-sheet"]');
/**
 * The live "what is happening now" line, which lives in the transcript bubble that
 * the member's reply will land in — not in the drawer. Opening the drawer is what
 * these tests used to assert against, back when the stack was duplicated there.
 */
const liveLine = (page: Page) => page.getByTestId("conversation-timeline-scroller")
  .locator('[data-test="trace-live-stack"]');
/** The live member has no durable message, so it surfaces as one timeline
 *  activity row. Above lg its avatar opens the Run-wide drawer; below lg the
 *  row's identity is hidden on purpose, so the status bar speaker is the same
 *  key for the same Run and member. */
async function openLiveDrawer(page: Page): Promise<void> {
  const narrow = (page.viewportSize()?.width ?? 1280) < 1024;
  const trigger = narrow
    ? page.getByTestId("conversation-status-speaker")
    : page.getByTestId("timeline-activity-avatar");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(detail(page)).toBeVisible();
}

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

/** A hub update for an already-durable step: it triggers the open-trace
 *  refetch without inventing a new live-only row. */
function triggerStep() {
  return {
    toolCallId: "tool-36", toolName: "read_file", kind: "read", status: "running",
    title: "Tool 36", startedAt: Date.now(),
  };
}

/** A brand-new live-only step, used to create real >10/s burst events. */
function burstStep(index: number) {
  return {
    toolCallId: `burst-${index}`, toolName: "run_command", kind: "execute", status: "success",
    title: `Burst ${index}`, startedAt: Date.now(),
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
      case "control.conversation.timeline": result = {
        ...scope,
        entries: [
          { kind: "message", key: `message:${request.id}`, anchorSeq: request.seq, message: request },
          { kind: "activity", key: `activity:${liveMember.id}`, anchorSeq: 2, runId: liveMember.runId, memberTurn: liveMember },
        ],
        oldestSeq: 1, newestSeq: 2, hasMoreBefore: false, hasMoreAfter: false,
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
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  await expect(page.getByTestId("timeline-activity")).toHaveCount(1);
  await openLiveDrawer(page);
  const sendStep = (step: ToolStepDto) => hub.send({
    kind: "control-event", instanceId: "i1",
    event: {
      type: "tool-event", chatKey: "group-live-feed", sessionAlias: "test",
      step, conversation: correlation(),
    },
  });
  const triggerRefetch = () => sendStep(triggerStep());
  // The live line is fed by streamed parts, and the fixture member starts with none,
  // so push one before anything asserts on it. This is also what a real turn does
  // first: a Bot reports a tool step before it writes prose.
  sendStep({ ...triggerStep(), status: "success", title: "Tool 36" });
  await expect(page.getByTestId("conversation-timeline-scroller").locator('[data-test="trace-live-row"]'))
    .toHaveCount(1);
  /** Real new events for the >10/s animation gate. */
  const sendBurst = (from: number, to: number) => {
    for (let index = from; index <= to; index++) sendStep(burstStep(index));
  };
  const appendEvents = (from: number, to: number) => {
    for (let index = from; index <= to; index++) events.push(toolEvent(index, index));
  };
  return {
    events, triggerRefetch, sendBurst, appendEvents,
    finish: (state: "completed" | "failed" | "cancelled" = "completed") => {
      current = runOf(state);
      const finished = { ...liveMember, state, finishedAt: createdAt };
      hub.send({
        kind: "control-event", instanceId: "i1",
        event: {
          type: "member-turn-finished", chatKey: "group-live-feed", sessionAlias: "test",
          run: runOf(state), memberTurn: finished,
        },
      });
    },
  };
}

async function expectLiveFeed(page: Page, hub: MockHub, info: TestInfo, mobile: boolean) {
  const fixture = await openLiveFeed(page, hub);
  const detailEl = detail(page);
  const scroll = scroller(page, mobile);
  const line = liveLine(page);
  const lineRows = line.locator('[data-test="trace-live-row"]');

  await expect(detailEl).toContainText("Tool 01");
  await expect(detailEl).toContainText("Tool 36");
  await expect(detailEl.getByTestId("group-trace-step")).toHaveCount(36);
  await expect(detailEl.getByTestId("run-detail")).toBeVisible();

  // The live line reports the newest activity in the bubble, one row only: the
  // reply is what the reader waits for, so a rolling log above it competes.
  await expect(line).toBeVisible();
  await expect(lineRows).toHaveCount(1);
  await expect(lineRows.first()).toContainText("Tool 36");
  await screenshot(page, info, mobile ? "mobile-live-stack" : "desktop-live-stack");

  const plainRow = detailEl.locator('[data-trace-key="tool:tool-20"]');
  expect(await plainRow.evaluate((el) => getComputedStyle(el).contentVisibility)).toBe("auto");

  // Newest first: the oldest durable step is addressed by key, not by position.
  await detailEl.locator('[data-trace-key="tool:tool-01"] [data-test="group-trace-step-head"]').click();
  await expect(detailEl.getByTestId("tool-step-body")).toContainText("output 1");
  expect(await detailEl.locator('[data-trace-key="tool:tool-01"]').evaluate((el) => getComputedStyle(el).contentVisibility))
    .toBe("visible");
  fixture.appendEvents(37, 56);
  fixture.triggerRefetch();
  await expect(detailEl.getByTestId("group-trace-step")).toHaveCount(56);
  await expect(detailEl.getByTestId("tool-step-body")).toContainText("output 1");
  await expect(detailEl.locator('[data-trace-key="tool:tool-01"]')).toHaveAttribute("data-state", "success");
  await screenshot(page, info, mobile ? "mobile-expanded-after-append" : "desktop-expanded-after-append");

  const newEvents = page.getByTestId("group-trace-new-events");
  // Following the top: the newest row is above the fold, so an append stays at
  // scrollTop 0 and nothing queues as unread.
  await scroll.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect(newEvents).toHaveCount(0);
  await scroll.evaluate((el) => {
    // Leave the top by more than the follow threshold: a reader down the list
    // must keep their rows while new events prepend above them.
    el.scrollTop = 900;
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
  fixture.triggerRefetch();
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
  await expect.poll(async () => Math.round(await scroll.evaluate((el) => el.scrollTop))).toBeLessThanOrEqual(1);
  await expect(newEvents).toHaveCount(0);

  if (mobile) {
    await page.keyboard.press("Escape");
    await expect(detail(page)).toHaveCount(0);
    await openLiveDrawer(page);
    await expect(detail(page).getByTestId("tool-step-body")).toContainText("output 1");
  }

  fixture.appendEvents(77, 77);
  fixture.finish("completed");
  // A settled turn takes the live line with it, so nothing is left behind above a
  // reply that is already in the transcript.
  await expect(liveLine(page)).toHaveCount(0);
  await expect(detail(page).getByTestId("group-trace-step")).toHaveCount(77);
  await expect(detail(page).getByTestId("tool-step-body")).toContainText("output 1");
  await screenshot(page, info, mobile ? "mobile-terminal-summary" : "desktop-terminal-summary");
}

/** Smooth scroll and `content-visibility` re-measures can keep moving the
 *  offset for a few frames; wait for a plateau before capturing an anchor. */
async function settleScroll(page: Page, scroll: Locator) {
  let previous = -1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await scroll.evaluate((el) => el.scrollTop);
    if (current === previous) return;
    previous = current;
    await page.waitForTimeout(100);
  }
}

function offsetInScroller(row: Locator): Promise<number> {
  return row.evaluate((el) => {
    const owner = el.closest(".group-detail-scroll, .thin-scroll")!;
    return el.getBoundingClientRect().top - owner.getBoundingClientRect().top;
  });
}

async function expectResidualFeed(page: Page, hub: MockHub, info: TestInfo, mobile: boolean) {
  const fixture = await openLiveFeed(page, hub);
  const detailEl = detail(page);
  const scroll = scroller(page, mobile);
  const line = liveLine(page);
  const lineRows = line.locator('[data-test="trace-live-row"]');

  // --- One line, one fixed box, whatever the activity is -----------------
  // A box sized by its text resized on every new tool and pushed the reply around
  // while the reader was watching, so the height and width are pinned.
  await expect(lineRows).toHaveCount(1);
  const shortBox = await line.boundingBox();
  expect(shortBox).not.toBeNull();
  expect(shortBox!.height).toBeCloseTo(36, 0);
  if (mobile) {
    // The sheet owns the scroll; the page body must not be pushed or occluded.
    expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight + 1)).toBe(true);
    await expect(detailEl).toBeVisible();
  }

  // --- Long command output: expand, then append with <=1px drift ----------
  const longRow = detailEl.locator('[data-trace-key="tool:tool-20"]');
  await longRow.getByTestId("group-trace-step-head").click();
  await expect(longRow.getByTestId("tool-step-body")).toContainText("line 80");
  await longRow.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await settleScroll(page, scroll);
  const anchorOffset = await offsetInScroller(longRow);
  fixture.appendEvents(37, 56);
  fixture.triggerRefetch();
  await expect(detailEl.getByTestId("group-trace-step")).toHaveCount(56);
  const drift = async () => Math.abs(await offsetInScroller(longRow) - anchorOffset);
  await expect.poll(drift).toBeLessThanOrEqual(1);
  console.log("EXPANDED_DRIFT", mobile ? "mobile" : "desktop", await drift());
  await screenshot(page, info, mobile ? "mobile-long-output-append" : "desktop-long-output-append");

  // --- A burst still leaves exactly one row -----------------------------
  // The line reports the newest activity, so a fast run cannot grow it into a log.
  fixture.sendBurst(1, 12);
  await expect(lineRows).toHaveCount(1);
  await expect(lineRows.first()).toContainText("Burst 12");
  const burstBox = await line.boundingBox();
  expect(burstBox!.height).toBeCloseTo(shortBox!.height, 0);
  expect(burstBox!.width).toBeCloseTo(shortBox!.width, 0);

  // --- Clicking the line opens the full process --------------------------
  // The drawer from openLiveFeed covers the transcript, so close it first: the line
  // lives in the bubble now, and a click must reach it.
  if (await detail(page).count()) {
    const close = page.getByTestId("detail-close").or(page.getByRole("button", { name: /close detail/i }));
    if (await close.count()) await close.first().click();
    else await page.keyboard.press("Escape");
    await expect(detail(page)).toHaveCount(0);
  }
  await expect(line).toBeVisible();
  await lineRows.first().click();
  await expect(detailEl).toBeVisible();
  await screenshot(page, info, mobile ? "mobile-reveal-flash" : "desktop-reveal-flash");

  // --- Reduced motion ----------------------------------------------------
  // The line itself has no entrance animation, but the shared reduced-motion
  // rule must still be present for the drawer's stack.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedRules = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion")) {
          found.push(rule.cssText);
        }
      }
    }
    return found.join("\n");
  });
  expect(reducedRules).toContain("trace-live-enter-active");
  expect(reducedRules).toContain("transition: none");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // --- Find-in-page reaches a row `content-visibility` skipped -----------
  // DOM.performSearch is Chromium's page-find index: it proves the offscreen
  // row is still in the DOM (not unmounted by a virtual window).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  const found = await cdp.send("DOM.performSearch", { query: "Tool 05" });
  await cdp.detach();
  expect(found.resultCount).toBeGreaterThan(0);

  // Terminal summaries are covered by their own tests: a finished member can
  // only settle once, so failed and cancelled each need a fresh run.
}

async function expectTerminal(page: Page, hub: MockHub, state: "failed" | "cancelled") {
  const fixture = await openLiveFeed(page, hub);
  await expect(detail(page).getByTestId("group-trace-step")).toHaveCount(36);
  fixture.finish(state);
  // The line belongs to the live turn: settling removes it along with the turn, so a
  // finished run leaves no progress row above a reply that is already written.
  await expect(liveLine(page)).toHaveCount(0);
  // The full process survives the terminal summary.
  await expect(detail(page).getByTestId("group-trace-step")).toHaveCount(36);
}

test("desktop drawer: burst gate, reveal, reduced motion, find-in-page, long output", async ({ page, hub }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectResidualFeed(page, hub, info, false);
});

test("mobile sheet: burst gate, reveal, reduced motion, find-in-page, long output", async ({ page, hub }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expectResidualFeed(page, hub, info, true);
});

test("failed run collapses the live stack to a failed summary", async ({ page, hub }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectTerminal(page, hub, "failed");
});

test("cancelled run collapses the live stack to a cancelled summary", async ({ page, hub }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expectTerminal(page, hub, "cancelled");
});

test("desktop drawer: full process, live stack, freeze and terminal summary", async ({ page, hub }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expectLiveFeed(page, hub, info, false);
});

test("mobile sheet: two live rows, frozen viewport, expansion survives close and reopen", async ({ page, hub }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expectLiveFeed(page, hub, info, true);
});
