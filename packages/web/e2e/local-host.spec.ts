import { test, expect } from "./fixtures";

const LOCAL = {
  hostMode: "local",
  auth: { required: false, mode: "none" },
  capabilities: {
    multiInstance: false,
    pairing: false,
    invites: false,
    webPush: false,
    relayUpdate: false,
    agentDirectory: false,
    terminal: false,
    desktop: false,
  },
  defaultInstanceId: "local",
  historyRetention: { mode: "client-side", days: 30, maxPerSession: 2000 },
};

test("an open local host skips login and invite", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(LOCAL),
    });
  });

  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("login-window")).toHaveCount(0);
  await expect(page.getByTestId("session-row").first()).toBeVisible({ timeout: 20_000 });

  await page.goto("/invite/local-code", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("login-window")).toHaveCount(0);
  await expect(page.getByTestId("session-row").first()).toBeVisible({ timeout: 20_000 });
});
