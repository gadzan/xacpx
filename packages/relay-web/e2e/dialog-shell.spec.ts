import type { Page } from "@playwright/test";
import { unsupportedCapability } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

// WP-13: one dialog shell owns the scrim, the focus contract and the overlay
// ladder. These run on the real app because the unit suite cannot see stacking,
// focus restore or a Teleport out of the sidebar's transformed container.

const SHOTS = process.env.UI_SHOTS_DIR ?? "../../artifacts/ui-upgrade-b/after";
const createdAt = "2026-11-07T00:00:00.000Z";

const bot = {
  id: "b1",
  name: "Direct Bot",
  agent: "codex",
  workspace: "repo",
  enabled: true,
  profileRevision: 1,
  createdAt,
  updatedAt: createdAt,
};

const removalPreview = {
  botId: bot.id,
  name: bot.name,
  phase: "previewed",
  revision: "rev-1",
  directTopics: [{ id: "t1", title: "Default", status: "active" }],
  runs: { active: [], queued: [], indeterminate: [] },
  groups: [],
  departedMemberRuntimes: [],
  worktrees: [],
  externalBindings: [],
  history: { directMessages: 12, directRuns: 4, groupMessages: 0, groupRuns: 0 },
  controllerResidue: { bindingIds: [], sessionAliases: [] },
  memberUnsettledRunIds: [],
  abandonableRunIds: [],
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    const results: Record<string, unknown> = {
      "control.bots.list": { bots: [bot] },
      "control.bots.get": { bot },
      "control.bots.remove.preview": { impact: removalPreview },
      "control.groups.list": { groups: [] },
      "control.workspaces.list": { workspaces: [{ name: "repo", cwd: "/repo" }] },
      "control.agents.catalog": { agents: [] },
      "control.agents.capabilities.get": unsupportedCapability(
        { code: "adapter-cannot-enumerate", message: "Use the default model." },
        "Use the default model.",
        { fetchedAt: createdAt },
      ),
    };
    if (!(type in results)) return route.fallback();
    await route.fulfill({ json: { result: results[type] } });
  });
});

const botDialog = (page: Page) => page.locator('[aria-labelledby="bot-dialog-title"]');
const removalDialog = (page: Page) => page.locator('[aria-labelledby="removal-title"]');

/** Open the Bot management dialog from its sidebar row menu. */
async function openBotDialog(page: Page): Promise<void> {
  await loginAndShowInstances(page);
  const mode = page.getByTestId("instance-nav-bots");
  await expect(mode).toBeInViewport();
  await mode.click();
  await page.getByTestId("bot-menu-button").first().click();
  await page.getByTestId("bot-menu-edit").click();
  await expect(botDialog(page)).toBeVisible();
}

test("Escape closes the dialog and returns focus to the button that opened it", async ({ page }) => {
  await loginAndShowInstances(page);
  const opener = page.getByTestId("new-session").first();
  await opener.click();
  const dialog = page.locator('[aria-labelledby="new-session-title"]');
  await expect(dialog).toBeVisible();
  // The shell teleports to body: the panel must not live inside the sidebar row.
  expect(await dialog.evaluate((el) => el.closest('[data-test="session-row"]') === null)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-test"))).toBe("new-session");
});

test("a scrim click closes the dialog", async ({ page }) => {
  await openBotDialog(page);
  const box = await botDialog(page).boundingBox();
  expect(box).not.toBeNull();
  // Far corner of the viewport: outside the panel, inside the scrim.
  await page.mouse.click(4, 4);
  await expect(botDialog(page)).toHaveCount(0);
});

test("the nested removal dialog takes the higher rung and Escape closes only it", async ({ page }) => {
  await openBotDialog(page);
  await botDialog(page).getByTestId("bot-dialog-remove").click();
  await expect(removalDialog(page)).toBeVisible();
  await expect(botDialog(page)).toBeVisible();

  // The real stacking test: the point at the viewport centre must hit the
  // removal panel, not the Bot dialog underneath.
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return el?.closest('[aria-labelledby="removal-title"]') !== null;
  });
  expect(hit).toBe(true);

  await page.keyboard.press("Escape");
  await expect(removalDialog(page)).toHaveCount(0);
  await expect(botDialog(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(botDialog(page)).toHaveCount(0);
});

for (const [name, viewport] of [["d1440", { width: 1440, height: 900 }], ["m390", { width: 390, height: 844 }]] as const) {
  test(`nested dialog pair, ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openBotDialog(page);
    await botDialog(page).getByTestId("bot-dialog-remove").click();
    await expect(removalDialog(page)).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${name}/20-dialog-nested-light.png`, fullPage: true });
  });
}
