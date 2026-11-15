import { test, expect } from "./fixtures";
// The shared fixture always answers /api/me as authenticated, so the login form
// never appears. These tests own that endpoint: it reports 401 until the login
// POST has minted a session, which is also how an expired session looks.
function useExpirableSession(page: import("@playwright/test").Page): { setAuthed: (v: boolean) => void } {
  let authed = false;
  void page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: authed ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(authed ? { username: "e2e" } : { error: "unauthorized" }),
    });
  });
  return { setAuthed: (v) => (authed = v) };
}

const STORAGE_KEY = "xacpx.loginToken";

test.describe("login: remember token", () => {
  test("autofills the remembered token once the session expires", async ({ page }) => {
    const session = useExpirableSession(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("login-window")).toBeVisible();

    await page.getByTestId("token-input").fill("rl_remembered_e2e");
    await page.getByTestId("remember-token").check();
    session.setAuthed(true);
    await page.getByTestId("signin").click();
    await expect(page.getByTestId("session-row").first()).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("rl_remembered_e2e");

    // Server-side session gone: the next load lands back on a prefilled form.
    session.setAuthed(false);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("login-window")).toBeVisible();
    await expect(page.getByTestId("token-input")).toHaveValue("rl_remembered_e2e");
    await expect(page.getByTestId("remember-token")).toBeChecked();
  });

  test("stores nothing when the box is left unticked", async ({ page }) => {
    const session = useExpirableSession(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("login-window")).toBeVisible();

    await expect(page.getByTestId("remember-token")).not.toBeChecked();
    await page.getByTestId("token-input").fill("rl_transient_e2e");
    session.setAuthed(true);
    await page.getByTestId("signin").click();
    await expect(page.getByTestId("session-row").first()).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    session.setAuthed(false);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("token-input")).toHaveValue("");
  });
});
