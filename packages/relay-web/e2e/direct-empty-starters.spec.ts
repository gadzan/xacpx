import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * An empty Bot page names the Bot it belongs to and offers starter chips
 * from the agent's own advertisement. Two cases, both on the real app:
 *   - advertised commands  -> chips, and a tap only fills the composer
 *   - no advertisement     -> no chips, no invented commands, just the hint
 */
const bot = {
  id: "b1",
  name: "Direct Bot",
  agent: "codex",
  workspace: "repo",
  enabled: true,
  profileRevision: 1,
  createdAt: "2026-10-11T00:00:00Z",
  updatedAt: "2026-10-11T00:00:00Z",
};

async function openEmptyBot(page: import("@playwright/test").Page): Promise<string[]> {
  const prompts: string[] = [];
  await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
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
        result = {
          topics: [{
            id: "t1",
            conversationId: "c1",
            title: "Default",
            status: "active",
            defaultDirect: true,
            createdAt: bot.createdAt,
            updatedAt: bot.updatedAt,
          }],
        };
        break;
      case "control.conversation.history":
        result = { conversationId: "c1", topicId: "t1", messages: [], hasMoreBefore: false, hasMoreAfter: false };
        break;
      case "control.runs.list":
        result = { runs: [] };
        break;
      case "control.conversation.prompt":
        prompts.push((payload as { text: string }).text);
        result = {};
        break;
      default:
        return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();
  await expect(page.locator('textarea[role="combobox"]')).toBeEnabled();
  return prompts;
}

test("empty Bot page offers the agent's advertised commands and a tap only fills", async ({ page, hub }) => {
  const prompts = await openEmptyBot(page);
  const empty = page.getByTestId("direct-empty");
  await expect(empty).toBeVisible();
  await expect(page.getByTestId("direct-empty-name")).toHaveText("Direct Bot");
  await expect(page.getByTestId("direct-empty-meta")).toHaveText("repo · codex");
  await expect(page.getByTestId("direct-empty-starters")).toHaveCount(0);

  // Exactly the advertisement the Hub relays for this conversation + topic.
  hub.send({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "agent-commands",
      chatKey: "direct:c1:t1",
      sessionAlias: "s1",
      // The web validator requires the whole correlation, empty ids included.
      conversation: { conversationId: "c1", topicId: "t1", botId: "b1", runId: "", memberTurnId: "" },
      commands: [
        { name: "review", description: "Review the working tree" },
        { name: "ship", description: "Land the change" },
      ],
    },
  } as never);
  const starters = page.getByTestId("direct-empty-starters");
  await expect(starters).toBeVisible();
  await expect(starters.getByRole("button")).toHaveText(["/review", "/ship"]);

  const input = page.locator('textarea[role="combobox"]');
  await starters.getByRole("button", { name: "/review" }).click();
  await expect(input).toHaveValue("/review ");
  expect(prompts).toHaveLength(0);
});

test("with no advertisement the empty page keeps the hint and invents nothing", async ({ page }) => {
  await openEmptyBot(page);
  await expect(page.getByTestId("direct-empty")).toBeVisible();
  await expect(page.getByTestId("direct-empty-starters")).toHaveCount(0);
  await expect(page.getByTestId("timeline-empty-hint")).toBeVisible();
});
