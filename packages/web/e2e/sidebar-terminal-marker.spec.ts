import { test as base, expect, loginAndOpenTerminal } from "./fixtures";
import { startMockHub, SESSION_ALIAS } from "./mock-hub";

const OTHER_ALIAS = "other";

const test = base.extend({
  hub: async ({}, use) => {
    const hub = await startMockHub({ extraAliases: [OTHER_ALIAS] });
    await use(hub);
    await hub.close();
  },
});

/** Desktop: the sidebar is always there. Mobile: ← back to the home list. One back
 *  closes one layer (an open overlay or full-screen tab first), and the button is
 *  disabled while a back is in flight, so each click waits for the previous one to
 *  land. The loop ends when the button is gone, i.e. the home list is the content. */
async function showSidebar(page: import("@playwright/test").Page): Promise<void> {
  const back = page.getByTestId("mobile-back");
  for (let i = 0; i < 4 && (await back.isVisible().catch(() => false)); i++) {
    await back.click();
  }
}

function sessionRow(page: import("@playwright/test").Page, alias: string) {
  return page.getByTestId("session-row").filter({
    has: page.getByTestId("session-name").filter({ hasText: new RegExp(`^${alias}$`) }),
  });
}

test.describe("sidebar terminal-open marker", () => {
  test("marks the session row once its Terminal tab is open", async ({ page }) => {
    await loginAndOpenTerminal(page);
    await showSidebar(page);
    const row = sessionRow(page, SESSION_ALIAS);
    await expect(row).toBeVisible();
    await expect(row.getByTestId("terminal-open-marker")).toBeVisible();
    await expect(row.getByTestId("terminal-open-marker")).toHaveAttribute("title", /.+/);
  });

  test("keeps the marker after switching sessions and drops it when the Terminal tab is closed", async ({ page }) => {
    await loginAndOpenTerminal(page);
    await showSidebar(page);
    const demo = sessionRow(page, SESSION_ALIAS);
    const other = sessionRow(page, OTHER_ALIAS);
    await expect(demo.getByTestId("terminal-open-marker")).toBeVisible();
    await expect(other.getByTestId("terminal-open-marker")).toHaveCount(0);

    await other.getByTestId("session-name").evaluate((el) => (el as HTMLElement).click());
    await showSidebar(page);
    await expect(demo.getByTestId("terminal-open-marker")).toBeVisible();
    await expect(other.getByTestId("terminal-open-marker")).toHaveCount(0);

    await demo.getByTestId("session-name").evaluate((el) => (el as HTMLElement).click());
    page.once("dialog", (dialog) => dialog.accept());
    if (test.info().project.name === "chromium-mobile") {
      // Mobile has no tab strip: open tabs are closed from the ⋯ sheet's open-tabs list.
      await page.getByTestId("mobile-more").click();
      await page.getByTestId("sheet-open-tabs").click();
      await page.getByTestId("open-tab-close").first().click();
      await expect(page.getByTestId("terminal-host")).toHaveCount(0);
      await page.getByTestId("sheet-close").click(); // the open-tabs sheet stays up after a close
    } else {
      await page.getByTestId("tab-close").locator("visible=true").click();
    }
    await expect(page.getByTestId("terminal-host")).toHaveCount(0);

    await showSidebar(page);
    await expect(demo.getByTestId("terminal-open-marker")).toHaveCount(0);
  });
});
