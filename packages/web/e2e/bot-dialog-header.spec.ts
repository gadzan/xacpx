import { expect, test, loginAndShowInstances, settleDialog } from "./fixtures";

// The bot dialog header used to be a 56px avatar with the name stacked under
// it, and the appearance badge painted a dark ring over every avatar. Both are
// measured as boxes here, so a restyle that reintroduces either fails.

async function openNewBot(page: import("@playwright/test").Page): Promise<void> {
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").first().click();
  await page.getByTestId("new-bot-button").first().click();
  await expect(page.getByTestId("bot-avatar-quick-view")).toBeVisible();
  // Every box below is measured inside the dialog panel, which is scaled by 2%
  // while it arrives — measure after it settles.
  await settleDialog(page);
}

test("bot dialog header: the avatar leads, name and role stack beside it at its height", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "chromium-mobile";
  await openNewBot(page);

  const m = await page.evaluate(() => {
    const avatar = [...document.querySelectorAll('[data-test="bot-avatar-quick-view"] [data-test="bot-avatar"]')]
      .find((el) => el.getClientRects().length > 0)!.getBoundingClientRect();
    const badge = document.querySelector('[data-test="bot-avatar-edit"]')!;
    const name = document.getElementById("bot-name")!.getBoundingClientRect();
    const column = document.getElementById("bot-name")!.closest("div.min-w-0")!.getBoundingClientRect();
    const dialog = document.getElementById("bot-name")!.closest('[role="dialog"]')!.getBoundingClientRect();
    return {
      avatar: { w: avatar.width, h: avatar.height, right: avatar.right, bottom: avatar.bottom, cx: avatar.left + avatar.width / 2 },
      dialogCx: dialog.left + dialog.width / 2,
      badgeRing: getComputedStyle(badge).boxShadow,
      fields: { left: name.left, top: name.top, height: column.height },
    };
  });

  // The pencil badge reads as a flat chip. The old `ring-border` painted a dark
  // 1px outline (`0 0 0 1px`) over every avatar; a soft drop shadow is fine.
  expect(m.badgeRing).not.toContain("0px 0px 0px 1px");

  if (mobile) {
    // Centered above the fields, enlarged from the old 56px.
    expect(m.avatar.w).toBe(96);
    expect(Math.abs(m.avatar.cx - m.dialogCx)).toBeLessThanOrEqual(1);
    expect(m.fields.top).toBeGreaterThanOrEqual(m.avatar.bottom);
  } else {
    // Beside the fields, the two stacked inputs spanning the avatar's height.
    expect(m.avatar.w).toBe(128);
    expect(m.fields.left - m.avatar.right).toBeCloseTo(20, 0);
    expect(Math.abs(m.fields.height - m.avatar.h)).toBeLessThanOrEqual(1);
  }
});
