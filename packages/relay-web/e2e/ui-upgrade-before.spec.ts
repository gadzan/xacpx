import type { Page } from "@playwright/test";
import { test, expect, loginAndShowInstances } from "./fixtures";

const SHOTS = process.env.UI_SHOTS_DIR ?? "../artifacts/ui-upgrade-b/before";
const THEME = process.env.UI_THEME ?? "light";
const createdAt = "2026-11-07T00:00:00.000Z";
const bot = { id: "b1", name: "Direct Bot", agent: "codex", workspace: "repo", enabled: true, profileRevision: 1, createdAt, updatedAt: createdAt };

async function setTheme(page: Page): Promise<void> {
  await page.addInitScript((theme: string) => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", theme);
  }, THEME);
}

async function rpc(page: Page, handlers: Record<string, unknown>): Promise<void> {
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    if (type in handlers) {
      await route.fulfill({ json: { result: handlers[type] } });
      return;
    }
    return route.fallback();
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  console.log(`shot ${name} dpr=${dpr}`);
}

function directHandlers(withMessages: boolean): Record<string, unknown> {
  const messages = withMessages ? [{
    id: "m1", conversationId: "c1", topicId: "t1", seq: 1, role: "human",
    content: "Review the release:\n\n```ts\nif (a !== b) { ship(); }\n```",
    createdAt,
  }] : [];
  return {
    "control.bots.list": { bots: [bot] },
    "control.bots.get": { bot },
    "control.conversations.list": { conversations: [{ id: "c1", kind: "bot", title: bot.name, botIds: [bot.id], defaultTopicId: "t1", createdAt, updatedAt: createdAt }] },
    "control.topics.list": { topics: [{ id: "t1", conversationId: "c1", title: "Default", status: "active", defaultDirect: true, createdAt, updatedAt: createdAt }] },
    "control.conversation.history": { conversationId: "c1", topicId: "t1", messages, hasMoreBefore: false, hasMoreAfter: false },
    "control.runs.list": { runs: [] },
    "control.conversation.completions.get": {
      version: 1, scope: { conversationId: "c1", topicId: "t1", botId: "b1" }, revision: "r1",
      commands: { status: "ready", items: [{ name: "review", description: "Advertised by adapter" }] },
      mentions: { status: "ready", items: [] },
    },
  };
}

async function openDirect(page: Page, withMessages: boolean): Promise<void> {
  await rpc(page, directHandlers(withMessages));
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("bot-row").first().getByRole("button").first().click();
  await expect(page.locator('textarea[role="combobox"]')).toBeVisible();
}

test("01 home session list", async ({ page, hub }) => {
  await setTheme(page);
  await rpc(page, {});
  await loginAndShowInstances(page);
  await shot(page, `01-home-${THEME}`);
});

test("02 sidebar bots", async ({ page, hub }) => {
  await setTheme(page);
  const bots = [
    { id: "b1", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
    { id: "b2", name: "Bob", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  ];
  await rpc(page, { "control.bots.list": { bots } });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await expect(page.getByTestId("bot-row").first()).toBeVisible();
  await shot(page, `02-bots-${THEME}`);
});

test("03 direct with markdown and code", async ({ page, hub }) => {
  await setTheme(page);
  await openDirect(page, true);
  await shot(page, `03-direct-${THEME}`);
});

test("05 sidebar groups", async ({ page, hub }) => {
  await setTheme(page);
  const group = { id: "g1", kind: "group", title: "Team", botIds: ["lead"], leadBotId: "lead", createdAt, updatedAt: createdAt };
  await rpc(page, {
    "control.bots.list": { bots: [{ id: "lead", name: "Ada", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt }] },
    "control.groups.list": { groups: [group] },
  });
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-groups").click();
  await expect(page.getByTestId("group-row").first()).toBeVisible();
  await shot(page, `05-groups-${THEME}`);
});

test("08 settings page", async ({ page, hub }) => {
  await setTheme(page);
  await rpc(page, {});
  await loginAndShowInstances(page);
  await page.goto("/settings");
  await expect(page.getByText(/settings/i).first()).toBeVisible();
  await shot(page, `08-settings-${THEME}`);
});

test("09 login page forced", async ({ page, hub }) => {
  await page.addInitScript((theme: string) => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", theme);
  }, THEME);
  await page.route("**/api/me", async (route) => {
    await route.fulfill({ status: 401, json: { error: "unauthorized" } });
  });
  await page.goto("/");
  await expect(page.getByTestId("token-input")).toBeVisible();
  await shot(page, `09-login-${THEME}`);
});

test("11 direct empty state", async ({ page, hub }) => {
  await setTheme(page);
  await openDirect(page, false);
  await shot(page, `11-empty-${THEME}`);
});
