import { test, expect, loginAndShowInstances } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

async function openSession(page: Page): Promise<void> {
  await loginAndShowInstances(page);
  await page.locator('[data-test="session-row"]').first()
    .locator('[data-test="session-name"]')
    .evaluate((el) => (el as HTMLElement).click());
  // Below lg the affordance row folds until the composer is engaged; typing
  // content keeps it unfolded (fold is content-driven once engaged).
  await page.locator("form textarea").fill("hi");
}

/** True when the panel's own center pixel belongs to the panel, not to a
 *  clipping ancestor or the element painted over it. */
async function hitTestable(panel: Locator): Promise<boolean> {
  return panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.height === 0) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (hit === el || el.contains(hit));
  });
}

// The model chip opens its panel with placement="top" (above the trigger). That
// panel lives inside the composer's affordance row, so an overflow-hidden fold
// would clip it to nothing: the panel mounts, aria-expanded flips, but no pixel
// ever shows. The panel must be hit-testable at its own center point.
test.describe("composer chip dropdowns", () => {
  test("model menu opens above the composer and stays hit-testable", async ({ page }) => {
    await openSession(page);
    const chip = page.locator('[data-test="model-chip"]');
    await expect(chip).toBeVisible();
    await chip.click();

    const panel = page.locator('[data-test="model-menu"]');
    await expect(panel).toBeAttached();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();

    await expect.poll(() => hitTestable(panel)).toBe(true);

    // Picking the non-current row applies it and closes the panel.
    await panel.locator('[data-test="model-option"]').last().click();
    await expect(panel).not.toBeAttached();
  });

  test("effort menu opens above the composer and stays hit-testable", async ({ page }) => {
    await openSession(page);
    const chip = page.locator('[data-test="effort-chip"]');
    await expect(chip).toBeVisible();
    await chip.click();

    const panel = page.locator('[data-test="effort-menu"]');
    await expect(panel).toBeAttached();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();

    await expect.poll(() => hitTestable(panel)).toBe(true);
  });
});
