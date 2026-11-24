import { test, expect } from "./fixtures";
// fixtures.ts answers /api/me as authenticated, so these tests own that endpoint
// instead: 401 until the login POST mints a session, which is how an expired
// session looks.
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

    session.setAuthed(false);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("login-window")).toBeVisible();
    await expect(page.getByTestId("token-input")).toHaveValue("rl_remembered_e2e");
    await expect(page.getByTestId("remember-token")).toBeChecked();
  });

  test("an invite sign-in drops the previous account's remembered token", async ({ page }) => {
    const session = useExpirableSession(page);
    await page.route("**/api/invites/redeem", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ token: "rl_new_account", username: "new" }),
      }),
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("login-window")).toBeVisible();
    await page.evaluate((key) => localStorage.setItem(key, "rl_stale_account"), STORAGE_KEY);

    await page.goto("/invite/e2e-code", { waitUntil: "domcontentloaded" });
    await page.getByTestId("redeem").click();
    session.setAuthed(true);
    await page.getByTestId("signin").click();
    await expect(page.getByTestId("session-row").first()).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBeNull();

    session.setAuthed(false);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("token-input")).toHaveValue("");
    await expect(page.getByTestId("remember-token")).not.toBeChecked();
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
