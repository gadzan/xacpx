import type { Page, TestInfo } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationRunTraceEventDto,
  ConversationTimelineDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * The Run-wide drawer's containment and per-member trace, end to end. Every
 * assertion runs on both Playwright projects, so the desktop overlay and the
 * mobile sheet are held to the same geometry and the same paged trace.
 */

const createdAt = "2026-11-08T00:00:00.000Z";
const scope = { conversationId: "group_trace", topicId: "topic_trace" };
const bots = [
  { id: "lead", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "reviewer", name: "Bob", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = {
  id: scope.conversationId,
  kind: "group",
  title: "Trace team",
  botIds: bots.map((bot) => bot.id),
  leadBotId: "lead",
  createdAt,
  updatedAt: createdAt,
};
const topic = {
  id: scope.topicId,
  conversationId: scope.conversationId,
  title: "Trace review",
  status: "active",
  createdAt,
  updatedAt: createdAt,
};

function member(id: string, botId: string, index: number): MemberTurnSummaryDto {
  return {
    ...scope,
    id,
    runId: "run_trace",
    botId,
    batch: 1,
    memberIndex: index,
    attempt: 1,
    origin: "handoff",
    state: "completed",
    createdAt,
    finishedAt: createdAt,
  };
}
const turns = [member("turn_lead", "lead", 0), member("turn_reviewer", "reviewer", 1)];

const request: ConversationMessageDto = {
  ...scope, id: "msg_request", seq: 1, role: "human", content: "Review the release", createdAt,
};
function reply(id: string, seq: number, turn: MemberTurnSummaryDto, content: string): ConversationMessageDto {
  return {
    ...scope, id, seq, runId: "run_trace", role: "bot",
    senderBotId: turn.botId, memberTurnId: turn.id, content, createdAt,
  };
}
const leadReply = reply("msg_lead", 2, turns[0]!, "Lead findings");
const reviewerReply = reply("msg_reviewer", 3, turns[1]!, "Reviewer findings");

const run: ConversationRunDetailDto = {
  ...scope,
  id: "run_trace",
  requestMessageId: request.id,
  requestId: "req_trace",
  mode: "explicit",
  state: "completed",
  profileRevision: 1,
  createdAt,
  startedAt: createdAt,
  finishedAt: createdAt,
  memberTurns: turns,
};

/** 130 paged tool steps for the Lead, 3 for the Reviewer: paging and
 *  isolation are both observable from a single drawer. */
function trace(turnId: string, count: number, label: string): ConversationRunTraceEventDto[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    createdAt,
    kind: "tool" as const,
    payload: {
      step: {
        toolCallId: `tool_${turnId}_${index + 1}`,
        toolName: "read_file",
        kind: "read" as const,
        status: "success" as const,
        title: `${label} ${index + 1}`,
        durationMs: 5,
      },
    },
  }));
}
const traces: Record<string, ConversationRunTraceEventDto[]> = {
  turn_lead: trace("turn_lead", 130, "Lead step"),
  turn_reviewer: trace("turn_reviewer", 3, "Reviewer step"),
};

function timeline(): ConversationTimelineDto {
  const entry = (message: ConversationMessageDto, turn: MemberTurnSummaryDto) => ({
    kind: "message" as const,
    key: `message:${message.id}`,
    anchorSeq: message.seq,
    runId: message.runId,
    memberTurnId: turn.id,
    ownership: "exact" as const,
    message,
  });
  return {
    ...scope,
    entries: [
      { kind: "message", key: `message:${request.id}`, anchorSeq: request.seq, message: request },
      entry(leadReply, turns[0]!),
      entry(reviewerReply, turns[1]!),
    ],
    oldestSeq: 1,
    newestSeq: 3,
    hasMoreBefore: false,
    hasMoreAfter: false,
  } as ConversationTimelineDto;
}

const drawer = (page: Page) => page.locator('[data-test="group-detail-card"], [data-test="group-detail-sheet"]');

