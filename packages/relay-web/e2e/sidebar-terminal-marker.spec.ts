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

async function showSidebar(page: import("@playwright/test").Page): Promise<void> {
  const open = page.getByTestId("open-instances");
  if (await open.isVisible().catch(() => false)) {
    await open.evaluate((el) => (el as HTMLElement).click());
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
    await page.getByTestId("tab-close").locator("visible=true").click();
    await expect(page.getByTestId("terminal-host")).toHaveCount(0);

    await showSidebar(page);
    await expect(demo.getByTestId("terminal-open-marker")).toHaveCount(0);
  });
});
