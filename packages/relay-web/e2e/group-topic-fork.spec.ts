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
 * Group Topic fork end to end (design §9): the Topic menu is the entry, the
 * dialog submits one `control.group.topics.fork` call with the ids it minted,
 * and the new Topic opens with its fork banner, copied count and source link.
 * Both Playwright projects run the same assertions; only the menu surface
 * (popover vs sheet) differs.
 *
 * The RPC is stubbed per page: the fork answer is spec-local state (it must
 * upsert a Topic and seed its copied history), which a shared mock-hub route
 * cannot narrate without growing a second fake core.
 */

const createdAt = "2026-11-11T00:00:00.000Z";
const conversationId = "group_fork";
const sourceTopicId = "topic_release";
const sourceTitle = "Release";
const runId = "run_settled";
const requestMessageId = "message_request";

const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = {
  id: conversationId,
  kind: "group",
  title: "Fork team",
  botIds: bots.map((bot) => bot.id),
  leadBotId: "lead",
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
  id: requestMessageId,
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
  memberTurnId: "turn_lead",
  role: "bot",
  senderBotId: "lead",
  content: "Release triaged",
  createdAt,
};

function memberTurn(): MemberTurnSummaryDto {
  return {
    conversationId,
    topicId: sourceTopicId,
    id: "turn_lead",
    runId,
    botId: "lead",
    batch: 1,
    memberIndex: 0,
    attempt: 1,
    origin: "human-explicit",
    state: "completed",
    createdAt,
  };
}

const run: ConversationRunDetailDto = {
  conversationId,
  topicId: sourceTopicId,
  id: runId,
  requestMessageId,
  requestId: "request_1",
  mode: "explicit",
  shape: "single",
  state: "completed",
  profileRevision: 1,
  createdAt,
  memberTurns: [memberTurn()],
};

interface ForkReply {
  /** Error code the core would answer instead of a Topic. */
  code?: string;
  topic?: TopicSummaryDto;
}

interface Harness {
  topics: TopicSummaryDto[];
  messages: Record<string, ConversationMessageDto[]>;
  /** Topic ids the pane asked history for, in call order. */
  historyTopicIds: string[];
  /** Every `control.group.topics.fork` payload, in call order. */
  forkRequests: Array<Record<string, unknown>>;
  /** Queued answers: one is consumed per fork call. */
  forkReplies: ForkReply[];
}

/** Copied rows are ordinary Topic messages with no Run/MemberTurn ownership. */
function copiedOf(source: ConversationMessageDto[], targetTopicId: string): ConversationMessageDto[] {
  return source.map((message, index) => ({
    conversationId,
    topicId: targetTopicId,
    id: `copy_${index + 1}`,
    seq: index + 1,
    role: message.role,
    ...(message.senderBotId ? { senderBotId: message.senderBotId } : {}),
    content: message.content,
    createdAt: message.createdAt,
    forkedFromMessageId: message.id,
  }));
}

