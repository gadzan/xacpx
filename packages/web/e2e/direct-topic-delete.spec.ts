import { test, expect, loginAndShowInstances } from "./fixtures";

const bot = {
  id: "b1",
  name: "Direct Bot",
  agent: "codex",
  workspace: "repo",
  enabled: true,
  profileRevision: 1,
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T00:00:00Z",
};

test("deleting an extra Bot topic removes its row and lands on the default", async ({ page }, info) => {
  const mobile = info.project.name.includes("mobile");
  const openTopics = async () => {
    if (mobile) {
      await page.getByTestId("mobile-bot-more").click();
      await page.getByTestId("sheet-bot-topic").click();
    } else {
      await page.getByTestId("topic-menu").click();
    }
  };
  await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));
  let topics = [
    {
      id: "t1",
      conversationId: "c1",
      title: "Default",
      status: "active",
      defaultDirect: true,
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    },
    {
      id: "t2",
      conversationId: "c1",
      title: "Release notes",
      status: "active",
      createdAt: bot.createdAt,
      updatedAt: bot.updatedAt,
    },
  ];
  const teardownRequests: unknown[] = [];
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON() as { type: string; payload?: Record<string, unknown> };
    let result: unknown;
    switch (type) {
      case "control.bots.list":
        result = { bots: [bot] };
        break;
      case "control.bots.get":
        result = { bot };
        break;
      case "control.conversations.list":
        result = {
          conversations: [{
            id: "c1",
            kind: "bot",
            title: bot.name,
            botIds: [bot.id],
            defaultTopicId: "t1",
            createdAt: bot.createdAt,
            updatedAt: bot.updatedAt,
          }],
        };
        break;
      case "control.topics.list":
        result = { topics };
        break;
      case "control.topics.preview":
        result = {
          impact: {
            topic: topics.find((topic) => topic.id === payload?.topicId),
            bindings: [],
            unsettledRunIds: [],
            indeterminateRunIds: [],
            abandonableRunIds: [],
            worktreeRunIds: [],
            actions: { rename: true, archive: true, restore: false, teardown: true, clear: false },
          },
        };
        break;
      case "control.topics.teardown":
        teardownRequests.push(payload);
        topics = topics.filter((topic) => topic.id !== payload?.topicId);
        result = { ok: true, requestId: String(payload?.requestId ?? "") };
        break;
      case "control.conversation.history":
        result = {
          conversationId: "c1",
          topicId: payload?.topicId,
          messages: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
        };
        break;
      case "control.runs.list":
        result = { runs: [] };
        break;
      default:
        return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });

  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();

  await openTopics();
  await expect(page.getByTestId("topic-row")).toHaveCount(2);
  await page.getByTestId("topic-row").filter({ hasText: "Release notes" }).getByTestId("topic-row-more").click();
  await page.getByTestId("menu-delete").click();
  await expect(page.getByTestId("topic-confirm")).toBeVisible();
  // A pointerdown on the confirm must not be treated as an outside click on
  // the topic sheet: the sheet's history pop would otherwise close the confirm
  // before the click is delivered.
  await page.getByTestId("topic-confirm-submit").dispatchEvent("pointerdown");
  await expect(page.getByTestId("topic-confirm")).toBeVisible();
  await page.getByTestId("topic-confirm-submit").click();

  await expect(page.getByTestId("topic-confirm")).toHaveCount(0);
  expect(teardownRequests).toHaveLength(1);
  expect(topics.map((topic) => topic.id)).toEqual(["t1"]);

  // The sheet may close on submit; reopening must show only the survivor.
  await openTopics();
  await expect(page.getByTestId("topic-row")).toHaveCount(1);
  await expect(page.getByTestId("topic-row")).toContainText("Default");
});
