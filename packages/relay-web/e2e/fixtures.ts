import { appendFileSync } from "node:fs";
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
    //
    // A Proxy, NOT a subclass: noVNC's Websock.attach() does
    // `Object.getPrototypeOf(rawChannel)` and requires that prototype to carry
    // send/close/readyState/binaryType. On a subclass those live one level up
    // on WebSocket.prototype, so noVNC throws "Raw channel missing property"
    // and the RFB connect dies before any bytes move. Proxying the native
    // constructor leaves the instance's own prototype untouched, so both the
    // app's /ws socket and noVNC's binary plane get a genuine WebSocket.
    await page.addInitScript((port: number) => {
      const Orig = window.WebSocket;
      const Rewritten = new Proxy(Orig, {
        construct(target, args: [string | URL, (string | string[])?]) {
          const parsed = new URL(String(args[0]), "http://127.0.0.1");
          const protocols = args[1];
          // Only the hub planes (control /ws and the desktop binary socket);
          // Vite's HMR and anything else must pass through untouched.
          if (parsed.pathname === "/ws") {
            return new target(`ws://127.0.0.1:${port}/ws`, protocols);
          }
          if (parsed.pathname === "/desktop/observe") {
            // The mock hub pipes this socket to the mock RFB server, so real
            // noVNC runs its real handshake through the real planner.
            return new target(`ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, protocols);
          }
          return new target(...(args as [string | URL, (string | string[])?]));
        },
      });
      window.WebSocket = Rewritten as unknown as typeof WebSocket;
    }, hub.port);
    await use(page);
  },
});

/** Reach the dashboard with the instance sidebar rendered (no session opened). */
export async function loginAndShowInstances(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // /api/me is stubbed as authenticated, so the login page is usually skipped.
  const token = page.getByTestId("token-input");
  if (await token.isVisible().catch(() => false)) {
    await token.fill("e2e-token");
    await page.getByTestId("signin").click();
  }
  // Desktop: the sidebar column; mobile: the home list (nothing selected yet).
  const sessionRow = page.getByTestId("session-row").first();
  await expect(sessionRow).toBeVisible({ timeout: 30_000 });
}

/**
 * A hit box counts only if it is at least 44x44, lies inside the viewport, and
 * every one of its four edge midpoints resolves back to the control. The
 * midpoint taps are what catch a pseudo-element expansion (not part of the box)
 * or a neighbour's overlay. `document.elementFromPoint` takes VIEWPORT
 * coordinates, so the box must be on screen — an off-screen box would make every
 * tap miss, and a `null?.closest()` result must never be read as a hit.
 */
export async function expectTouchTarget(page: Page, testId: string, min = 44): Promise<void> {
  const el = page.getByTestId(testId).first();
  await expect(el, testId).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  // A sheet or a toast enters with a transform. Measuring mid-flight and then
  // hit-testing a moment later would compare two different positions, so wait
  // for the box to stop moving first.
  let box = await el.boundingBox();
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(50);
    const next = await el.boundingBox();
    if (next && box && next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height) break;
    box = next;
  }
  expect(box, testId).not.toBeNull();
  expect(box!.width, `${testId} width`).toBeGreaterThanOrEqual(min);
  expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(min);
  const viewport = page.viewportSize();
  expect(viewport, `${testId} viewport`).not.toBeNull();
  expect(box!.x, `${testId} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${testId} top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${testId} right edge`).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height, `${testId} bottom edge`).toBeLessThanOrEqual(viewport!.height);
  const points: Array<[number, number]> = [
    [box!.width / 2, 2],
    [box!.width / 2, box!.height - 2],
    [2, box!.height / 2],
    [box!.width - 2, box!.height / 2],
  ];
  const taps: Array<{ dx: number; dy: number; hit: boolean; top: string }> = [];
  for (const [dx, dy] of points) {
    // One evaluate: the hit answer AND whatever is actually on top, so a failure
    // names the element that stole the tap instead of only saying "false".
    const { hit, top } = await page.evaluate(
      ({ id, x, y }) => {
        const el = document.elementFromPoint(x, y);
        const owns = Boolean(el?.closest(`[data-test="${id}"]`));
        const label = el instanceof HTMLElement
          ? `${el.tagName.toLowerCase()}${el.dataset.test ? `[data-test=${el.dataset.test}]` : ""}.${el.className.toString().split(/\s+/).slice(0, 4).join(".")}`
          : String(el);
        return { hit: owns, top: label.slice(0, 140) };
      },
      { id: testId, x: box!.x + dx, y: box!.y + dy },
    );
    expect(hit, `${testId} at +${dx},+${dy} is covered by ${top}`).toBe(true);
    taps.push({ dx, dy, hit, top });
  }
  // Evidence pack: TOUCH_RECORD=<path> appends one JSON line per measured target.
  if (process.env.TOUCH_RECORD) {
    appendFileSync(process.env.TOUCH_RECORD, `${JSON.stringify({
      testId,
      viewport,
      deviceScaleFactor: await page.evaluate(() => window.devicePixelRatio),
      box,
      midpoints: taps,
    })}\n`);
  }
}
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
  const sessionRow = page.getByTestId("session-row").first();
  await expect(sessionRow).toBeVisible({ timeout: 20_000 });
  await sessionRow.getByTestId("session-name").evaluate((el) => (el as HTMLElement).click());
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
    // FitAddon parity: fit() reserves 14px for the scrollbar next to the
    // screen, so the slack left of the scrollbar must stay under one cell.
    const scrollBarW = 14;
    return {
      cols,
      rows,
      screenWidth: screenRect.width,
      hostWidth: hostRect.width,
      remainder: cellW > 0 ? hostRect.width - scrollBarW - screenRect.width : hostRect.width,
    };
  });
}
