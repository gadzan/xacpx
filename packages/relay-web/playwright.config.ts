import { defineConfig, devices } from "@playwright/test";

// Local macOS 13 cannot install Playwright's bundled Chromium. Prefer the
// system Google Chrome channel; CI (Ubuntu) still uses bundled Chromium.
const useSystemChrome = process.platform === "darwin";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    testIdAttribute: "data-test",
    trace: "retain-on-failure",
    ...(useSystemChrome ? { channel: "chrome" } : {}),
  },
  webServer: {
    command: "bunx vite --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        viewport: { width: 1440, height: 900 },
        isMobile: false,
        hasTouch: false,
        ...(useSystemChrome ? { channel: "chrome" } : { ...devices["Desktop Chrome"] }),
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 7"],
        hasTouch: true,
        isMobile: true,
        ...(useSystemChrome ? { channel: "chrome" } : {}),
      },
    },
  ],
});
