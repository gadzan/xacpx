import type { Page } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationTimelineEntryDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * Parallel members on the one timeline (design §8.1): each member owns one
 * activity row and one live bubble, which accumulates that member's streamed
 * prose. Settled replies replace the activity row with the member's durable
 * bubble.
 */

const createdAt = "2026-11-05T12:00:00.000Z";
const scope = { conversationId: "group_interleave", topicId: "topic_interleave" };
const bots = ["reviewer", "tester"].map((id) => ({
  id, name: id === "reviewer" ? "Reviewer" : "Tester", agent: "codex", workspace: "repo", enabled: true, createdAt, updatedAt: createdAt,
}));
const group = { id: scope.conversationId, kind: "group", title: "Parallel team", botIds: bots.map(({ id }) => id), leadBotId: "reviewer", createdAt, updatedAt: createdAt };
const topics = [{ id: scope.topicId, conversationId: scope.conversationId, title: "Implementation", status: "active", createdAt, updatedAt: createdAt }];

function liveMember(id: string, botId: string, index: number): MemberTurnSummaryDto {
  return {
    ...scope, id, runId: "run_live", botId, batch: 1, memberIndex: index, attempt: 1,
    origin: index === 0 ? "human-explicit" : "followup", state: "running",
    promptRequestId: `prompt_${id}`, assignmentId: `assignment_${id}`, task: `Public task for ${id}`,
    createdAt, startedAt: createdAt,
  };
}

const request: ConversationMessageDto = {
  ...scope, id: "msg_request", seq: 1, role: "human", content: "Both of you, report back", createdAt,
};

/** Same shape the relay hub forwards for a live member's turn. */
function correlation(memberTurn: MemberTurnSummaryDto) {
  return { ...scope, runId: memberTurn.runId, memberTurnId: memberTurn.id, botId: memberTurn.botId, attempt: memberTurn.attempt };
}

function entriesFor(messages: ConversationMessageDto[], members: MemberTurnSummaryDto[]): ConversationTimelineEntryDto[] {
  const claimed = new Set(messages.map((message) => message.memberTurnId).filter(Boolean));
  return [
    ...messages.map((message, index): ConversationTimelineEntryDto => message.memberTurnId && message.runId
      ? {
          kind: "message", key: `message:${message.id}`, anchorSeq: index + 1,
          runId: message.runId, memberTurnId: message.memberTurnId, ownership: "exact", message,
        }
      : { kind: "message", key: `message:${message.id}`, anchorSeq: index + 1, message }),
    ...members.filter((member) => !claimed.has(member.id)).map((member, index): ConversationTimelineEntryDto => ({
      kind: "activity", key: `activity:${member.id}`, anchorSeq: messages.length + index + 1,
      runId: member.runId, memberTurn: member,
    })),
  ];
}

async function openParallelRun(page: Page) {
  const first = liveMember("turn_a", "reviewer", 0);
  const second = liveMember("turn_b", "tester", 1);
  const messages: ConversationMessageDto[] = [request];
  const run: ConversationRunDetailDto = {
    ...scope, id: "run_live", requestMessageId: request.id, requestId: "request_live_nonce",
    mode: "explicit", state: "running", profileRevision: 1, createdAt, startedAt: createdAt,
    memberTurns: [first, second],
  };
  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload = {} } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics } }; break;
      case "control.topics.list": result = { topics }; break;
      case "control.conversation.history": result = {
        ...scope, messages, oldestSeq: messages[0]?.seq, newestSeq: messages.at(-1)?.seq,
        hasMoreBefore: false, hasMoreAfter: false,
      }; break;
      case "control.conversation.timeline": result = {
        ...scope, entries: entriesFor(messages, run.memberTurns),
        hasMoreBefore: false, hasMoreAfter: false,
      }; break;
      case "control.runs.list": result = { ...scope, runs: [run], activeRunId: run.id, activeRun: run }; break;
      case "control.runs.get": result = { run }; break;
      case "control.runs.details.batch": result = { runs: [run].filter((candidate) => payload.runIds.includes(candidate.id)), missingRunIds: [] }; break;
      case "control.runs.trace.get": result = {
        memberTurnId: payload.memberTurnId, attempt: 1, recordingState: "recording",
        events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [],
      }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  return { run, first, second, messages };
}

const liveBubbles = (page: Page) => page.locator('[data-test="timeline-live-bubble"]');

