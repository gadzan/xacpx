import type { Page } from "@playwright/test";
import { expect, test, loginAndShowInstances } from "./fixtures";

/** The tag the mobile back stack writes on every history entry it owns. */
interface BackTag {
  layer: string;
  id: string;
  depth: number;
}

/** The tag on the current history entry, or null when it is not one of ours. */
async function backTag(page: Page): Promise<BackTag | null> {
  return page.evaluate(() => {
    const state: unknown = window.history.state;
    if (typeof state !== "object" || state === null || !("xacpx" in state)) return null;
    const raw: unknown = state.xacpx;
    if (typeof raw !== "object" || raw === null) return null;
    if (!("layer" in raw) || typeof raw.layer !== "string") return null;
    if (!("id" in raw) || typeof raw.id !== "string") return null;
    if (!("depth" in raw) || typeof raw.depth !== "number") return null;
    return { layer: raw.layer, id: raw.id, depth: raw.depth };
  });
}

// Mobile back navigation (§H): the top bar's ←, the iOS Safari left-edge swipe and the
// Android back key share one browser history stack, so `page.goBack()` (the system
// gesture) and the ← button must behave identically. Desktop is asserted by the
// chromium-desktop project and adds no entries at all.
test.describe("mobile back navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));
  });

  test("opening and closing an overlay repeatedly leaves no dead entry; one back returns home", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
    await loginAndShowInstances(page);
    await page.getByTestId("session-row").first().getByTestId("session-name").click();
    await expect(page.getByTestId("mobile-session-bar")).toBeVisible();

    for (let i = 0; i < 3; i++) {
      await page.getByTestId("mobile-more").click();
      await expect(page.getByTestId("mobile-more-sheet")).toBeVisible();
      // Close through the sheet's own X: the entry is popped, not left behind.
      await page.getByTestId("sheet-close").click();
      await expect(page.getByTestId("mobile-more-sheet")).toHaveCount(0);
    }
    // Only the pane entry remains, so a single system back returns home.
    await page.goBack();
    await expect(page.getByTestId("mobile-session-bar")).toHaveCount(0);
    await expect(page.getByTestId("fab-new-session")).toBeVisible();
    expect(await backTag(page)).toBeNull();
  });

  test("an overlay on a full-screen layer closes one layer per back", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
    await loginAndShowInstances(page);
    await page.getByTestId("session-row").first().getByTestId("session-name").click();
    await expect(page.getByTestId("mobile-session-bar")).toBeVisible();

    // Full-screen layer: a terminal center tab, opened from the ⋯ sheet.
    await page.getByTestId("mobile-more").click();
    await page.getByTestId("sheet-terminal").click();
    await expect(page.getByTestId("terminal-host")).toBeVisible({ timeout: 20_000 });
    expect((await backTag(page))?.layer).toBe("full");

    // Overlay stacked on top of it: the top bar stays reachable above a center tab.
    await page.getByTestId("mobile-more").click();
    await expect(page.getByTestId("mobile-more-sheet")).toBeVisible();
    expect((await backTag(page))?.layer).toBe("modal");

    // Back #1: the sheet closes, the terminal stays.
    await page.goBack();
    await expect(page.getByTestId("mobile-more-sheet")).toHaveCount(0);
    await expect(page.getByTestId("terminal-host")).toBeVisible();
    // Back #2: the center tab falls back to the chat tab (the tab itself stays open,
    // only hidden — v-show keeps every open tab mounted).
    await page.goBack();
    await expect(page.getByTestId("terminal-host")).toBeHidden();
    await expect(page.getByTestId("mobile-session-bar")).toBeVisible();
    // Back #3: home.
    await page.goBack();
    await expect(page.getByTestId("mobile-session-bar")).toHaveCount(0);
    await expect(page.getByTestId("fab-new-session")).toBeVisible();
    expect(await backTag(page)).toBeNull();
  });

  test("deep-link cold start: ← returns home instead of leaving the site", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
    await page.goto("/?instanceId=i1&sessionAlias=demo", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("mobile-session-bar")).toBeVisible({ timeout: 30_000 });
    // The deep-link query is cleared and a home entry sits below the pane entry.
    expect(new URL(page.url()).search).toBe("");
    expect(await backTag(page)).toEqual({ layer: "pane", id: "chat:i1::demo", depth: 1 });

    await page.getByTestId("mobile-back").click();
    await expect(page.getByTestId("mobile-session-bar")).toHaveCount(0);
    await expect(page.getByTestId("fab-new-session")).toBeVisible();
    expect(await backTag(page)).toBeNull();
    expect(new URL(page.url()).search).toBe("");
  });

  test("a dialog with a bottom sheet on top closes one layer per back", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
    await loginAndShowInstances(page);
    // One online instance: the FAB opens the new-session dialog directly.
    await page.getByTestId("fab-new-session").click();
    const dialog = page.getByTestId("new-session-dialog");
    await expect(dialog).toBeVisible();
    expect((await backTag(page))?.layer).toBe("modal");

    // A dropdown inside the dialog renders as a bottom sheet below lg.
    await page.getByTestId("ns-agent").click();
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(2);
    expect((await backTag(page))?.depth).toBe(2);

    // Back #1 closes only the sheet; the dialog stays.
    await page.goBack();
    await expect(page.locator('[role="dialog"]:visible')).toHaveCount(1);
    await expect(dialog).toBeVisible();

    // Back #2 closes the dialog and returns home.
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("fab-new-session")).toBeVisible();
    expect(await backTag(page)).toBeNull();
  });

  test("desktop adds no history entries", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "desktop viewport only");
    await loginAndShowInstances(page);
    await page.getByTestId("session-row").first().getByTestId("session-name").click();
    // The mobile bar stays in the DOM but is hidden at lg; it must own no entry.
    await expect(page.getByTestId("mobile-session-bar")).toBeHidden();
    const before = await page.evaluate(() => window.history.length);

    // Open the command palette (a masked overlay) and dismiss it with Escape.
    await page.getByTestId("global-search").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);

    expect(await backTag(page)).toBeNull();
    expect(await page.evaluate(() => window.history.length)).toBe(before);
  });
});
