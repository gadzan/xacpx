import type { Page } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
  MemberTurnSummaryDto,
  TopicSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * Direct Topic fork end to end (design §4.5). The Direct Topic menu is the
 * entry; the shared fork dialog submits exactly one
 * `control.direct.topics.fork` with the ids it minted, and the new Topic opens
 * with a handoff banner that names the source and the carried count.
 *
 * Both Playwright projects run the same assertions; only the menu surface
 * (popover vs sheet) differs, and the mobile project also proves the dialog
 * fits a Pixel 7 viewport.
 *
 * The RPC is stubbed per page because the fork answer is spec-local state: it
 * must upsert a Topic and seed its handoff history, which the shared mock hub
 * cannot narrate without growing a second fake core.
 */

const createdAt = "2026-11-11T00:00:00.000Z";
const conversationId = "conversation_direct";
const sourceTopicId = "topic_source";
const sourceTitle = "Release";
const runId = "run_settled";

const bot = {
  id: "b1",
  name: "Direct Bot",
  agent: "codex",
  workspace: "repo",
  enabled: true,
  profileRevision: 1,
  createdAt,
  updatedAt: createdAt,
};

function topic(id: string, title: string, patch: Partial<TopicSummaryDto> = {}): TopicSummaryDto {
  return { id, conversationId, title, status: "active", createdAt, updatedAt: createdAt, ...patch };
}

const sourceTopic = topic(sourceTopicId, sourceTitle);

const requestMessage: ConversationMessageDto = {
  conversationId,
  topicId: sourceTopicId,
  id: "message_request",
  seq: 1,
  role: "human",
  content: "Ship the release",
  createdAt,
};
const replyMessage: ConversationMessageDto = {
  conversationId,
  topicId: sourceTopicId,
  id: "message_reply",
  seq: 2,
  runId,
  memberTurnId: "turn_1",
  role: "bot",
  senderBotId: bot.id,
  content: "Release triaged",
  createdAt,
};

const memberTurn: MemberTurnSummaryDto = {
  conversationId,
  topicId: sourceTopicId,
  id: "turn_1",
  runId,
  botId: bot.id,
  batch: 1,
  memberIndex: 0,
  attempt: 1,
  origin: "human-explicit",
  state: "completed",
  createdAt,
};

const run: ConversationRunDetailDto = {
  conversationId,
  topicId: sourceTopicId,
  id: runId,
  requestMessageId: requestMessage.id,
  requestId: "request_1",
  mode: "explicit",
  shape: "single",
  state: "completed",
  profileRevision: 1,
  createdAt,
  memberTurns: [memberTurn],
};

interface ForkReply {
  /** Error code the core would answer instead of a Topic. */
  code?: string;
  topic?: TopicSummaryDto;
  /** Rows the fork has after its own first turn; a fresh fork starts with none. */
  seeded?: ConversationMessageDto[];
}

interface Harness {
  topics: TopicSummaryDto[];
  messages: Record<string, ConversationMessageDto[]>;
  /** Topic ids the pane asked history for, in call order. */
  historyTopicIds: string[];
  /** Every `control.direct.topics.fork` payload, in call order. */
  forkRequests: Array<Record<string, unknown>>;
  /** Every `control.group.topics.fork` payload: a Direct fork must never use it. */
  groupForkRequests: Array<Record<string, unknown>>;
  /** Queued answers: one is consumed per fork call. */
  forkReplies: ForkReply[];
}

function entriesOf(messages: ConversationMessageDto[]): ConversationTimelineEntryDto[] {
  return messages.map((message) => ({
    kind: "message",
    key: `message:${message.id}`,
    anchorSeq: message.seq,
    ownership: "exact",
    message,
    ...(message.runId ? { runId: message.runId } : {}),
    ...(message.memberTurnId ? { memberTurnId: message.memberTurnId } : {}),
  }));
}

