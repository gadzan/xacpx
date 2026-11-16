import type { Page } from "@playwright/test";
import { test, expect, loginAndShowInstances } from "./fixtures";

/**
 * The Group composer's @-mention list is rendered by the shared CompletionList
 * (WP-11). It is a plain suggestion list — the Group textarea is not a combobox
 * — so the rows are buttons with the member chips, and the desktop popover
 * closes on Escape and on an outside pointerdown like every other dropdown.
 */
const createdAt = "2026-11-01T00:00:00Z";
const scope = { conversationId: "group_completions", topicId: "topic_completions", createdAt };
const bots = [
  { id: "lead", name: "Lead", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = {
  id: scope.conversationId, kind: "group", title: "Mention team",
  botIds: bots.map((bot) => bot.id), leadBotId: "lead",
  defaultRouting: "lead", createdAt, updatedAt: createdAt,
};
const topic = { id: scope.topicId, conversationId: scope.conversationId, title: "Round", status: "active", createdAt, updatedAt: createdAt };

async function openGroup(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversations.router.get": result = { status: "ready", configPath: "conversations.router" }; break;
      case "control.conversation.history":
        result = { ...scope, messages: [], oldestSeq: 0, newestSeq: 0, hasMoreBefore: false, hasMoreAfter: false };
        break;
      case "control.runs.list": result = { runs: [], conversationId: scope.conversationId, topicId: scope.topicId }; break;
      case "control.conversation.timeline":
        result = { ...scope, entries: [], oldestSeq: 0, newestSeq: 0, hasMoreBefore: false, hasMoreAfter: false };
        break;
      case "control.conversation.completions.get":
        result = {
          version: 1, scope: { ...scope, botId: "lead" }, revision: "r1",
          commands: { status: "ready", items: [{ name: "review", description: "Advertised by adapter" }] },
          mentions: { status: "ready", items: [], nextCursor: undefined },
        };
        break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
}

test("the Group mention list offers members, then closes on Escape and outside click", async ({ page }, info) => {
  await openGroup(page);
  const input = page.getByTestId("group-composer-textarea");
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.click();
  await input.fill("@");

  const rows = page.getByTestId("group-mention-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("@Lead");
  // The chips: the lead marker, the member's role slot, the stable bot id.
  await expect(page.getByTestId("group-mention-menu")).toContainText("Lead");
  await expect(rows.first()).toHaveAttribute("data-bot-id", "lead");
  await expect(rows.first()).not.toHaveAttribute("role", "option");

  await input.press("Escape");
  await expect(page.getByTestId("group-mention-menu")).toHaveCount(0);
  await expect(input).toHaveValue("@");

  // Escape keeps the draft; the same list re-opens from a fresh keystroke.
  await input.fill("@t");
  await expect(page.getByTestId("group-mention-item")).toHaveCount(1);
  await expect(page.getByTestId("group-mention-item")).toContainText("@Tester");

  // An outside pointerdown dismisses the desktop popover without clearing text.
  // Below lg the list lives in a sheet whose scrim / back gesture closes it.
  if (!info.project.name.includes("mobile")) {
    await page.mouse.click(760, 160);
    await expect(page.getByTestId("group-mention-menu")).toHaveCount(0);
    await expect(input).toHaveValue("@t");
  }
});
