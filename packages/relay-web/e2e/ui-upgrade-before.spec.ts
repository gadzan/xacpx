import type { Page } from "@playwright/test";
import { test, expect, loginAndShowInstances } from "./fixtures";

// The pack is only written when the caller names a directory. A relative default
// resolved against the config dir and dropped fake "before" images into
// packages/artifacts during a plain `playwright test` run.
const SHOTS = process.env.UI_SHOTS_DIR;
test.skip(!SHOTS, "set UI_SHOTS_DIR to record the evidence pack");
const THEME = process.env.UI_THEME ?? "light";
const createdAt = "2026-11-07T00:00:00.000Z";
const bot = { id: "b1", name: "Direct Bot", agent: "codex", workspace: "repo", enabled: true, profileRevision: 1, createdAt, updatedAt: createdAt };

async function setTheme(page: Page): Promise<void> {
  await page.addInitScript((theme: string) => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", theme);
  }, THEME);
}

async function rpc(page: Page, handlers: Record<string, unknown>): Promise<void> {
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    if (type in handlers) {
      await route.fulfill({ json: { result: handlers[type] } });
      return;
    }
    return route.fallback();
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  console.log(`shot ${name} dpr=${dpr}`);
}

function directHandlers(withMessages: boolean): Record<string, unknown> {
  const messages = withMessages ? [{
    id: "m1", conversationId: "c1", topicId: "t1", seq: 1, role: "human",
    content: "Review the release:\n\n```ts\nif (a !== b) { ship(); }\n```",
    createdAt,
  }] : [];
  return {
    "control.bots.list": { bots: [bot] },
    "control.bots.get": { bot },
    "control.conversations.list": { conversations: [{ id: "c1", kind: "bot", title: bot.name, botIds: [bot.id], defaultTopicId: "t1", createdAt, updatedAt: createdAt }] },
    "control.topics.list": { topics: [{ id: "t1", conversationId: "c1", title: "Default", status: "active", defaultDirect: true, createdAt, updatedAt: createdAt }] },
    "control.conversation.history": { conversationId: "c1", topicId: "t1", messages, hasMoreBefore: false, hasMoreAfter: false },
    "control.conversation.timeline": {
      conversationId: "c1", topicId: "t1",
      entries: messages.map((m) => ({ kind: "message", key: `message:${m.id}`, anchorSeq: m.seq, message: m })),
      oldestSeq: 1, newestSeq: messages.length, hasMoreBefore: false, hasMoreAfter: false,
    },
    "control.runs.list": { runs: [] },
    "control.conversation.completions.get": {
      version: 1, scope: { conversationId: "c1", topicId: "t1", botId: "b1" }, revision: "r1",
      commands: { status: "ready", items: [{ name: "review", description: "Advertised by adapter" }] },
      mentions: { status: "ready", items: [] },
    },
  };
}

async function openDirect(page: Page, withMessages: boolean): Promise<void> {
  await rpc(page, directHandlers(withMessages));
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
}

test("01 home session list", async ({ page, hub }) => {
  await setTheme(page);
  await rpc(page, {});
  await loginAndShowInstances(page);
  await shot(page, `01-home-${THEME}`);
});

test("02 sidebar bots", async ({ page, hub }) => {
  await setTheme(page);
  const bots = [
    { id: "b1", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
    { id: "b2", name: "Bob", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  ];
  await rpc(page, { "control.bots.list": { bots } });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await expect(page.getByTestId("bot-row").first()).toBeVisible();
  await shot(page, `02-bots-${THEME}`);
});

test("03 direct with markdown and code", async ({ page, hub }) => {
  await setTheme(page);
  await openDirect(page, true);
  await expect(page.getByText("Review the release:").first()).toBeVisible();
  await shot(page, `03-direct-${THEME}`);
});

test("05 sidebar groups", async ({ page, hub }) => {
  await setTheme(page);
  const group = { id: "g1", kind: "group", title: "Team", botIds: ["lead"], leadBotId: "lead", createdAt, updatedAt: createdAt };
  await rpc(page, {
    "control.bots.list": { bots: [{ id: "lead", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt }] },
    "control.groups.list": { groups: [group] },
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await expect(page.getByTestId("group-row").first()).toBeVisible();
  await shot(page, `05-groups-${THEME}`);
});

test("08 settings page", async ({ page, hub }) => {
  await setTheme(page);
  await rpc(page, {});
  await loginAndShowInstances(page);
  await page.goto("/settings");
  await expect(page.getByText(/settings/i).first()).toBeVisible();
  await shot(page, `08-settings-${THEME}`);
});

test("09 login page forced", async ({ page, hub }) => {
  await page.addInitScript((theme: string) => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", theme);
  }, THEME);
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });
  await page.goto("/");
  await expect(page.getByTestId("token-input")).toBeVisible();
  await shot(page, `09-login-${THEME}`);
});

test("11 direct empty state", async ({ page, hub }) => {
  await setTheme(page);
  await openDirect(page, false);
  await expect(page.getByText("start a conversation with this bot").first()).toBeVisible();
  await shot(page, `11-empty-${THEME}`);
  // The data case: the agent advertises commands for this conversation+topic, so
  // the empty page grows starter chips (the no-data case is the shot above).
  hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "agent-commands",
      chatKey: "direct:c1:t1",
      sessionAlias: "s1",
      conversation: { conversationId: "c1", topicId: "t1", botId: "b1", runId: "", memberTurnId: "" },
      commands: [
        { name: "review", description: "Review the working tree" },
        { name: "ship", description: "Land the change" },
      ],
    },
  } as never);
  await expect(page.getByTestId("direct-empty-starters")).toBeVisible();
  await shot(page, `11-empty-starters-${THEME}`);
});