function timelineOf(harness: Harness, topicId: string): ConversationTimelineDto {
  const messages = harness.messages[topicId] ?? [];
  return {
    conversationId,
    topicId,
    entries: entriesOf(messages),
    oldestSeq: messages[0]?.seq,
    newestSeq: messages.at(-1)?.seq,
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
}

async function openDirect(
  page: Page,
  hub: { port: number },
  replies: ForkReply[],
  capabilities: string[] = [RELAY_CAPABILITIES.directTopicForkV1, RELAY_CAPABILITIES.directTopicForkMessageV1],
): Promise<Harness> {
  const harness: Harness = {
    topics: [sourceTopic],
    messages: { [sourceTopicId]: [requestMessage, replyMessage] },
    historyTopicIds: [],
    forkRequests: [],
    groupForkRequests: [],
    forkReplies: replies,
  };

  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });

  // The instance advertises the Direct fork capability on top of whatever the
  // mock hub already serves. Without it the entry must stay hidden entirely.
  await page.route("**/api/instances", async (route) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/instances`);
    const body = await response.json() as { instances: Array<{ capabilities?: string[] }> };
    for (const instance of body.instances) {
      instance.capabilities = [...new Set([
        ...(instance.capabilities ?? []),
        RELAY_CAPABILITIES.conversationTimelineV1,
        ...capabilities,
      ])];
    }
    await route.fulfill({ json: body });
  });

  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload = {} } = route.request().postDataJSON() as {
      type: string;
      payload?: Record<string, unknown>;
    };
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots: [bot] }; break;
      case "control.bots.get": result = { bot }; break;
      case "control.agents.list": result = { agents: [{ name: "codex", driver: "codex" }] }; break;
      case "control.workspaces.list": result = { workspaces: [{ name: "repo", cwd: "/repo" }] }; break;
      case "control.agents.catalog": result = { agents: [] }; break;
      case "control.conversations.list": result = {
        conversations: [{
          id: conversationId,
          kind: "bot",
          title: bot.name,
          botIds: [bot.id],
          defaultTopicId: sourceTopicId,
          createdAt,
          updatedAt: createdAt,
        }],
      }; break;
      case "control.topics.list": result = { topics: harness.topics }; break;
      case "control.conversation.history": {
        const topicId = String(payload.topicId);
        harness.historyTopicIds.push(topicId);
        const messages = harness.messages[topicId] ?? [];
        result = {
          conversationId,
          topicId,
          messages,
          oldestSeq: messages[0]?.seq,
          newestSeq: messages.at(-1)?.seq,
          hasMoreBefore: false,
          hasMoreAfter: false,
        };
        break;
      }
      case "control.conversation.timeline": result = timelineOf(harness, String(payload.topicId)); break;
      case "control.runs.list": result = { conversationId, topicId: sourceTopicId, runs: [run] }; break;
      case "control.runs.get": result = { run }; break;
      case "control.runs.details.batch": result = {
        runs: [run].filter((candidate) => (payload.runIds as string[]).includes(candidate.id)),
        missingRunIds: [],
      }; break;
      case "control.runs.trace.get": result = {
        memberTurnId: payload.memberTurnId,
        attempt: 1,
        recordingState: "complete",
        events: [],
        nextSeq: 0,
        hasMore: false,
        attempts: [1],
        plan: [],
      }; break;
      case "control.group.topics.fork": {
        harness.groupForkRequests.push(payload as Record<string, unknown>);
        result = { error: { code: "wrong-rpc", message: "a Direct fork must use the Direct RPC" } };
        break;
      }
      case "control.direct.topics.fork": {
        const input = payload as Record<string, unknown>;
        harness.forkRequests.push(input);
        const reply = harness.forkReplies.shift();
        if (!reply) {
          result = { error: { code: "unexpected-fork", message: "the spec queued no fork answer" } };
          break;
        }
        if (reply.code) {
          result = { error: { code: reply.code, message: reply.code } };
          break;
        }
        const forkTopic = reply.topic as TopicSummaryDto;
        harness.topics = [...harness.topics, forkTopic];
        // A Direct fork copies no rows: the target starts empty and its history
        // reaches the model through the one-time prompt handoff. `seeded` stands
        // in for the rows that exist after the fork's own first turn.
        harness.messages[forkTopic.id] = reply.seeded ? [...reply.seeded] : [];
        result = { topic: forkTopic };
        break;
      }
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });

  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  return harness;
}

/**
 * Open the Direct Topic switcher and return its row menu trigger for the
 * source Topic. The mobile project has no visible switcher: the pill is parked
 * offscreen and the ⋯ sheet's topic row is the only entry, so the two surfaces
 * are opened differently while the rest of the flow is identical.
 */
async function openTopicSwitcher(page: Page, projectName: string): Promise<void> {
  if (projectName.includes("mobile")) {
    await page.getByTestId("mobile-bot-more").click();
    await page.getByTestId("mobile-bot-more-sheet").getByTestId("sheet-bot-topic").click();
  } else {
    await page.getByTestId("topic-menu").first().click();
  }
}

async function openForkFromTopicMenu(page: Page, projectName: string): Promise<void> {
  await openTopicSwitcher(page, projectName);
  const row = page.locator(`[data-test="topic-row"][data-topic-id="${sourceTopicId}"]`);
  await row.getByTestId("topic-row-more").click();
  await page.getByTestId("menu-fork").click();
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
}

function forkedTopic(input: {
  id: string;
  requestId: string;
  carried: number;
  omitted?: number;
  /** Set by a message boundary; never together with a Run id. */
  sourceMessageId?: string;
  throughSeq?: number;
}): TopicSummaryDto {
  return topic(input.id, "Release fork", {
    forkedFrom: {
      requestId: input.requestId,
      sourceConversationId: conversationId,
      sourceTopicId,
      sourceTitle,
      mode: "handoff",
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      throughSeq: input.throughSeq ?? 2,
      rootTopicId: sourceTopicId,
      copiedMessages: input.carried,
      omittedMessages: input.omitted ?? 0,
      createdAt,
    },
  });
}

test("the Direct Topic menu forks with a handoff and opens the new Topic with its banner", async ({ page, hub }, info) => {
  const harness = await openDirect(page, hub, [
    { topic: forkedTopic({ id: "topic_forked", requestId: "request_fork", carried: 2 }) },
  ]);
  await openForkFromTopicMenu(page, info.project.name);
  await page.screenshot({ path: "test-results/direct-fork-topic-menu.png" });
  // A Direct fork carries the boundary as one prompt block, so the dialog must
  // describe that instead of promising a copied timeline.
  await expect(page.getByTestId("fork-topic-hint")).toContainText("one block of background context");
  await page.getByTestId("fork-topic-submit").click();

  await expect.poll(() => harness.forkRequests.length).toBe(1);
  const input = harness.forkRequests[0]!;
  expect(input.conversationId).toBe(conversationId);
  expect(input.sourceTopicId).toBe(sourceTopicId);
  expect(input.sourcePoint).toEqual({ type: "latest_stable" });
  expect(input.targetTopicId).toMatch(/^topic_[0-9a-f-]{36}$/);
  expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);
  // The Group RPC is a different capability: a Direct fork must never use it.
  expect(harness.groupForkRequests).toHaveLength(0);

  // The dialog closes only after the store switched to the returned Topic.
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  await expect(page.getByTestId("topic-fork-banner")).toBeVisible();
  await expect(page.getByTestId("topic-fork-banner-title")).toContainText(`Forked from ${sourceTitle}`);
  // A handoff carries history instead of copying rows, so the banner says so.
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("2 messages carried");
  await expect(page.getByTestId("topic-fork-banner-count")).not.toContainText("copied");
  await expect(page.getByTestId("topic-fork-banner-omitted")).toHaveCount(0);
  // No copied rows: the target timeline is empty, unlike a Group fork.
  await expect(page.getByTestId("timeline-bot-message")).toHaveCount(0);
  expect(harness.messages.topic_forked).toEqual([]);
  expect(harness.historyTopicIds).toContain("topic_forked");

  // The source link is real: it switches back to the source Topic.
  await page.getByTestId("topic-fork-banner-source").click();
  await expect.poll(() => harness.historyTopicIds.at(-1)).toBe(sourceTopicId);
  await expect(page.getByTestId("topic-fork-banner")).toHaveCount(0);
});

test("the run-level entry forks at the exact settled run id", async ({ page, hub }) => {
  const harness = await openDirect(page, hub, [
    { topic: forkedTopic({ id: "topic_from_run", requestId: "request_run", carried: 2 }) },
  ]);
  await page.getByTestId("conversation-timeline-scroller").getByTestId("timeline-open-detail").click();
  await page.getByTestId("group-fork-run-button").click();
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
  await page.getByTestId("fork-topic-submit").click();

  await expect.poll(() => harness.forkRequests.length).toBe(1);
  expect(harness.forkRequests[0]!.sourcePoint).toEqual({ type: "run", runId });
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  await expect(page.getByTestId("topic-fork-banner-title")).toContainText(`Forked from ${sourceTitle}`);
});

test("a missing-history answer names the start-over and the next click forks with fresh ids", async ({ page, hub }, info) => {
  const harness = await openDirect(page, hub, [
    { code: "topic_fork_history_missing" },
    { topic: forkedTopic({ id: "topic_retried", requestId: "request_retry", carried: 2, omitted: 3 }) },
  ]);
  await openForkFromTopicMenu(page, info.project.name);
  await page.getByTestId("fork-topic-submit").click();
  await expect.poll(() => harness.forkRequests.length).toBe(1);
  await expect(page.getByTestId("fork-topic-error")).toContainText("Click Fork again to start over");
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
  const first = harness.forkRequests[0]!;

  await page.getByTestId("fork-topic-submit").click();
  await expect.poll(() => harness.forkRequests.length).toBe(2);
  const second = harness.forkRequests[1]!;
  // Orphan handoff rows are unrecoverable under the same ids: the retry must
  // start over with a new target and request id.
  expect(second.targetTopicId).not.toBe(first.targetTopicId);
  expect(second.requestId).not.toBe(first.requestId);
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("2 messages carried");
  await expect(page.getByTestId("topic-fork-banner-omitted")).toContainText("3 older messages omitted");
});

test("the dialog fits the viewport on the mobile project", async ({ page, hub }, info) => {
  test.skip(!info.project.name.includes("mobile"), "mobile-only layout assertion");
  const harness = await openDirect(page, hub, [
    {
      topic: forkedTopic({ id: "topic_mobile", requestId: "request_mobile", carried: 2 }),
      seeded: [{
        conversationId,
        topicId: "topic_mobile",
        id: "message_first",
        seq: 1,
        role: "human",
        content: "First prompt after the fork",
        createdAt,
      }],
    },
  ]);
  await openForkFromTopicMenu(page, info.project.name);
  const dialog = page.getByTestId("fork-topic-dialog");
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  // The dialog must fit the phone: its own padding plus the sheet chrome must
  // never push it past the viewport.
  expect(box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.height).toBeLessThanOrEqual(viewport!.height);
  await page.getByTestId("fork-topic-submit").click();
  await expect.poll(() => harness.forkRequests.length).toBe(1);
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("2 messages carried");
  // The mobile identity bar floats over the timeline, so the banner must be
  // pushed below it or the avatar disc covers "Forked from …" and the count.
  const banner = await page.getByTestId("topic-fork-banner").boundingBox();
  expect(banner).not.toBeNull();
  expect(banner!.y).toBeGreaterThanOrEqual(88);
  // The banner already pays that offset, so the scroller must not pay it again:
  // the first row starts right under the banner instead of after a dead band.
  await expect(page.locator("[data-row-key]").first()).toBeVisible();
  const row = await page.locator("[data-row-key]").first().boundingBox();
  expect(row).not.toBeNull();
  expect(Math.abs(row!.y - (banner!.y + banner!.height))).toBeLessThanOrEqual(8);
});

test("a message row's fork control cuts the Direct handoff at that row", async ({ page, hub }) => {
  const harness = await openDirect(page, hub, [
    {
      topic: forkedTopic({
        id: "topic_at_message",
        requestId: "request_at_message",
        carried: 1,
        sourceMessageId: requestMessage.id,
        throughSeq: 1,
      }),
    },
  ]);
  const row = page.getByTestId("conversation-timeline-scroller")
    .locator(`[data-row-key="message:${requestMessage.id}"]`);
  await row.hover();
  await row.getByTestId("timeline-fork-message").click();
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
  await expect(page.getByTestId("fork-topic-point")).toContainText("Fork point: this message");
  // The boundary kind does not change how a Direct fork arrives: still one
  // prompt block, never a copied timeline.
  await expect(page.getByTestId("fork-topic-hint")).toContainText("one block of background context");
  await page.getByTestId("fork-topic-submit").click();

  await expect.poll(() => harness.forkRequests.length).toBe(1);
  expect(harness.forkRequests[0]!.sourcePoint).toEqual({ type: "message", messageId: requestMessage.id });
  expect(harness.groupForkRequests).toHaveLength(0);
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("1 messages carried");
});

test("a core without the Direct fork capability offers no fork entry", async ({ page, hub }, info) => {
  const harness = await openDirect(page, hub, [], []);
  await openTopicSwitcher(page, info.project.name);
  const row = page.locator(`[data-test="topic-row"][data-topic-id="${sourceTopicId}"]`);
  await row.getByTestId("topic-row-more").click();
  // Normal Topic actions stay; only Fork is gated on the capability.
  await expect(page.getByTestId("menu-rename")).toBeVisible();
  await expect(page.getByTestId("menu-fork")).toHaveCount(0);
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  // Both fork entries hide: the base capability is gone, so the message one
  // cannot apply either.
  await expect(page.getByTestId("timeline-fork-message")).toHaveCount(0);
  expect(harness.forkRequests).toHaveLength(0);
});

test("a base-only Direct fork keeps the Topic menu but hides the row control", async ({ page, hub }, info) => {
  // Same skew as the Group pane: an old connector rejects the message shape,
  // so the Topic-menu entry stays on the base capability while the per-row
  // control hides on the message one.
  const harness = await openDirect(page, hub, [], [RELAY_CAPABILITIES.directTopicForkV1]);
  const row = page.getByTestId("conversation-timeline-scroller")
    .locator(`[data-row-key="message:${requestMessage.id}"]`);
  await row.hover();
  await expect(page.getByTestId("timeline-fork-message")).toHaveCount(0);
  await openTopicSwitcher(page, info.project.name);
  const topicRow = page.locator(`[data-test="topic-row"][data-topic-id="${sourceTopicId}"]`);
  await topicRow.getByTestId("topic-row-more").click();
  await expect(page.getByTestId("menu-fork")).toBeVisible();
  expect(harness.forkRequests).toHaveLength(0);
});
