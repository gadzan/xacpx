import { test, expect } from "./fixtures";

/**
 * Code is read, not typeset. Ligatures join `!==`, `->` and `>=` into
 * glyphs that read as a single character. One rule turns them off for every
 * mono surface, so this asserts the computed result on the real markdown
 * renderer rather than the source text.
 *
 * The host running these tests has no ligature-capable mono installed (no
 * JetBrains Mono), so a pixel-width comparison of `!==` would pass with or
 * without the rule. The computed `font-variant-ligatures` is the assertion
 * that survives.
 */
const createdAt = "2026-11-07T00:00:00.000Z";
const bot = { id: "b1", name: "Direct Bot", agent: "codex", workspace: "repo", enabled: true, profileRevision: 1, createdAt, updatedAt: createdAt };
const tick = String.fromCharCode(96);

test("code blocks and inline code disable ligatures", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("relay-locale", "en"); localStorage.setItem("relay-theme", "light"); });
  const content = [
    `Inline ${tick}if (a !== b)${tick} here:`,
    "",
    `${tick}${tick}${tick}ts`,
    "if (a !== b) { ship(); }",
    `${tick}${tick}${tick}`,
  ].join("\n");

  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    const message = { id: "m1", conversationId: "c1", topicId: "t1", seq: 1, role: "human", content, createdAt };
    const results: Record<string, unknown> = {
      "control.bots.list": { bots: [bot] },
      "control.bots.get": { bot },
      "control.conversations.list": { conversations: [{ id: "c1", kind: "bot", title: bot.name, botIds: [bot.id], defaultTopicId: "t1", createdAt, updatedAt: createdAt }] },
      "control.topics.list": { topics: [{ id: "t1", conversationId: "c1", title: "Default", status: "active", defaultDirect: true, createdAt, updatedAt: createdAt }] },
      "control.conversation.history": { conversationId: "c1", topicId: "t1", messages: [message], hasMoreBefore: false, hasMoreAfter: false },
      "control.conversation.timeline": {
        conversationId: "c1", topicId: "t1",
        entries: [{ kind: "message", key: "message:m1", anchorSeq: 1, message }],
        oldestSeq: 1, newestSeq: 1, hasMoreBefore: false, hasMoreAfter: false,
      },
      "control.conversation.completions.get": { status: "ready", commands: { items: [] }, topics: [] },
    };
    if (type in results) return route.fulfill({ json: { result: results[type] } });
    return route.fallback();
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("session-row").first().waitFor({ timeout: 30_000 });
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();

  const block = page.locator(".stream-md pre code").first();
  await expect(block).toBeVisible();
  await expect(page.locator(".stream-md p code").first()).toBeVisible();

  for (const selector of [".stream-md pre code", ".stream-md p code"]) {
    await expect(page.locator(selector).first()).toHaveCSS("font-variant-ligatures", "none");
  }
});
