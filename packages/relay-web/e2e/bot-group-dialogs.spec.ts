import type { Locator, Page } from "@playwright/test";
import { unsupportedCapability } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

const bots = Array.from({ length: 20 }, (_, i) => ({
  id: `bot_${i}`,
  name: `资深开发工程师 ${i} ${"VeryLongBotName".repeat(6)}`,
  role: "负责工程架构与代码开发".repeat(12),
  agent: "codex",
  workspace: "repo",
  enabled: true,
  updatedAt: "2026-10-10T00:00:00.000Z",
}));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("relay-locale", "en"));
  // Extend the existing mock hub only for the management form data.
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    const results: Record<string, unknown> = {
      "control.bots.list": { bots },
      "control.groups.list": { groups: [] },
      "control.workspaces.list": { workspaces: [{ name: "repo", cwd: "/repo" }] },
      "control.agents.catalog": { agents: [] },
      "control.agents.capabilities.get": unsupportedCapability(
        { code: "adapter-cannot-enumerate", message: "Use the default model." },
        "Use the default model.",
        { fetchedAt: "2026-10-10T00:00:00.000Z" },
      ),
    };
    if (!(type in results)) return route.fallback();
    await route.fulfill({ json: { result: results[type] } });
  });
});

async function openDialog(page: Page, kind: "bot" | "group"): Promise<Locator> {
  await loginAndShowInstances(page);
  const mode = page.getByTestId(`instance-nav-${kind === "bot" ? "bots" : "groups"}`);
  // isVisible() includes off-canvas drawer content; wait for a real on-screen target.
  const box = await mode.boundingBox();
  if (box && box.x < 0) await page.getByTestId("open-instances").click();
  await expect(mode).toBeInViewport();
  await mode.click();
  await page.getByTestId(`new-${kind}-button`).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectViewportLayout(dialog: Locator): Promise<void> {
  const layout = await dialog.evaluate((panel) => {
    const overlay = panel.parentElement!;
    const rect = panel.getBoundingClientRect();
    const backdrop = overlay.getBoundingClientRect();
    const form = panel.querySelector("form")!;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, center: rect.left + rect.width / 2 },
      backdrop: { left: backdrop.left, top: backdrop.top, width: backdrop.width, height: backdrop.height },
      horizontalOverflow: form.scrollWidth - form.clientWidth,
      coversRightEdge: document.elementFromPoint(innerWidth - 2, innerHeight / 2) === overlay,
    };
  });
  expect(layout.backdrop.left).toBe(0);
  expect(layout.backdrop.top).toBe(0);
  expect(layout.backdrop.width).toBe(layout.viewport.width);
  expect(layout.backdrop.height).toBe(layout.viewport.height);
  expect(layout.coversRightEdge).toBe(true);
  expect(layout.panel.left).toBeGreaterThanOrEqual(16);
  expect(layout.panel.top).toBeGreaterThanOrEqual(16);
  expect(layout.panel.right).toBeLessThanOrEqual(layout.viewport.width - 16);
  expect(layout.panel.bottom).toBeLessThanOrEqual(layout.viewport.height - 16);
  expect(layout.panel.center).toBeCloseTo(layout.viewport.width / 2, 0);
  expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
  await expect(dialog.getByRole("heading")).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeInViewport();
}

for (const kind of ["bot", "group"] as const) {
  test(`${kind} dialog covers the viewport and restores focus on close`, async ({ page }) => {
    const dialog = await openDialog(page, kind);
    await expectViewportLayout(dialog);

    // Verify the actual focus trap and Escape handling after Teleport.
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused(); // Create is disabled while the name is empty.
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`new-${kind}-button`)).toBeFocused();

    // Clicking the backdrop outside the sidebar must also close the dialog.
    await page.getByTestId(`new-${kind}-button`).click();
    await expect(dialog).toBeVisible();
    const viewport = page.viewportSize()!;
    await page.mouse.click(viewport.width - 2, viewport.height / 2);
    await expect(dialog).toHaveCount(0);
  });

  test(`${kind} form fits narrow and short viewports with fixed actions`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openDialog(page, kind);
    if (kind === "bot") {
      await dialog.locator("#bot-name").fill("Review assistant");
      await expect(dialog.locator("#bot-agent")).toHaveValue("codex");
      await expect(dialog.locator("#bot-workspace")).toHaveValue("repo");
    } else {
      await dialog.getByTestId("group-dialog-title").fill("Release team");
      await dialog.getByTestId("group-dialog-member-bot_0").getByRole("checkbox").check();
      await dialog.getByTestId("group-dialog-member-bot_19").getByRole("checkbox").check();
      await expect(dialog.getByTestId("group-dialog-lead")).toHaveValue("bot_0");
    }
    await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await expectViewportLayout(dialog);
    const screenshot = test.info().outputPath(`${kind}-phone.png`);
    await page.screenshot({ path: screenshot });
    await test.info().attach(`${kind} phone layout`, { path: screenshot, contentType: "image/png" });

    // Narrow phone, then landscape / reduced available height while still open.
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expectViewportLayout(dialog);
      const form = dialog.locator("form");
      const actionsBefore = await dialog.getByRole("button", { name: "Create", exact: true }).boundingBox();
      await form.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await expect.poll(() => form.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expectViewportLayout(dialog);
      expect(await dialog.getByRole("button", { name: "Create", exact: true }).boundingBox()).toEqual(actionsBefore);
      if (kind === "bot") await expect(dialog.locator("#bot-avatar")).toBeInViewport();
      else await expect(dialog.getByTestId("group-dialog-lead")).toBeInViewport();
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
