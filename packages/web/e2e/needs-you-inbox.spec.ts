import type { Page } from "@playwright/test";
import { expect, test, loginAndShowInstances } from "./fixtures";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";

/**
 * UX1 cross-instance "Needs you" inbox, driven through the app's real socket
 * path: the mock hub delivers `interaction-opened` / `interaction-closed`
 * frames as relay envelopes over /ws, exactly as the production hub does, so
 * the store handler, the badge, the list, and the forms are the shipped ones.
 */
const INSTANCE = "i1";

const BOT = {
  id: "bot-e2e", name: "Reviewer", agent: "codex", workspace: "/w",
  enabled: true, updatedAt: "2026-10-11T00:00:00Z", profileRevision: 1,
};
const GROUP = {
  id: "group-e2e", kind: "group", title: "Release Team",
  botIds: ["bot-e2e"], leadBotId: "bot-e2e",
  createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z",
};

function interaction(
  requestId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    requestId,
    kind: "elicitation",
    expiresAt: Date.now() + 120_000,
    elicitation: {
      mode: "form",
      agent: { name: "codex" },
      message: "Approve deploy to staging?\nThis second line stays in the form.",
      fields: [{ kind: "text", key: "note", title: "Note", required: false }],
    },
    ...over,
  };
}

/**
 * Re-deliver a frame until the page reflects it.
 *
 * The mock hub broadcasts to whatever sockets are open at that instant, and the
 * browser's reconnect cycle can drop them for a moment; a frame sent into that
 * gap is lost (a real hub re-declares the open set on the next snapshot, the
 * mock does not). Re-sending is safe for every frame this spec uses: the store
 * merges a duplicate open by requestId (draft kept) and ignores a close for an
 * already-retired request.
 */
