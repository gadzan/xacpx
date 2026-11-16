import { chromium, devices } from "@playwright/test";

// WP-4 evidence: measure the touch targets on the real mobile surface and write
// a JSON record next to the after screenshots. Run from packages/relay-web with
// the vite dev server up on $PLAYWRIGHT_PORT (4173 by default), the same way
// playwright.config.ts starts it.
//
//   bunx vite --port 4173 --strictPort --host 127.0.0.1 &
//   node ../../artifacts/ui-upgrade-b/scripts/measure-touch.mjs
//
// The assertions live in e2e/conversation-timeline.spec.ts and
// e2e/mobile-layout.spec.ts; this script only records the numbers.

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4173}`;
const out = new URL("../measurements/touch-targets-wp4.json", import.meta.url);

const TARGETS = [
  "mobile-back",
  "mobile-more",
  "composer-send",
  "copy-button",
  "transcript-speaker",
  "timeline-open-detail",
  "timeline-handoff",
  "conversation-stop-all",
];

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["Pixel 7"], baseURL });
const page = await context.newPage();
await page.addInitScript(() => {
  localStorage.setItem("relay-locale", "en");
  localStorage.setItem("relay-theme", "light");
});
await page.goto("/", { waitUntil: "domcontentloaded" });
const token = page.getByTestId("token-input");
if (await token.isVisible().catch(() => false)) {
  await token.fill("e2e-token");
  await page.getByTestId("signin").click();
}
await page.getByTestId("session-row").first().waitFor();

const record = { viewport: devices["Pixel 7"].viewport, deviceScaleFactor: devices["Pixel 7"].deviceScaleFactor, targets: {} };
for (const id of TARGETS) {
  const el = page.getByTestId(id).first();
  if ((await el.count()) === 0) {
    record.targets[id] = { present: false };
    continue;
  }
  const box = await el.boundingBox();
  record.targets[id] = { present: true, box };
}
await page.screenshot({ path: new URL("../after/m390/21-touch-targets.png", import.meta.url).pathname, fullPage: true });
await browser.close();

const { writeFile } = await import("node:fs/promises");
await writeFile(out, JSON.stringify(record, null, 2));
console.log(`wrote ${out.pathname}`);