function entriesOf(messages: ConversationMessageDto[]): ConversationTimelineEntryDto[] {
  return messages.map((message) => ({
    kind: "message",
    key: `message:${message.id}`,
    anchorSeq: message.seq,
    ownership: "exact",
    message,
    // The Run detail trigger reads ownership from the entry, not the message:
    // copied rows carry no Run, so they never expose it.
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

async function openGroup(
  page: Page,
  hub: { port: number },
  replies: ForkReply[],
  forkCapability = true,
): Promise<Harness> {
  const harness: Harness = {
    topics: [sourceTopic],
    messages: { [sourceTopicId]: [requestMessage, replyMessage] },
    historyTopicIds: [],
    forkRequests: [],
    forkReplies: replies,
  };

  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });

  // The core advertises fork on top of the mock hub's timeline capability.
  await page.route("**/api/instances", async (route) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/instances`);
    const body = await response.json() as { instances: Array<{ capabilities?: string[] }> };
    for (const instance of body.instances) {
      instance.capabilities = [...new Set([
        ...(instance.capabilities ?? []),
        RELAY_CAPABILITIES.conversationTimelineV1,
        ...(forkCapability ? [RELAY_CAPABILITIES.groupTopicForkV1] : []),
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
      case "control.bots.list": result = { bots }; break;
      case "control.agents.list": result = { agents: [{ name: "codex", driver: "codex" }] }; break;
      case "control.workspaces.list": result = { workspaces: [{ name: "repo", cwd: "/repo" }] }; break;
      case "control.agents.catalog": result = { agents: [] }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: harness.topics } }; break;
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
        // Mirror the core: a message boundary copies rows through that row's
        // own seq only, so the mock never hands back a fuller copy than asked.
        const source = harness.messages[sourceTopicId] ?? [];
        const point = input.sourcePoint as { type?: string; messageId?: string } | undefined;
        const boundarySeq = point?.type === "message"
          ? source.find((message) => message.id === point.messageId)?.seq
          : undefined;
        harness.messages[forkTopic.id] = copiedOf(
          boundarySeq === undefined ? source : source.filter((message) => message.seq <= boundarySeq),
          forkTopic.id,
        );
        result = { topic: forkTopic };
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
  return harness;
}

/** Open the active Topic's row menu through the pill, then its Fork item. */
async function openForkFromTopicMenu(page: Page): Promise<void> {
  await page.getByTestId("group-topic-pill").click();
  const row = page.locator(`[data-test="topic-row"][data-topic-id="${sourceTopicId}"]`);
  await row.getByTestId("topic-row-more").click();
  await page.getByTestId("menu-fork").click();
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
}

function forkedTopic(input: {
  id: string;
  requestId: string;
  copiedMessages: number;
  omittedMessages?: number;
  sourceRunId?: string;
}): TopicSummaryDto {
  return topic(input.id, "Release fork", {
    forkedFrom: {
      requestId: input.requestId,
      sourceConversationId: conversationId,
      sourceTopicId,
      sourceTitle,
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      throughSeq: 2,
      rootTopicId: sourceTopicId,
      copiedMessages: input.copiedMessages,
      omittedMessages: input.omittedMessages ?? 0,
      createdAt,
    },
  });
}

test("the Topic menu forks at the latest settled run and opens the new Topic with its banner", async ({ page, hub }) => {
  const harness = await openGroup(page, hub, [
    { topic: forkedTopic({ id: "topic_forked", requestId: "request_fork", copiedMessages: 2, sourceRunId: runId }) },
  ]);
  await openForkFromTopicMenu(page);
  await page.getByTestId("fork-topic-submit").click();

  await expect.poll(() => harness.forkRequests.length).toBe(1);
  const input = harness.forkRequests[0]!;
  expect(input.conversationId).toBe(conversationId);
  expect(input.sourceTopicId).toBe(sourceTopicId);
  expect(input.sourcePoint).toEqual({ type: "latest_stable" });
  expect(input.targetTopicId).toMatch(/^topic_[0-9a-f-]{36}$/);
  expect(input.requestId).toMatch(/^[0-9a-f-]{36}$/);

  // The dialog closes only after the store switched to the returned Topic.
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  await expect(page.getByTestId("topic-fork-banner")).toBeVisible();
  await expect(page.getByTestId("topic-fork-banner-title")).toContainText(`Forked from ${sourceTitle}`);
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("2 messages copied");
  await expect(page.getByTestId("topic-fork-banner-omitted")).toHaveCount(0);
  // The forked Topic renders the copied messages without Run ownership:
  // copied rows carry no Run, so they never offer the Run detail entry.
  await expect(page.getByTestId("conversation-timeline-scroller").getByTestId("timeline-bot-message")).toContainText("Release triaged");
  await expect(page.getByTestId("conversation-timeline-scroller").getByTestId("timeline-open-detail")).toHaveCount(0);
  expect(harness.historyTopicIds).toContain("topic_forked");

  // The source link is real: it switches back to the source Topic, which is
  // not a fork and still owns its Run.
  await page.getByTestId("topic-fork-banner-source").click();
  await expect.poll(() => harness.historyTopicIds.at(-1)).toBe(sourceTopicId);
  await expect(page.getByTestId("topic-fork-banner")).toHaveCount(0);
  await expect(page.getByTestId("conversation-timeline-scroller").getByTestId("timeline-open-detail")).toHaveCount(1);
});

test("the run-level entry forks from the exact settled run id", async ({ page, hub }) => {
  const harness = await openGroup(page, hub, [
    { topic: forkedTopic({ id: "topic_from_run", requestId: "request_run", copiedMessages: 2, sourceRunId: runId }) },
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

test("a missing-history answer names the start-over and the next click forks with fresh ids", async ({ page, hub }) => {
  const harness = await openGroup(page, hub, [
    { code: "topic_fork_history_missing" },
    { topic: forkedTopic({ id: "topic_retried", requestId: "request_retry", copiedMessages: 2, omittedMessages: 3 }) },
  ]);
  await openForkFromTopicMenu(page);
  await page.getByTestId("fork-topic-submit").click();
  await expect.poll(() => harness.forkRequests.length).toBe(1);
  await expect(page.getByTestId("fork-topic-error")).toContainText("Click Fork again to start over");
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
  const first = harness.forkRequests[0]!;

  await page.getByTestId("fork-topic-submit").click();
  await expect.poll(() => harness.forkRequests.length).toBe(2);
  const second = harness.forkRequests[1]!;
  // Orphan rows are unrecoverable under the same ids: the retry must start
  // over with a new target and request id, or the core would fail closed again.
  expect(second.targetTopicId).not.toBe(first.targetTopicId);
  expect(second.requestId).not.toBe(first.requestId);
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("2 messages copied");
  await expect(page.getByTestId("topic-fork-banner-omitted")).toContainText("3 older messages omitted");
});

/** Hover a row and click its fork control, the way a reader finds it. */
async function forkAtMessage(page: Page, messageId: string): Promise<void> {
  const row = page.getByTestId("conversation-timeline-scroller")
    .locator(`[data-row-key="message:${messageId}"]`);
  await row.hover();
  await row.getByTestId("timeline-fork-message").click();
  await expect(page.getByTestId("fork-topic-dialog")).toBeVisible();
}

test("a message row's fork control cuts the boundary at that row", async ({ page, hub }) => {
  const harness = await openGroup(page, hub, [
    { topic: forkedTopic({ id: "topic_at_bot", requestId: "request_at_bot", copiedMessages: 2 }) },
  ]);
  await page.screenshot({ path: "test-results/group-fork-message-row.png" });
  await forkAtMessage(page, replyMessage.id);
  await expect(page.getByTestId("fork-topic-point")).toContainText("Fork point: this message");
  await page.getByTestId("fork-topic-submit").click();

  await expect.poll(() => harness.forkRequests.length).toBe(1);
  expect(harness.forkRequests[0]!.sourcePoint).toEqual({ type: "message", messageId: replyMessage.id });
  await expect(page.getByTestId("fork-topic-dialog")).toHaveCount(0);
  // The copy holds the boundary row and everything before it, nothing after.
  expect(harness.messages.topic_at_bot!.map((message) => message.forkedFromMessageId))
    .toEqual([requestMessage.id, replyMessage.id]);
  await expect(page.getByTestId("topic-fork-banner-count")).toContainText("2 messages copied");
});

test("a core without the Group fork capability offers no row control", async ({ page, hub }) => {
  const harness = await openGroup(page, hub, [], false);
  await expect(page.getByTestId("conversation-timeline-scroller").getByTestId("timeline-bot-message")).toBeVisible();
  await expect(page.getByTestId("timeline-fork-message")).toHaveCount(0);
  expect(harness.forkRequests).toHaveLength(0);
});
