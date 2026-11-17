import { test, expect, loginAndShowInstances } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The desktop shell is two rows: the global bar (brand, connection, center tabs, search)
 * and the open pane's content bar. This spec pins that shape on the real app, because the
 * failure it guards is a third band quietly reappearing above the transcript.
 */
test.describe("desktop header layout", () => {
  test.skip(({ isMobile }) => isMobile === true, "desktop shell only");

  async function openSession(page: Page): Promise<void> {
    await loginAndShowInstances(page);
    await page.getByTestId("session-row").first().click();
    await expect(page.getByTestId("chat-body")).toBeVisible({ timeout: 30_000 });
  }

  test("stacks exactly two rows above the transcript and keeps the brand in the global bar", async ({ page }) => {
    await openSession(page);

    const bar = page.getByTestId("global-bar");
    await expect(bar.getByTestId("global-brand")).toBeVisible();
    await expect(bar.getByTestId("tab-chat")).toBeVisible();
    await expect(bar.getByTestId("global-search")).toBeVisible();
    await expect(page.locator('[data-test="sidebar-brand"]')).toHaveCount(0);

    const rows = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('[data-test="global-bar"]')!;
      const content = document.querySelector<HTMLElement>("[data-conversation-header]")!;
      const body = document.querySelector<HTMLElement>('[data-test="chat-body"]')!;
      return {
        headerBottom: Math.round(header.getBoundingClientRect().bottom),
        contentTop: Math.round(content.getBoundingClientRect().top),
        contentBottom: Math.round(content.getBoundingClientRect().bottom),
        bodyTop: Math.round(body.getBoundingClientRect().top),
      };
    });
    expect(rows.contentTop).toBe(rows.headerBottom);
    expect(rows.bodyTop).toBe(rows.contentBottom);
  });

  test("shows the connection as a dot while online and expands it when the socket drops", async ({ page, hub }) => {
    await openSession(page);

    const label = page.getByTestId("conn-badge").locator("span").last();
    await expect(label).toBeHidden();

    await hub.closeSockets();
    await hub.stopAccepting();
    await expect(label).toBeVisible({ timeout: 30_000 });
    await expect(label).toHaveText(/reconnect/i);
  });

  test("keeps the session actions in the content bar and aligns the right title row with it", async ({ page }) => {
    await openSession(page);

    const contentBar = page.locator("[data-conversation-header]");
    const terminal = contentBar.getByTestId("toggle-terminal");
    await expect(terminal).toBeVisible();
    await expect(terminal).toBeEnabled();
    await expect(page.getByTestId("global-bar").getByTestId("toggle-terminal")).toHaveCount(0);
    await expect(contentBar.getByTestId("toggle-desktop")).toBeEnabled();

    const edges = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>("[data-conversation-header]")!;
      const tab = document.querySelector<HTMLElement>('[data-test="right-tab-files"]')!;
      return {
        contentBottom: Math.round(content.getBoundingClientRect().bottom),
        rightBottom: Math.round(tab.closest("div")!.getBoundingClientRect().bottom),
      };
    });
    expect(edges.rightBottom).toBe(edges.contentBottom);

    await terminal.click();
    await expect(page.getByTestId("terminal-host")).toBeVisible({ timeout: 30_000 });
  });

  // ChatPane stays mounted behind the Bot pane and its slot is the desktop home of the
  // actions, so a missing gate there yields two `toggle-terminal` nodes and an ambiguous
  // locator for every consumer.
  test("a Bot view keeps exactly one copy of the session actions", async ({ page }) => {
    const bot = { id: "b1", name: "Review assistant", agent: "codex", workspace: "repo", enabled: true, profileRevision: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" };
    await page.route("**/api/instances/i1/rpc", async (route) => {
      const { type } = route.request().postDataJSON() as { type: string };
      const results: Record<string, unknown> = {
        "control.bots.list": { bots: [bot] },
        "control.bots.get": { bot },
        "control.conversations.list": {
          conversations: [{ id: "c1", kind: "bot", title: bot.name, botIds: [bot.id], defaultTopicId: "t1", createdAt: bot.createdAt, updatedAt: bot.updatedAt }],
        },
        "control.topics.list": {
          topics: [{ id: "t1", conversationId: "c1", title: "Default", status: "active", defaultDirect: true, createdAt: bot.createdAt, updatedAt: bot.updatedAt }],
        },
        "control.conversation.history": { conversationId: "c1", topicId: "t1", messages: [], hasMoreBefore: false, hasMoreAfter: false },
        "control.runs.list": { runs: [] },
      };
      if (!(type in results)) return route.fallback();
      await route.fulfill({ json: { result: results[type] } });
    });

    await loginAndShowInstances(page);
    await page.getByTestId("instance-nav-bots").click();
    await page.getByTestId("bot-row").first().getByRole("button").first().click();
    await expect(page.getByTestId("topic-menu")).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId("toggle-terminal")).toHaveCount(1);
    await expect(page.locator("[data-conversation-header]").getByTestId("toggle-terminal")).toHaveCount(1);
  });
});