async function openTimeline(page: Page, hub: { port: number }): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });
  await page.route("**/api/instances", async (route) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/instances`);
    const body = await response.json() as { instances: Array<{ capabilities?: string[] }> };
    for (const instance of body.instances) {
      instance.capabilities = [...new Set([...(instance.capabilities ?? []), RELAY_CAPABILITIES.conversationTimelineV1])];
    }
    await route.fulfill({ json: body });
  });
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload = {} } = route.request().postDataJSON() as { type: string; payload?: Record<string, unknown> };
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.agents.list": result = { agents: [{ name: "codex", driver: "codex" }] }; break;
      case "control.workspaces.list": result = { workspaces: [{ name: "repo", cwd: "/repo" }] }; break;
      case "control.agents.catalog": result = { agents: [] }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": result = {
        ...scope, messages: [request, leadReply, reviewerReply],
        oldestSeq: 1, newestSeq: 3, hasMoreBefore: false, hasMoreAfter: false,
      }; break;
      case "control.conversation.timeline": result = timeline(); break;
      case "control.runs.list": result = { ...scope, runs: [run], activeRunId: run.id, activeRun: run }; break;
      case "control.runs.get": result = { run }; break;
      case "control.runs.details.batch": result = { runs: [run], missingRunIds: [] }; break;
      case "control.runs.trace.get": {
        const all = traces[String(payload.memberTurnId)] ?? [];
        const after = typeof payload.afterSeq === "number" ? payload.afterSeq : 0;
        const limit = typeof payload.limit === "number" ? payload.limit : 100;
        const pageEvents = all.filter((event) => event.seq > after).slice(0, limit);
        result = {
          memberTurnId: payload.memberTurnId,
          attempt: 1,
          recordingState: "complete",
          events: pageEvents,
          nextSeq: pageEvents.at(-1)?.seq ?? after,
          hasMore: all.length > after + pageEvents.length,
          attempts: [1],
          plan: [],
        };
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
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

async function expectInsideViewport(page: Page) {
  const card = drawer(page);
  await expect(card).toBeVisible();
  await expect.poll(async () => card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= -1 && box.top >= -1
      && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1;
  })).toBe(true);
  expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

test("the drawer stays inside every viewport it can open in", async ({ page, hub }, info) => {
  await openTimeline(page, hub);
  const viewports = [
    { width: 1280, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const trigger = page.getByTestId("timeline-open-detail").first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await expectInsideViewport(page);
    await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
    await screenshot(page, info, `drawer-${viewport.width}x${viewport.height}`);
    await drawer(page).getByTestId("group-detail-close").click();
    await expect(drawer(page)).toHaveCount(0);
  }
});

test("Escape closes the drawer and returns focus to the timeline trigger", async ({ page, hub }) => {
  await openTimeline(page, hub);
  const trigger = page.getByTestId("timeline-open-detail").first();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("each member's trace pages on its own, and switching members swaps it", async ({ page, hub }) => {
  await openTimeline(page, hub);
  await page.getByTestId("timeline-open-detail").first().click();
  const surface = drawer(page);
  await expect(surface.getByTestId("run-selected-member")).toHaveAttribute("data-member-turn-id", "turn_lead");
  await expect(surface.getByTestId("group-trace-step")).toHaveCount(100);
  await expect(surface).toContainText("Lead step 1");
  await expect(surface).not.toContainText("Reviewer step 1");

  // The second page appends to the same member trace, never to a sibling's.
  await surface.getByTestId("group-trace-load-more").click();
  await expect(surface.getByTestId("group-trace-step")).toHaveCount(130);
  await expect(surface).toContainText("Lead step 130");
  await expect(surface).not.toContainText("Reviewer step 1");

  await surface.getByTestId("run-member-row").filter({ hasText: "Bob" }).click();
  await expect(surface.getByTestId("run-selected-member")).toHaveAttribute("data-member-turn-id", "turn_reviewer");
  await expect(surface.getByTestId("group-trace-step")).toHaveCount(3);
  await expect(surface).toContainText("Reviewer step 3");
  await expect(surface).not.toContainText("Lead step 1");
});
