import { test, expect, loginAndOpenTerminal } from "./fixtures";

test.describe("sidebar terminal-open marker", () => {
  test("marks the session row once its Terminal tab is open", async ({ page }) => {
    await loginAndOpenTerminal(page);
    const row = page.getByTestId("session-row");
    if (!(await row.isVisible().catch(() => false))) {
      const open = page.getByTestId("open-instances");
      if (await open.isVisible().catch(() => false)) {
        await open.evaluate((el) => (el as HTMLElement).click());
      }
    }
    await expect(row).toBeVisible();
    await expect(row.getByTestId("terminal-open-marker")).toBeVisible();
    await expect(row.getByTestId("terminal-open-marker")).toHaveAttribute("title", /.+/);
  });
});