const gscope = { conversationId: "g_ui", topicId: "t_ui" };
const gbots = [
  { id: "lead", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "reviewer", name: "Bob", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const ggroup = {
  id: gscope.conversationId, kind: "group", title: "Lens team",
  botIds: gbots.map((b) => b.id), leadBotId: "lead", createdAt, updatedAt: createdAt,
};
const gtopic = {
  id: gscope.topicId, conversationId: gscope.conversationId,
  title: "Release review", status: "active", createdAt, updatedAt: createdAt,
};
const gturns = [
  { ...gscope, id: "turn_lead", runId: "run_ui", botId: "lead", batch: 1, memberIndex: 0, attempt: 1, origin: "roundtable", state: "completed", createdAt },
  { ...gscope, id: "turn_reviewer", runId: "run_ui", botId: "reviewer", batch: 1, memberIndex: 1, attempt: 1, origin: "roundtable", state: "failed", failureReason: "connector offline", createdAt },
];
const gdetail = {
  ...gscope, id: "run_ui", requestMessageId: "gm1", requestId: "req_ui", mode: "explicit",
  shape: "roundtable", rounds: 1, leadBotId: "lead", state: "running",
  profileRevision: 1, createdAt, startedAt: createdAt, memberTurns: gturns,
};
const gmessages = [
  { ...gscope, id: "gm1", seq: 1, role: "human", content: "Review the release", createdAt },
  { ...gscope, id: "gm2", seq: 2, role: "bot", senderBotId: "lead", memberTurnId: "turn_lead", runId: "run_ui", content: "Two risks: the lock and the rollback.", createdAt },
  {
    ...gscope, id: "gm3", seq: 3, role: "system", senderBotId: "lead",
    memberTurnId: "turn_lead", runId: "run_ui", content: "",
    handoff: { senderMemberTurnId: "turn_lead", to: "reviewer", assignmentId: "a1", memberTurnId: "turn_reviewer", task: "Check the session lock" },
    createdAt,
  },
];

async function openGroup(page: Page): Promise<void> {
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots: gbots }; break;
      case "control.groups.list": result = { groups: [ggroup] }; break;
      case "control.groups.get": result = { group: { ...ggroup, topics: [gtopic] } }; break;
      case "control.topics.list": result = { topics: [gtopic] }; break;
      case "control.conversation.history": result = { ...gscope, messages: gmessages, oldestSeq: 1, newestSeq: 3, hasMoreBefore: false, hasMoreAfter: false }; break;
      case "control.conversation.timeline": result = {
        ...gscope,
        entries: gmessages.map((m) => ({ kind: "message", key: `message:${m.id}`, anchorSeq: m.seq, message: m })),
        activeRound: { runId: "run_ui", roundIndex: 1, rounds: 1, speakerCount: 2, spoken: 1, passed: 0, activeMemberTurnId: "turn_reviewer", state: "running" },
        oldestSeq: 1, newestSeq: 3, hasMoreBefore: false, hasMoreAfter: false,
      }; break;
      case "control.runs.list": result = { ...gscope, runs: [gdetail], activeRunId: gdetail.id, activeRun: gdetail }; break;
      case "control.runs.get": result = { run: gdetail }; break;
      case "control.runs.details.batch": result = { runs: [gdetail], missingRunIds: [] }; break;
      case "control.runs.trace.get": result = { memberTurnId: "turn_reviewer", attempt: 1, recordingState: "recording", events: [], nextSeq: 0, hasMore: false, attempts: [1], plan: [] }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
}

test("06 group timeline with handoff and stop all", async ({ page, hub }) => {
  await setTheme(page);
  await openGroup(page);
  await expect(page.getByTestId("conversation-stop-all")).toBeVisible();
  await shot(page, `06-group-${THEME}`);
});

test("07 run detail drawer", async ({ page, hub }) => {
  await setTheme(page);
  await openGroup(page);
  await page.getByTestId("timeline-open-detail").first().click();
  const drawer = page.getByTestId("group-detail-card").or(page.getByTestId("group-detail-sheet"));
  await expect(drawer).toBeVisible();
  await shot(page, `07-drawer-${THEME}`);
});
