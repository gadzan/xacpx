import type { Page } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * The single conversation shell (design §8) end to end: one timeline, one
 * composer, one status bar. Every assertion runs on both Playwright projects,
 * so desktop and mobile share the same behaviour by construction.
 */

const createdAt = "2026-11-07T00:00:00.000Z";
const scope = { conversationId: "group_timeline", topicId: "topic_timeline" };
const bots = [
  { id: "lead", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "reviewer", name: "Bob", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Cara", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = {
  id: scope.conversationId,
  kind: "group",
  title: "Timeline team",
  botIds: bots.map((bot) => bot.id),
  leadBotId: "lead",
  createdAt,
  updatedAt: createdAt,
};
const topic = {
  id: scope.topicId,
  conversationId: scope.conversationId,
  title: "Release review",
  status: "active",
  createdAt,
  updatedAt: createdAt,
};

function member(id: string, botId: string, index: number, state: MemberTurnSummaryDto["state"], patch: Partial<MemberTurnSummaryDto> = {}): MemberTurnSummaryDto {
  return {
    ...scope,
    id,
    runId: "run_timeline",
    botId,
    batch: 1,
    memberIndex: index,
    attempt: 1,
    origin: "roundtable",
    state,
    createdAt,
    ...patch,
  };
}

const request: ConversationMessageDto = {
  ...scope,
  id: "msg_request",
  seq: 1,
  role: "human",
  content: "Review the release",
  createdAt,
};
const leadReply: ConversationMessageDto = {
  ...scope,
  id: "msg_lead",
  seq: 2,
  role: "bot",
  senderBotId: "lead",
  memberTurnId: "turn_lead",
  runId: "run_timeline",
  content: "Two risks: the lock and the rollback.",
  createdAt,
};
const handoff: ConversationMessageDto = {
  ...scope,
  id: "msg_handoff",
  seq: 3,
  role: "system",
  senderBotId: "lead",
  memberTurnId: "turn_lead",
  runId: "run_timeline",
  content: "",
  handoff: {
    senderMemberTurnId: "turn_lead",
    to: "reviewer",
    assignmentId: "assignment_lock",
    memberTurnId: "turn_reviewer",
    task: "Check the session lock",
  },
  createdAt,
};

const turns = [
  member("turn_lead", "lead", 0, "completed"),
  member("turn_reviewer", "reviewer", 1, "completed"),
  member("turn_tester", "tester", 2, "running"),
];

function runDetail(): ConversationRunDetailDto {
  return {
    ...scope,
    id: "run_timeline",
    requestMessageId: request.id,
    requestId: "req_timeline",
    mode: "explicit",
    shape: "roundtable",
    rounds: 1,
    leadBotId: "lead",
    state: "running",
    profileRevision: 1,
    createdAt,
    startedAt: createdAt,
    memberTurns: turns,
  } as ConversationRunDetailDto;
}

/** Recent filler so the transcript really overflows and the scroller can be
 *  exercised (load older / jump latest). */
function recentFiller(): ConversationMessageDto[] {
  return Array.from({ length: 24 }, (_, index) => ({
    ...scope,
    id: `recent_${index}`,
    seq: 5 + index,
    role: "human" as const,
    content: `Recent note ${index}`,
    createdAt,
  }));
}

function entriesOf(messages: ConversationMessageDto[], windowOlder: ConversationMessageDto[]): ConversationTimelineEntryDto[] {
  const entries: ConversationTimelineEntryDto[] = [];
  const push = (message: ConversationMessageDto) => entries.push({
    kind: "message",
    key: `message:${message.id}`,
    anchorSeq: message.seq,
    message,
    ...(message.memberTurnId ? { memberTurnId: message.memberTurnId, ownership: "exact" as const } : {}),
    ...(message.runId ? { runId: message.runId } : {}),
  });
  for (const message of windowOlder) push(message);
  for (const message of messages) push(message);
  // The running tester has no public message yet: one activity row.
  entries.push({
    kind: "activity",
    key: "activity:turn_tester",
    anchorSeq: 40,
    runId: "run_timeline",
    memberTurn: turns[2]!,
  });
  return entries;
}

interface Harness {
  messages: ConversationMessageDto[];
  older: ConversationMessageDto[];
  timelineRequests: Array<Record<string, unknown>>;
  promptRequests: Array<Record<string, unknown>>;
  cancelRequests: Array<Record<string, unknown>>;
  /** `control.workspaces.list` hits: the session list warms agents, but the
   *  Group pane is what loads the workspaces a member's runnability needs, and
   *  mention resolution waits on both. */
  workspaceListRequests: number;
}

async function openTimeline(
  page: Page,
  hub: { port: number },
  options: { olderPages?: boolean } = {},
): Promise<Harness> {
  const messages: ConversationMessageDto[] = [request, leadReply, handoff, ...recentFiller()];
  const older: ConversationMessageDto[] = options.olderPages === false
    ? []
    : Array.from({ length: 20 }, (_, index) => ({
        ...scope,
        id: `old_${index}`,
        seq: index - 20,
        role: "human" as const,
        content: `Earlier context ${index}`,
        createdAt,
      }));
  const detail = runDetail();
  const harness: Harness = {
    messages,
    older,
    timelineRequests: [],
    promptRequests: [],
    cancelRequests: [],
    workspaceListRequests: 0,
  };

  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });

  // The core advertises the timeline + roundtable capabilities.
  await page.route("**/api/instances", async (route) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/instances`);
    const body = await response.json() as { instances: Array<{ capabilities?: string[] }> };
    for (const instance of body.instances) {
      instance.capabilities = [...new Set([
        ...(instance.capabilities ?? []),
        RELAY_CAPABILITIES.conversationTimelineV1,
        RELAY_CAPABILITIES.roundtableV1,
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
      // The pane loads the catalog on open so `@Name` can prove a member
      // runnable; the workspaces fetch is the one a fresh session lacks.
      case "control.agents.list": result = { agents: [{ name: "codex", driver: "codex" }] }; break;
      case "control.workspaces.list": {
        harness.workspaceListRequests += 1;
        result = { workspaces: [{ name: "repo", cwd: "/repo" }] };
        break;
      }
      case "control.agents.catalog": result = { agents: [] }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": result = {
        ...scope,
        messages,
        oldestSeq: 1,
        newestSeq: messages.at(-1)?.seq,
        hasMoreBefore: older.length > 0,
        hasMoreAfter: false,
      }; break;
      case "control.conversation.timeline": {
        harness.timelineRequests.push(payload);
        const beforeSeq = typeof payload.beforeSeq === "number" ? payload.beforeSeq : undefined;
        const windowOlder = beforeSeq === undefined
          ? []
          : older.filter((message) => message.seq < beforeSeq).slice(-10);
        const page_: ConversationTimelineDto = {
          ...scope,
          entries: entriesOf(messages, windowOlder),
          activeRound: {
            runId: "run_timeline",
            roundIndex: 1,
            rounds: 1,
            speakerCount: 3,
            spoken: 1,
            passed: 0,
            activeMemberTurnId: "turn_tester",
            state: "running",
          },
          oldestSeq: 1,
          newestSeq: messages.at(-1)?.seq,
          hasMoreBefore: beforeSeq === undefined ? older.length > 0 : false,
          hasMoreAfter: false,
        };
        result = page_;
        break;
      }
      case "control.runs.list": result = { ...scope, runs: [detail], activeRunId: detail.id, activeRun: detail }; break;
      case "control.runs.get": result = { run: detail }; break;
      case "control.runs.details.batch": result = {
        runs: [detail].filter((candidate) => (payload.runIds as string[]).includes(candidate.id)),
        missingRunIds: [],
      }; break;
      case "control.runs.trace.get": result = {
        memberTurnId: payload.memberTurnId,
        attempt: 1,
        recordingState: "recording",
        events: [],
        nextSeq: 0,
        hasMore: false,
        attempts: [1],
        plan: [],
      }; break;
      case "control.conversation.prompt": {
        harness.promptRequests.push(payload);
        const accepted: ConversationMessageDto = {
          ...scope,
          id: `msg_prompt_${harness.promptRequests.length}`,
          seq: 40 + harness.promptRequests.length,
          role: "human",
          content: String(payload.text ?? ""),
          createdAt,
        };
        harness.messages.push(accepted);
        result = { message: accepted, run: detail };
        break;
      }
      case "control.runs.cancel":
        harness.cancelRequests.push(payload);
        result = { ok: true, run: { ...detail, state: "cancelled" } };
        break;
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

function correlation(memberTurnId: string, botId: string) {
  return { ...scope, runId: "run_timeline", memberTurnId, botId, attempt: 1 };
}
/**
 * App-level console errors. A mocked hub answers 404 for PWA/icon assets it does
 * not serve; that is environment noise, not a product error.
 */
function watchConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().includes("Failed to load resource")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}


test("one timeline: handoff line, round strip, Stop all, detail drawer, no console errors", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  const harness = await openTimeline(page, hub, { olderPages: false });

  // One entry per message, one handoff line under its sender.
  await expect(page.locator('[data-test="timeline-bot-message"]')).toHaveCount(1);
  const handoffLine = page.locator('[data-test="timeline-handoff"]');
  await expect(handoffLine).toBeVisible();
  await expect(handoffLine).toContainText("Ada");
  await expect(handoffLine).toContainText("Bob");
  await expect(handoffLine).toContainText("Check the session lock");

  // Status bar: current speaker, counts, Stop all.
  await expect(page.getByTestId("conversation-status-bar")).toBeVisible();
  await expect(page.getByTestId("round-strip")).toBeVisible();
  await expect(page.getByTestId("round-strip-spoken")).toContainText("1/3 spoken");
  await expect(page.getByTestId("round-strip-speaker")).toContainText("Cara");
  const stop = page.getByTestId("conversation-stop-all");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => harness.cancelRequests.length).toBe(1);

  // Detail drawer: bot meta opens the existing per-member process surface.
  await page.getByTestId("timeline-open-detail").first().click();
  const drawer = page.getByTestId("group-detail-card").or(page.getByTestId("group-detail-sheet"));
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("group-run-detail")).toBeVisible();
  expect(errors).toEqual([]);
});

test("composer sends to the lead by default and discusses with a roundtable target", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  const harness = await openTimeline(page, hub, { olderPages: false });

  const textarea = page.getByTestId("group-composer-textarea");
  await textarea.fill("Ship the release");
  await page.getByTestId("group-send-prompt-button").click();
  await expect.poll(() => harness.promptRequests.length).toBe(1);
  // A plain message carries no wire target: the server resolves the lead.
  expect(harness.promptRequests[0]?.target).toBeUndefined();

  await textarea.fill("Compare the risks");
  await page.getByTestId("group-discuss-chip").click();
  await expect.poll(() => harness.promptRequests.length).toBe(2);
  expect(harness.promptRequests[1]?.target).toEqual({
    mode: "roundtable",
    botIds: ["lead", "reviewer", "tester"],
    rounds: 1,
  });
  expect(errors).toEqual([]);
});

test("discussion sends the chosen rounds on the wire target", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  const harness = await openTimeline(page, hub, { olderPages: false });

  const textarea = page.getByTestId("group-composer-textarea");
  await textarea.fill("Compare the risks");
  await page.getByTestId("group-discuss-rounds-2").click();
  await page.getByTestId("group-discuss-chip").click();
  await expect.poll(() => harness.promptRequests.length).toBe(1);
  expect(harness.promptRequests[0]?.target).toEqual({
    mode: "roundtable",
    botIds: ["lead", "reviewer", "tester"],
    rounds: 2,
  });
  expect(errors).toEqual([]);
});

test("streams the current speaker and replaces the live bubble with the durable message", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  // The timeline mock owns the durable rows, so a message the core persists
  // must also enter the harness before the reload refetches it.
  const harness = await openTimeline(page, hub, { olderPages: false });
  await expect.poll(() => hub.sockets.some((socket) => socket.readyState === 1), { timeout: 20_000 }).toBe(true);

  hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: {
      chatKey: "group-timeline",
      sessionAlias: "test",
      conversation: correlation("turn_tester", "tester"),
      type: "turn-output",
      chunk: "TOCTOU in the lock path",
    },
  });
  const live = page.locator('[data-test="timeline-live-bubble"]');
  await expect(live).toHaveCount(1);
  await expect(live).toContainText("TOCTOU in the lock path");

  // The durable message claims the same MemberTurn: the overlay disappears and
  // the speech is drawn once, as an ordinary bubble.
  const durable: ConversationMessageDto = {
    ...scope,
    id: "msg_tester",
    seq: 4,
    role: "bot",
    senderBotId: "tester",
    memberTurnId: "turn_tester",
    runId: "run_timeline",
    content: "TOCTOU in the lock path",
    createdAt,
  };
  harness.messages.push(durable);
  hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: { type: "conversation-message", message: durable },
  });
  await expect(page.locator('[data-test="timeline-live-bubble"]')).toHaveCount(0);
  const bubbles = page.locator('[data-test="timeline-bot-message"]');
  await expect(bubbles).toHaveCount(2);
  await expect(bubbles.filter({ hasText: "TOCTOU in the lock path" })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("refresh keeps the timeline and scrolling loads earlier rows / jumps back to latest", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  const harness = await openTimeline(page, hub);

  const scroller = page.getByTestId("conversation-timeline-scroller");
  await expect(scroller).toBeVisible();
  await expect(page.getByTestId("timeline-handoff")).toBeVisible();

  // Earlier history: the control prepends a page and keeps the reader anchored.
  const older = page.getByTestId("timeline-load-older");
  await expect(older).toBeVisible();
  await older.click();
  await expect.poll(() => harness.timelineRequests.some((request) => typeof request.beforeSeq === "number")).toBe(true);

  // Scrolling up reveals the jump-to-latest control; it returns to the bottom.
  await scroller.evaluate((el) => { el.scrollTop = 0; });
  const timelineRoot = scroller.locator("..");
  const jump = timelineRoot.getByTestId("jump-latest");
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 96)).toBe(true);

  // A refresh rebuilds the same room from the durable read model.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("timeline-handoff")).toBeVisible();
  await expect(page.getByTestId("group-send-prompt-button")).toBeVisible();
  expect(errors).toEqual([]);
});

test("fresh session: an @member send resolves and targets exactly that member", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  const harness = await openTimeline(page, hub, { olderPages: false });
  const textarea = page.getByTestId("group-composer-textarea");

  // A fresh login carries no workspace catalog: the pane fetches it when it
  // opens (no dialog needed), and only a loaded catalog proves the member
  // runnable. Wait for that fetch before typing the mention.
  await expect.poll(() => harness.workspaceListRequests).toBeGreaterThan(0);
  await textarea.fill("@Bob check the lock ");
  await expect(page.getByTestId("group-prompt-error")).toHaveCount(0);

  await page.getByTestId("group-send-prompt-button").click();
  await expect.poll(() => harness.promptRequests.length).toBe(1);
  expect(harness.promptRequests[0]?.target).toEqual({ mode: "members", botIds: ["reviewer"] });
  expect(errors).toEqual([]);
});

test("an unknown @token blocks the send, names the token, and keeps the draft", async ({ page, hub }) => {
  const errors = watchConsoleErrors(page);
  const harness = await openTimeline(page, hub, { olderPages: false });
  const textarea = page.getByTestId("group-composer-textarea");

  await textarea.fill("@Nobody check the lock ");
  await page.getByTestId("group-send-prompt-button").click();

  // The blocking surface names the token — never the member roster.
  await expect(page.getByTestId("group-unresolved-token")).toHaveText("@Nobody");
  expect(await textarea.inputValue()).toBe("@Nobody check the lock ");
  // No prompt crossed the wire.
  expect(harness.promptRequests).toEqual([]);
  // Dismissing keeps both the draft and the block.
  await page.getByTestId("composer-confirm-cancel").click();
  await page.getByTestId("group-send-prompt-button").click();
  await expect(page.getByTestId("group-unresolved-token")).toHaveText("@Nobody");
  expect(harness.promptRequests).toEqual([]);
  expect(errors).toEqual([]);
});