test("parallel members keep one accumulating live bubble each", async ({ page, hub }, info) => {
  const fixture = await openParallelRun(page);
  const send = (memberTurn: MemberTurnSummaryDto, event: Record<string, unknown>) => hub.send({
    kind: "control-event", instanceId: "i1",
    event: { chatKey: "group-interleave", sessionAlias: "test", conversation: correlation(memberTurn), ...event },
  });
  await expect.poll(() => hub.sockets.some((socket) => socket.readyState === 1), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-test="timeline-activity"]')).toHaveCount(2);
  send(fixture.first, { type: "turn-output", chunk: "ALPHA ONE" });
  send(fixture.second, { type: "turn-output", chunk: "BRAVO ONE" });
  await expect(liveBubbles(page)).toHaveCount(2);
  // A thought never opens a bubble of its own: the member's single live bubble
  // keeps accumulating its prose, newest last.
  send(fixture.first, { type: "turn-thought", chunk: "checking the diff" });
  send(fixture.second, { type: "turn-thought", chunk: "running the suite" });
  send(fixture.first, { type: "turn-output", chunk: "ALPHA TWO" });
  send(fixture.second, { type: "turn-output", chunk: "BRAVO TWO" });

  await expect(liveBubbles(page)).toHaveCount(2);
  const alpha = liveBubbles(page).nth(0);
  const bravo = liveBubbles(page).nth(1);
  await expect(alpha).toContainText("ALPHA ONE");
  await expect(alpha).toContainText("ALPHA TWO");
  await expect(bravo).toContainText("BRAVO ONE");
  await expect(bravo).toContainText("BRAVO TWO");
  // Thoughts stay in the process drawer, never in the speech bubble.
  await expect(alpha).not.toContainText("checking the diff");
  await expect(bravo).not.toContainText("running the suite");
  expect(await alpha.evaluate((el) => el.textContent?.indexOf("ALPHA ONE") ?? -1))
    .toBeLessThan(await alpha.evaluate((el) => el.textContent?.indexOf("ALPHA TWO") ?? -1));
  for (const member of [fixture.first, fixture.second]) {
    await expect(page.locator(`[data-test="timeline-activity"][data-row-id="${member.id}"]`)).toHaveCount(1);
  }
  send(fixture.first, { type: "turn-output", chunk: " (more)" });
  await expect(liveBubbles(page)).toHaveCount(2);
  await expect(liveBubbles(page).nth(0)).toContainText("ALPHA TWO (more)");
  await expect(liveBubbles(page).nth(1)).not.toContainText("(more)");
  await info.attach("parallel-interleave", { body: await page.screenshot(), contentType: "image/png" });
});

test("settled canonical replies replace each member's activity row", async ({ page, hub }, info) => {
  const fixture = await openParallelRun(page);
  await expect.poll(() => hub.sockets.some((socket) => socket.readyState === 1), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('[data-test="timeline-activity"]')).toHaveCount(2);

  // The core persists one message per member; internal blank lines are markdown
  // content rendered inside that member's single bubble, never bubble boundaries.
  const replies: ConversationMessageDto[] = [
    { ...scope, id: "reply_a", seq: 2, role: "bot", senderBotId: fixture.first.botId,
      memberTurnId: fixture.first.id, runId: fixture.run.id,
      content: "Alpha ①：气泡只装文本，一段一个泡。\n\nAlpha ②：dots 挂在我最新那段下面。", createdAt },
    { ...scope, id: "reply_b", seq: 3, role: "bot", senderBotId: fixture.second.botId,
      memberTurnId: fixture.second.id, runId: fixture.run.id,
      content: "Bravo ①：并行时按到达顺序交错。\n\nBravo ②：结束后收进结论气泡。", createdAt },
  ];
  for (const reply of replies) {
    fixture.messages.push(reply);
    hub.send({ kind: "control-event", instanceId: "i1", event: { type: "conversation-message", message: reply } });
  }
  const bubbles = page.locator('[data-test="timeline-bot-message"]');
  // One durable bubble per member: the whole reply, blank line and all.
  await expect(bubbles).toHaveCount(2);
  const texts = await bubbles.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
  expect(texts.some((text) => text.includes("Alpha ①") && text.includes("Alpha ②"))).toBe(true);
  expect(texts.some((text) => text.includes("Bravo ①") && text.includes("Bravo ②"))).toBe(true);
  await expect(page.locator('[data-test="timeline-activity"]')).toHaveCount(0);
  await info.attach("settled-segments", { body: await page.screenshot(), contentType: "image/png" });
});
