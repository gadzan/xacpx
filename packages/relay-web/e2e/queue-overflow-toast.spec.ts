import { test, expect } from "./fixtures";
import { INSTANCE_ID } from "./mock-hub";

async function loginAndOpenSession(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const token = page.getByTestId("token-input");
  if (await token.isVisible().catch(() => false)) {
    await token.fill("e2e-token");
    await page.getByTestId("signin").click();
  }
  const sessionRow = page.getByTestId("session-row").first();
  if (!(await sessionRow.isVisible().catch(() => false))) {
    const open = page.getByTestId("open-instances");
    if (await open.isVisible().catch(() => false)) await open.click();
  }
  await expect(sessionRow).toBeVisible({ timeout: 20_000 });
  await sessionRow.getByTestId("session-name").evaluate((el) => (el as HTMLElement).click());
}

test.describe("queue-overflow toast", () => {
  test("shows a 3s toast and does not add a chat message", async ({ page, hub }) => {
    await loginAndOpenSession(page);
    await expect.poll(() => hub.sockets.length).toBeGreaterThan(0);
    const tip = "Reply was truncated for size — you can continue.";
    hub.send({
      kind: "notice",
      instanceId: INSTANCE_ID,
      notice: { kind: "queue-overflow", text: tip },
    });
    const toast = page.getByTestId("queue-overflow-toast");
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(tip);
    await expect(page.getByTestId("msg-out").filter({ hasText: tip })).toHaveCount(0);
    await expect(toast).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId("msg-scroller")).not.toContainText(tip);
  });
});
