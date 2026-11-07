import type { Page } from "@playwright/test";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  ConversationRunTraceEventDto,
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
  MemberTurnSummaryDto,
} from "@ganglion/xacpx-relay-protocol";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";
import type { MockHub } from "./mock-hub";

/**
 * The one Run-wide detail drawer (design §8.4) end to end. Every assertion runs
 * on both Playwright projects, so desktop overlay and mobile sheet share one
 * content tree by construction.
 */

const createdAt = "2026-11-08T00:00:00.000Z";
const scope = { conversationId: "group_drawer", topicId: "topic_drawer" };
const bots = [
  { id: "lead", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "reviewer", name: "Bob", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Cara", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = {
  id: scope.conversationId,
  kind: "group",
  title: "Drawer team",
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

function member(
  id: string,
  botId: string,
  index: number,
  state: MemberTurnSummaryDto["state"],
  patch: Partial<MemberTurnSummaryDto> = {},
): MemberTurnSummaryDto {
  return {
    ...scope,
    id,
    runId: "run_drawer",
    botId,
    batch: 1,
    memberIndex: index,
    attempt: 1,
    origin: "human-explicit",
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
  runId: "run_drawer",
  content: "Two risks: the lock and the rollback.",
  createdAt,
};

const turns = [
  member("turn_lead", "lead", 0, "completed", { origin: "human-explicit" }),
  member("turn_reviewer", "reviewer", 1, "running", { origin: "handoff", task: "Check the lock" }),
  member("turn_tester", "tester", 2, "queued", { origin: "followup" }),
];

function runDetail(shape: "fanout" | "roundtable"): ConversationRunDetailDto {
  return {
    ...scope,
    id: "run_drawer",
    requestMessageId: request.id,
    requestId: "req_drawer",
    mode: "explicit",
    shape,
    state: "running",
    profileRevision: 1,
    maxMemberTurns: 6,
    consumedMemberTurns: 2,
    budgetEpoch: 1,
    activeBatch: 1,
    createdAt,
    startedAt: createdAt,
    memberTurns: turns,
  } as ConversationRunDetailDto;
}

function traceEvent(seq: number, text: string): ConversationRunTraceEventDto {
  return { seq, createdAt, kind: "text", payload: { text } };
}

const traceByMember: Record<string, ConversationRunTraceEventDto[]> = {
  turn_lead: [traceEvent(1, "Lead trace")],
  turn_reviewer: [traceEvent(1, "Reviewer trace")],
  turn_tester: [traceEvent(1, "Tester trace")],
};

function entry(
  kind: "message" | "activity",
  key: string,
  anchorSeq: number,
  patch: Record<string, unknown>,
): ConversationTimelineEntryDto {
  return { kind, key, anchorSeq, ...patch } as ConversationTimelineEntryDto;
}

function timeline(shape: "fanout" | "roundtable"): ConversationTimelineDto {
  return {
    ...scope,
    entries: [
      entry("message", "message:msg_request", 1, { message: request }),
      entry("message", "message:msg_lead", 2, {
        message: leadReply,
        runId: "run_drawer",
        memberTurnId: "turn_lead",
        ownership: "exact",
      }),
      entry("activity", "activity:turn_reviewer", 3, {
        runId: "run_drawer",
        memberTurn: turns[1]!,
      }),
    ],
    activeRound: {
      runId: "run_drawer",
      roundIndex: 1,
      rounds: shape === "roundtable" ? 1 : 2,
      speakerCount: 3,
      spoken: 1,
      passed: 0,
      activeMemberTurnId: "turn_reviewer",
      state: "running",
    },
    oldestSeq: 1,
    newestSeq: 2,
    hasMoreBefore: false,
    hasMoreAfter: false,
  };
}

interface Harness {
  shape: "fanout" | "roundtable";
  cancelMemberRequests: Array<Record<string, unknown>>;
  interactionResponses: Array<Record<string, unknown>>;
}

async function openDrawer(
  page: Page,
  hub: { port: number },
  shape: "fanout" | "roundtable",
): Promise<Harness> {
  const harness: Harness = {
    shape,
    cancelMemberRequests: [],
    interactionResponses: [],
  };
  const detail = runDetail(shape);

  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });

  await page.route("**/api/instances", async (route) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/instances`);
    const body = await response.json() as { instances: Array<{ capabilities?: string[] }> };
    for (const instance of body.instances) {
      instance.capabilities = [...new Set([
        ...(instance.capabilities ?? []),
        RELAY_CAPABILITIES.conversationTimelineV1,
        RELAY_CAPABILITIES.roundtableV1,
        RELAY_CAPABILITIES.runsCancelMemberV1,
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
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": result = {
        ...scope,
        messages: [request, leadReply],
        oldestSeq: 1,
        newestSeq: 2,
        hasMoreBefore: false,
        hasMoreAfter: false,
      }; break;
      case "control.conversation.timeline": result = timeline(shape); break;
      case "control.runs.list": result = { ...scope, runs: [detail], activeRunId: detail.id, activeRun: detail }; break;
      case "control.runs.get": result = { run: detail }; break;
      case "control.runs.details.batch": result = {
        runs: [detail].filter((candidate) => (payload.runIds as string[]).includes(candidate.id)),
        missingRunIds: [],
      }; break;
      case "control.runs.trace.get": {
        const memberTurnId = String(payload.memberTurnId ?? "");
        const events = traceByMember[memberTurnId] ?? [];
        result = {
          memberTurnId,
          attempt: 1,
          recordingState: "recording",
          events,
          nextSeq: events.at(-1)?.seq ?? 0,
          hasMore: false,
          attempts: [1],
          plan: [],
        };
        break;
      }
      case "control.runs.cancelMember":
        harness.cancelMemberRequests.push(payload);
        result = { run: detail };
        break;
      case "control.interaction.respond":
        harness.interactionResponses.push(payload);
        result = { ok: true };
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

const drawer = (page: Page) =>
  page.locator('[data-test="group-detail-card"], [data-test="group-detail-sheet"]');

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 1024;
}

function correlation(memberTurnId: string, botId: string) {
  return { ...scope, runId: "run_drawer", memberTurnId, botId, attempt: 1 };
}

test("Run-wide drawer: entries, member switch, scoped Stop, approval, budget, live/frozen, reopen", async ({ page, hub }) => {
  const harness = await openDrawer(page, hub, "fanout");
  const mobile = isMobile(page);

  // Open from bot meta, then close; every entry uses the same drawer key.
  await page.getByTestId("timeline-open-detail").click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
  await expect(drawer(page).getByTestId("run-member-row")).toHaveCount(3);
  await expect(drawer(page).getByTestId("run-detail-budget")).toContainText("2/6 member turns");
  await expect(drawer(page).getByTestId("run-detail-state")).toContainText("Running");
  // Stop all lives in the status bar; the drawer only has the scoped stop.
  await expect(drawer(page).getByTestId("group-stop-run-button")).toHaveCount(0);
  await drawer(page).getByTestId("group-detail-close").click();
  await expect(drawer(page)).toHaveCount(0);

  if (!mobile) {
    // Same drawer from the avatar and from the speaker label.
    await page.getByTestId("timeline-open-detail-avatar").click();
    await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
    await drawer(page).getByTestId("group-detail-close").click();
    await expect(drawer(page)).toHaveCount(0);

    await page.getByTestId("transcript-speaker").first().click();
    await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
    await drawer(page).getByTestId("group-detail-close").click();
    await expect(drawer(page)).toHaveCount(0);
  }

  // And from the status bar (RoundStrip speaker).
  await page.getByTestId("round-strip-speaker").click();
  await expect(drawer(page).getByTestId("run-detail")).toBeVisible();

  // Selecting another member swaps the process, not the drawer.
  const reviewerRow = drawer(page).getByTestId("run-member-row").filter({ hasText: "Bob" });
  await reviewerRow.click();
  await expect(drawer(page).getByTestId("run-selected-member")).toHaveAttribute("data-member-turn-id", "turn_reviewer");
  await expect(drawer(page).getByTestId("group-trace-narrative").first()).toContainText("Reviewer trace");
  await expect(drawer(page).getByTestId("run-member-row").filter({ hasText: "Bob" })).toHaveAttribute("data-selected", "true");

  // Scoped Stop for the running fanout member only.
  const stop = drawer(page).getByTestId("run-stop-member");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => harness.cancelMemberRequests).toEqual([
    expect.objectContaining({ runId: "run_drawer", memberTurnId: "turn_reviewer" }),
  ]);

  // A live turn streams into the drawer; when the durable/member snapshot
  // settles, the live overlay is replaced by recorded evidence.
  await hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: {
      chatKey: "group-drawer",
      sessionAlias: "test",
      conversation: correlation("turn_reviewer", "reviewer"),
      type: "turn-output",
      chunk: "LIVE drawer text",
    },
  });
  await expect(drawer(page)).toContainText("LIVE drawer text");
  await hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "member-turn-finished",
      chatKey: "group-drawer",
      sessionAlias: "test",
      run: runDetail("fanout"),
      memberTurn: { ...turns[1]!, state: "completed", finishedAt: createdAt },
    },
  });
  await expect(drawer(page)).not.toContainText("LIVE drawer text");
  await expect(drawer(page).getByTestId("group-trace-narrative").first()).toContainText("Reviewer trace");

  // An open approval reaches the drawer for the exact member turn.
  await hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "interaction-opened",
      chatKey: "group-drawer",
      sessionAlias: "test",
      instanceId: "i1",
      interaction: {
        requestId: "int_drawer",
        kind: "elicitation",
        expiresAt: Date.now() + 60_000,
        conversation: correlation("turn_reviewer", "reviewer"),
        elicitation: {
          mode: "form",
          message: "May I edit the lock file?",
          fields: [{ kind: "text", key: "note", title: "Note", required: false }],
          agent: { name: "Bob" },
        },
      },
    },
  });
  const approval = drawer(page).getByTestId("run-interaction");
  await expect(approval).toBeVisible();
  await expect(approval).toContainText("May I edit the lock file?");
  await approval.getByTestId("interaction-input-note").fill("looks good");
  await approval.getByTestId("interaction-submit").click();
  await expect.poll(() => harness.interactionResponses).toEqual([
    expect.objectContaining({
      requestId: "int_drawer",
      kind: "elicitation",
      action: "accept",
      content: { note: "looks good" },
    }),
  ]);

  // Close and reopen: the same key and content come back.
  await drawer(page).getByTestId("group-detail-close").click();
  await expect(drawer(page)).toHaveCount(0);
  await page.getByTestId("timeline-open-detail").click();
  await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
  await expect(drawer(page).getByTestId("run-member-row")).toHaveCount(3);
});

test("roundtable never offers a per-member Stop in the drawer", async ({ page, hub }) => {
  await openDrawer(page, hub, "roundtable");
  await page.getByTestId("timeline-open-detail").click();
  await expect(drawer(page).getByTestId("run-detail")).toBeVisible();
  await drawer(page).getByTestId("run-member-row").filter({ hasText: "Bob" }).click();
  await expect(drawer(page).getByTestId("run-selected-member")).toHaveAttribute("data-member-turn-id", "turn_reviewer");
  await expect(drawer(page).getByTestId("run-stop-member")).toHaveCount(0);
});
