import { test as base, expect, type Page } from "@playwright/test";
import { startMockHub, type MockHub } from "./mock-hub";

export { expect };

export const test = base.extend<{ hub: MockHub; page: Page }>({
  hub: async ({}, use) => {
    const hub = await startMockHub();
    await use(hub);
    await hub.close();
  },
  page: async ({ page, hub }, use) => {
    // Only the Hub REST prefix — never Vite modules under /src/api/.
    await page.route((url) => {
      const path = new URL(url).pathname;
      return path === "/api" || path.startsWith("/api/");
    }, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const headers: Record<string, string> = { "content-type": "application/json" };
      const init: RequestInit = { method: req.method(), headers };
      if (req.method() !== "GET" && req.method() !== "HEAD") {
        init.body = req.postData() ?? undefined;
      }
      const res = await fetch(`http://127.0.0.1:${hub.port}${url.pathname}${url.search}`, init);
      await route.fulfill({
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
        body: await res.text(),
      });
    });
    // Vite's /ws proxy is not used in E2E: rewrite the browser WebSocket to the
    // mock hub so we control rebase / resize / role without a real connector.
    await page.addInitScript((port: number) => {
      const Orig = window.WebSocket;
      class HubWS extends Orig {
        constructor(url: string | URL, protocols?: string | string[]) {
          const u = String(url);
          // Only the Hub events socket. Vite HMR also uses a /ws path.
          // Hub events socket is exactly /ws. Vite HMR uses /?token=... or /vite-hmr.
          const parsed = new URL(u, "http://127.0.0.1");
          if (parsed.pathname === "/ws") {
            super(`ws://127.0.0.1:${port}/ws`, protocols);
            return;
          }
          super(url, protocols);
        }
      }
      window.WebSocket = HubWS as unknown as typeof WebSocket;
    }, hub.port);
    await use(page);
  },
});

export async function loginAndOpenTerminal(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // /api/me is stubbed as authenticated, so the login page is usually skipped.
  const token = page.getByTestId("token-input");
  if (await token.isVisible().catch(() => false)) {
    await token.fill("e2e-token");
    await page.getByTestId("signin").click();
  }
  const termBtn = page.getByTestId("toggle-terminal");
  await expect(termBtn).toBeVisible({ timeout: 30_000 });
  const sessionRow = page.getByTestId("session-row");
  if (!(await sessionRow.isVisible().catch(() => false))) {
    const open = page.getByTestId("open-instances");
    if (await open.isVisible().catch(() => false)) await open.click();
  }
  await expect(sessionRow).toBeVisible({ timeout: 20_000 });
  await sessionRow.getByTestId("session-name").evaluate((el) => (el as HTMLElement).click());
  const closeInstances = page.getByTestId("close-instances");
  if (await closeInstances.isVisible().catch(() => false)) {
    await closeInstances.evaluate((el) => (el as HTMLElement).click());
  }
  await expect(termBtn).toBeEnabled({ timeout: 10_000 });
  await termBtn.evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByTestId("terminal-host")).toBeVisible();
}

/** Wait until the terminal renderer has a measurable screen (module + font + grid mount). */
export async function waitForTerminalScreen(page: Page) {
  const screen = page.locator('[data-test="terminal-host"] .xterm-screen').first();
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => {
    return screen.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
  }).toBe(true);
  return screen;
}

export async function readTerminalGrid(page: Page): Promise<{
  cols: number;
  rows: number;
  screenWidth: number;
  hostWidth: number;
  remainder: number;
}> {
  await expect.poll(async () => {
    return page.locator('[data-test="terminal-host"]').getAttribute("data-cols");
  }).not.toBeNull();
  return page.locator('[data-test="terminal-host"]').evaluate((host) => {
    const screen = host.querySelector(".xterm-screen");
    if (!screen) throw new Error("no xterm-screen");
    const screenRect = screen.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const cols = Number(host.dataset.cols ?? 0);
    const rows = Number(host.dataset.rows ?? 0);
    const cellW = cols > 0 ? screenRect.width / cols : 0;
    return {
      cols,
      rows,
      screenWidth: screenRect.width,
      hostWidth: hostRect.width,
      remainder: cellW > 0 ? hostRect.width - screenRect.width : hostRect.width,
    };
  });
}
