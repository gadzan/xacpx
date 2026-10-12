import { test, expect, loginAndShowInstances } from "./fixtures";
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
test("Direct cold slash and selected mention work by keyboard and touch without implicit sends", async ({
  page,
}, info) => {
  const prompts: Array<{
    requestId: string;
    text: string;
    agentMentions: unknown;
  }> = [];
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
          conversations: [
            {
              id: "c1",
              kind: "bot",
              title: bot.name,
              botIds: [bot.id],
              defaultTopicId: "t1",
              createdAt: bot.createdAt,
              updatedAt: bot.updatedAt,
            },
          ],
        };
        break;
      case "control.topics.list":
        result = {
          topics: [
            {
              id: "t1",
              conversationId: "c1",
              title: "Default",
              status: "active",
              defaultDirect: true,
              createdAt: bot.createdAt,
              updatedAt: bot.updatedAt,
            },
          ],
        };
        break;
      case "control.conversation.history":
        result = {
          conversationId: "c1",
          topicId: "t1",
          messages: [],
          hasMoreBefore: false,
          hasMoreAfter: false,
        };
        break;
      case "control.runs.list":
        result = { runs: [] };
        break;
      case "control.conversation.completions.get":
        result = {
          version: 1,
          scope: { conversationId: "c1", topicId: "t1", botId: "b1" },
          revision: "r1",
          commands: {
            status: "ready",
            items: [{ name: "review", description: "Advertised by adapter" }],
          },
          mentions: {
            status: "ready",
            items: [
              {
                handle: "agent:n:b2",
                displayName: "Peer",
                agent: "claude",
                workspace: "repo",
              },
            ],
          },
        };
        break;
      case "control.conversation.prompt":
        prompts.push(payload);
        result = { error: { code: "test-rejected", message: "Try again" } };
        break;
      default:
        return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  const nav = page.getByTestId("instance-nav-bots");
  const box = await nav.boundingBox();
  if (box && box.x < 0) await page.getByTestId("open-instances").click();
  await nav.click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();
  const input = page.locator('textarea[role="combobox"]');
  await expect(input).toBeEnabled();
  await expect(input).toBeInViewport();
  await input.fill("/re");
  await expect(page.getByRole("option")).toContainText("/review");
  expect(prompts).toHaveLength(0);
  await input.press("Tab");
  await expect(input).toHaveValue("/review ");
  expect(prompts).toHaveLength(0);
  await input.fill("😀 @");
  const peer = page.getByRole("option");
  await expect(peer).toContainText("Peer");
  if (info.project.name.includes("mobile")) await peer.tap();
  else await peer.click();
  await expect(input).toHaveValue("😀 @Peer ");
  await input.press("Enter");
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]?.text).toBe("😀 @Peer ");
  expect(prompts[0]?.agentMentions).toEqual([
    { range: [3, 8], handle: "agent:n:b2" },
  ]);
  await expect(input).toHaveValue("😀 @Peer ");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts[1]).toEqual(prompts[0]);
  await page.screenshot({ path: info.outputPath("direct-completion.png") });
});