async function deliver(
  hub: { send: (e: WebServerEvent) => void },
  event: WebServerEvent,
  settled: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    hub.send(event);
    if (await settled()) return;
    if (Date.now() > deadline) throw new Error("frame never settled in the page");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** The page shows this count in the header badge (0 when the badge is absent). */
async function badgeCount(page: Page): Promise<number> {
  const badge = page.getByTestId("needs-you-count");
  if ((await badge.count()) === 0) return 0;
  return Number((await badge.innerText()).trim());
}

/** The panel shows this many rows (the sheet or the popover, whichever mounted). */
async function rowCount(page: Page): Promise<number> {
  return page.getByTestId("needs-you-row").count();
}

function opened(entry: Record<string, unknown>, sessionAlias = ""): WebServerEvent {
  return {
    kind: "control-event",
    instanceId: INSTANCE,
    event: { type: "interaction-opened", chatKey: "bot:c:t", sessionAlias, instanceId: INSTANCE, interaction: entry },
  } as unknown as WebServerEvent;
}

function closed(requestId: string): WebServerEvent {
  return {
    kind: "control-event",
    instanceId: INSTANCE,
    event: {
      // `sessionAlias` is REQUIRED by the browser's control-event validator: a
      // close frame without it is dropped before the store ever sees it.
      type: "interaction-closed", chatKey: "bot:c:t", sessionAlias: "demo",
      instanceId: INSTANCE, requestId, reason: "resolved", action: "accept",
    },
  } as unknown as WebServerEvent;
}

async function seedCatalogs(
  page: Page,
  hub: { setCatalogs: (c: { bots?: unknown[]; groups?: unknown[] }) => void },
): Promise<void> {
  // Before the dashboard's first catalog load, so the listing answers with the
  // rows the inbox names. No reload needed.
  hub.setCatalogs({ bots: [BOT], groups: [GROUP] });
  await loginAndShowInstances(page);
}

test("a session interaction on an unselected instance counts once and opens its session", async ({ page, hub }, testInfo) => {
  await loginAndShowInstances(page);
  expect(await page.getByTestId("needs-you-count").count()).toBe(0);
  await page.getByTestId("needs-you-button").click();
  await expect(page.getByTestId("needs-you-empty")).toHaveText("Nothing needs you right now.");
  // Desktop popover has its own ✕; the mobile sheet uses the shared sheet ✕.
  await page.getByTestId(testInfo.project.name === "chromium-mobile" ? "sheet-close" : "needs-you-close").click();
  await expect(page.getByTestId("needs-you-popover")).toHaveCount(0);
  await expect(page.getByTestId("needs-you-sheet")).toHaveCount(0);

  await deliver(hub, opened(interaction("req-session-1", { sessionAlias: "demo" }), "demo"), async () => (await badgeCount(page)) === 1);
  const badge = page.getByTestId("needs-you-count");
  await expect(badge).toHaveText("1");

  await page.getByTestId("needs-you-button").click();
  const row = page.getByTestId("needs-you-row").first();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("codex");
  await expect(row).toContainText("e2e-pc · Session demo");
  await expect(row).toContainText("Approve deploy to staging?");
  await expect(row).toContainText("left");
  // The row question is one line; the full multi-line message stays in the form.
  await expect(row).not.toContainText("This second line stays in the form.");
  await expect(page.getByTestId("interaction-form")).toContainText("This second line stays in the form.");

  await row.getByTestId("needs-you-open").click();
  // Mobile swaps the global bar for the single session bar; desktop keeps the
  // pane. Either one proves the session selection landed.
  if (testInfo.project.name === "chromium-mobile") {
    await expect(page.getByTestId("mobile-session-bar")).toBeVisible();
    await expect(page.getByTestId("needs-you-sheet")).toHaveCount(0);
  } else {
    await expect(page.getByTestId("chat-body")).toBeVisible();
    await expect(page.getByTestId("needs-you-popover")).toHaveCount(0);
  }
});

test("a duplicate open frame keeps one row and the user's draft", async ({ page, hub }) => {
  await loginAndShowInstances(page);
  await deliver(hub, opened(interaction("req-dup", { conversation: { conversationId: "conv-1", topicId: "topic-1", botId: BOT.id } })), async () => (await badgeCount(page)) === 1);
  await expect(page.getByTestId("needs-you-count")).toHaveText("1");
  await page.getByTestId("needs-you-button").click();
  const row = page.getByTestId("needs-you-row").first();
  await row.getByTestId("needs-you-select").click();
  const note = page.getByTestId("interaction-form").locator("input, textarea").first();
  await note.fill("draft from the inbox");

  await deliver(hub, opened(interaction("req-dup", { conversation: { conversationId: "conv-1", topicId: "topic-1", botId: BOT.id } })), async () => (await badgeCount(page)) === 1);
  await expect(page.getByTestId("needs-you-count")).toHaveText("1");
  await expect(page.getByTestId("needs-you-row")).toHaveCount(1);
  await expect(note).toHaveValue("draft from the inbox");
});

test("a close event removes the row and its badge count", async ({ page, hub }) => {
  await loginAndShowInstances(page);
  await deliver(hub, opened(interaction("req-close", { sessionAlias: "demo" }), "demo"), async () => (await badgeCount(page)) === 1);
  await expect(page.getByTestId("needs-you-count")).toHaveText("1");
  await page.getByTestId("needs-you-button").click();
  await expect(page.getByTestId("needs-you-row")).toHaveCount(1);
  await deliver(hub, closed("req-close"), async () => (await rowCount(page)) === 0);
  await expect(page.getByTestId("needs-you-row")).toHaveCount(0);
  await expect(page.getByTestId("needs-you-empty")).toBeVisible();
});

test("an expired interaction leaves the list and the badge without a close event", async ({ page, hub }) => {
  await loginAndShowInstances(page);
  // The hub only announces interactions whose window is still open; a deadline
  // that passes while the tab holds it must retire it client-side.
  await deliver(hub, opened(interaction("req-expiring", { expiresAt: Date.now() + 2_500, sessionAlias: "demo" }), "demo"), async () => (await badgeCount(page)) === 1);
  await expect(page.getByTestId("needs-you-count")).toHaveText("1");
  await page.getByTestId("needs-you-button").click();
  await expect(page.getByTestId("needs-you-row")).toHaveCount(1);
  await expect(page.getByTestId("needs-you-row")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("needs-you-empty")).toBeVisible();
  await expect(page.getByTestId("needs-you-count")).toHaveCount(0);
});

test("direct and group entries name their destination and never collide", async ({ page, hub }) => {
  await seedCatalogs(page, hub);
  await deliver(hub, opened(interaction("req-direct", { conversation: { conversationId: "conv-direct", topicId: "topic-d", botId: BOT.id } })), async () => (await badgeCount(page)) >= 1);
  await deliver(hub, opened(interaction("req-group", { conversation: { conversationId: GROUP.id, topicId: "topic-g", botId: BOT.id } })), async () => (await badgeCount(page)) === 2);
  await expect(page.getByTestId("needs-you-count")).toHaveText("2");
  await page.getByTestId("needs-you-button").click();
  const rows = page.getByTestId("needs-you-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Bot Reviewer");
  await expect(rows.nth(1)).toContainText("Group Release Team");
});

test("the closed-panel badge drops an expired count on its own clock", async ({ page, hub }) => {
  await loginAndShowInstances(page);
  await deliver(hub, opened(interaction("req-idle-expiry", { expiresAt: Date.now() + 2_500, sessionAlias: "demo" }), "demo"), async () => (await badgeCount(page)) === 1);
  // Never open the inbox: the header badge itself must re-count as time passes.
  await expect(page.getByTestId("needs-you-count")).toHaveText("1");
  await expect(page.getByTestId("needs-you-count")).toHaveCount(0, { timeout: 10_000 });
});

test("mobile 390px keeps the row and the form usable in the sheet", async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
  await loginAndShowInstances(page);
  await deliver(hub, opened(interaction("req-mobile", { sessionAlias: "demo" }), "demo"), async () => (await badgeCount(page)) === 1);
  await expect(page.getByTestId("needs-you-count")).toHaveText("1");
  await page.getByTestId("needs-you-button").click();
  await expect(page.getByTestId("needs-you-sheet")).toBeVisible();
  const row = page.getByTestId("needs-you-row").first();
  await expect(row).toBeVisible();
  await expect(page.getByTestId("interaction-form")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(overflow).toBe(true);
  // The row must fit the sheet it lives in (the sheet is the 390px surface).
  const sheet = await page.getByTestId("needs-you-sheet").boundingBox();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  expect(sheet).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(sheet!.x);
  expect(box!.x + box!.width).toBeLessThanOrEqual(sheet!.x + sheet!.width + 1);
});
