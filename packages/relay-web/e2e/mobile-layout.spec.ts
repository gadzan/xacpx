import { expect, test, loginAndShowInstances } from "./fixtures";

// Mobile layout (redesign PR4 §5.1 / §5.2 / §5.4 / §5.5). Desktop behaviour is asserted by
// the chromium-desktop project and the unit suites; these checks are viewport-specific, so
// they are skipped outside the mobile project.
test.describe("mobile layout", () => {
  test("session view keeps one 52px bar, drops the global header, and warns only after a connection drop", async ({ page, hub }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");

    await loginAndShowInstances(page);

    // Home (nothing selected): the instance tree is the main content, not a placeholder,
    // and the new-session FAB is present.
    await expect(page.getByTestId("fab-new-session")).toBeVisible();
    await expect(page.getByTestId("session-row").first()).toBeVisible();

    await page.getByTestId("session-row").first().getByTestId("session-name").click();
    const bar = page.getByTestId("mobile-session-bar");
    await expect(bar).toBeVisible();

    // (1) Everything above the transcript is the single bar: 52px + safe-area (0 in
    //     Chromium), and the global header (brand / search / theme / settings) is gone.
    const barBox = await bar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(53);
    await expect(page.getByTestId("global-search")).toBeHidden();
    await expect(page.getByTestId("settings-link")).toBeHidden();

    // (2) No connection strip while connected; one after the hub socket drops.
    //     Reconnects are refused so the offline state stays observable.
    await expect(page.getByTestId("conn-strip")).toHaveCount(0);
    await hub.closeSockets();
    await hub.stopAccepting();
    await expect(page.getByTestId("conn-strip")).toBeVisible();

    // (3) Touch targets: the bar's icon buttons and the sheet's close button are >= 40px,
    //     the composer's primary action is >= 44px.
    for (const id of ["open-instances", "mobile-more"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.width, id).toBeGreaterThanOrEqual(40);
      expect(box!.height, id).toBeGreaterThanOrEqual(40);
    }
    await page.getByTestId("mobile-more").click();
    await expect(page.getByTestId("mobile-more-sheet")).toBeVisible();
    const sheetClose = await page.getByTestId("sheet-close").boundingBox();
    expect(sheetClose!.width).toBeGreaterThanOrEqual(40);
    expect(sheetClose!.height).toBeGreaterThanOrEqual(40);
    // The open-tabs sheet is reachable and its rows are comfortable targets.
    await page.getByTestId("sheet-open-tabs").click();
    await expect(page.getByTestId("open-tabs-sheet")).toBeVisible();
    const chatRow = await page.getByTestId("open-tab-row").first().boundingBox();
    expect(chatRow!.height).toBeGreaterThanOrEqual(48);

    // (4) The composer textarea is 16px, so iOS does not auto-zoom on focus (pinch-zoom
    //     itself is allowed again — see index.html).
    const textarea = page.getByTestId("composer-send").locator("xpath=ancestor::form[1]").locator("textarea");
    const fontSize = await textarea.evaluate((el) => getComputedStyle(el).fontSize);
    expect(fontSize).toBe("16px");
    const send = await page.getByTestId("composer-send").boundingBox();
    expect(send!.width).toBeGreaterThanOrEqual(44);
    expect(send!.height).toBeGreaterThanOrEqual(44);
  });

  test("more sheet opens files and the workspace panel full-screen on mobile", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
    await loginAndShowInstances(page);
    await page.getByTestId("session-row").first().getByTestId("session-name").click();
    await expect(page.getByTestId("mobile-session-bar")).toBeVisible();

    await page.getByTestId("mobile-more").click();
    await page.getByTestId("sheet-workspace").click();
    // The right drawer is full-width on mobile, so the workspace panel covers the pane...
    const drawer = page.locator('[data-drawer="right"]');
    await expect(drawer).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = await drawer.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1);
    // ...and it lands on the files (tree) tab, not the changes diff.
    await expect(page.getByTestId("tab-files")).toBeVisible();
    await expect(page.getByTestId("tab-files")).toHaveClass(/text-accent/);
  });

  test("home FAB with one online instance opens the create dialog directly", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile viewport only");
    await loginAndShowInstances(page);
    // One online instance in the mock hub: the FAB creates directly (no picker sheet).
    await page.getByTestId("fab-new-session").click();
    await expect(page.getByTestId("new-session-dialog")).toBeVisible();
    await expect(page.getByTestId("fab-instance-sheet")).toHaveCount(0);
  });
});
