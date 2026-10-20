import type { Page } from "@playwright/test";
import type { ConversationMessageDto, ConversationRunDetailDto } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances } from "./fixtures";

const createdAt = "2026-10-14T00:00:00Z";
const scope = { conversationId: "group_handoff", topicId: "topic_handoff", createdAt };
const bots = [
  { id: "reviewer", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
  { id: "tester", name: "Tester", agent: "codex", workspace: "repo", enabled: true, updatedAt: createdAt },
];
const group = { id: scope.conversationId, kind: "group", title: "Handoff team", botIds: bots.map((bot) => bot.id), leadBotId: "reviewer", createdAt, updatedAt: createdAt };
const topic = { id: scope.topicId, conversationId: scope.conversationId, title: "Release", status: "active", createdAt, updatedAt: createdAt };
const historical: ConversationRunDetailDto = {
  ...scope, id: "run_history", requestMessageId: "request_old", requestId: "old", mode: "explicit", state: "completed", profileRevision: 1,
  memberTurns: [
    { ...scope, id: "turn_first", runId: "run_history", botId: "tester", batch: 1, attempt: 1, origin: "handoff", state: "indeterminate", assignmentId: "first", promptRequestId: "prompt_first" },
    { ...scope, id: "turn_second", runId: "run_history", botId: "tester", batch: 1, attempt: 1, origin: "handoff", state: "completed", assignmentId: "second", promptRequestId: "prompt_second" },
  ],
};
const current: ConversationRunDetailDto = {
  ...scope, id: "run_current", requestMessageId: "request_live", requestId: "live", mode: "explicit", state: "running", profileRevision: 1,
  memberTurns: [{ ...scope, id: "turn_live", runId: "run_current", botId: "reviewer", batch: 1, attempt: 1, origin: "human-explicit", state: "running" }],
};
function handoff(id: string, seq: number, assignment: "first" | "second"): ConversationMessageDto {
  return { ...scope, id, seq, runId: historical.id, role: "system", senderBotId: "reviewer", content: "", handoff: {
    senderMemberTurnId: "turn_sender", to: "tester", assignmentId: assignment, memberTurnId: `turn_${assignment}`,
    task: assignment === "first" ? "<img src=x onerror=alert(1)> Review first task" : "Test second task",
    expectedOutput: "A concise report",
  } };
}
const first = handoff("handoff_first", 21, "first");
const second = handoff("handoff_second", 22, "second");
const result: ConversationMessageDto = { ...scope, id: "reply_second", seq: 23, runId: historical.id, role: "bot", senderBotId: "tester", promptRequestId: "prompt_second", content: "SECOND ASSIGNMENT RESULT" };
const initial: ConversationMessageDto[] = [first, second, result, ...Array.from({ length: 47 }, (_, i) => ({ ...scope, id: `tail_${i}`, seq: i + 24, role: "human" as const, content: `Ordinary message ${i}` }))];

async function openGroup(page: Page, locale = "en", messages = initial) {
  const history = [...messages];
  await page.addInitScript((value) => localStorage.setItem("relay-locale", value), locale);
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type, payload } = route.request().postDataJSON();
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.conversation.history": {
        const older = Array.from({ length: 20 }, (_, i) => ({ ...scope, id: `older_${i}`, seq: i + 1, role: "human", content: `Older message ${i}` }));
        const rows = payload.beforeSeq ? older : payload.afterSeq ? history.filter((message) => message.seq > payload.afterSeq) : history;
        result = { ...scope, messages: rows, oldestSeq: rows[0]?.seq, newestSeq: rows.at(-1)?.seq, hasMoreBefore: !payload.beforeSeq && !payload.afterSeq, hasMoreAfter: false };
        break;
      }
      case "control.runs.list": result = { runs: [current, historical], activeRunId: current.id, activeRun: current }; break;
      case "control.runs.get": result = { run: payload.runId === historical.id ? historical : current }; break;
      case "control.runs.details.batch": result = { runs: [historical, current].filter((run) => payload.runIds.includes(run.id)) }; break;
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
  await loginAndShowInstances(page);
  const nav = page.getByTestId("instance-nav-groups");
  await nav.click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("group-transcript-scroller")).toBeVisible();
  await expect(page.getByTestId("group-target-button")).toBeEnabled();
  return history;
}

for (const locale of ["en", "zh-CN"]) {
  test(`public handoffs stay compact and associate only exact results in ${locale}`, async ({ page }, info) => {
    await openGroup(page, locale);
    const row = page.locator('[data-message-id="handoff_first"]');
    const entry = row.getByTestId("group-handoff");
    const trigger = entry.getByRole("button").first();
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toHaveAccessibleName(locale === "en" ? "Communication: Reviewer to Tester" : "通信：Reviewer 发给 Tester");
    expect((await entry.innerText()).trim()).toBe("");
    expect(await row.locator('[data-avatar-key="row"]').count()).toBe(0);
    const geometry = await trigger.evaluate((button) => {
      const avatars = [...button.querySelectorAll('[data-handoff-avatar]')].map((avatar) => avatar.getBoundingClientRect());
      return { height: button.getBoundingClientRect().height, sizes: avatars.map((r) => [r.width, r.height]), overlap: avatars[0]!.right - avatars[1]!.left };
    });
    expect(geometry.height).toBeGreaterThanOrEqual(40);
    expect(geometry.sizes).toEqual([[24, 24], [24, 24]]);
    expect(geometry.overlap).toBe(8);
    await page.screenshot({ path: info.outputPath(`handoff-${locale}-collapsed.png`) });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(entry).toContainText("<img src=x onerror=alert(1)> Review first task");
    await expect(entry).toContainText(locale === "en" ? "Outcome unknown" : "结果未知");
    await expect(entry).not.toContainText(result.content);
    await expect(entry.locator("img")).toHaveCount(0);
    const scroller = page.getByTestId("group-transcript-scroller");
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`handoff-${locale}-expanded.png`) });
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await trigger.scrollIntoViewIfNeeded();
      expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
    await trigger.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.press("Space");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    const secondEntry = page.locator('[data-message-id="handoff_second"]').getByTestId("group-handoff");
    if (info.project.name.includes("mobile")) await secondEntry.getByRole("button").first().tap();
    else await secondEntry.getByRole("button").first().click();
    await expect(secondEntry).toContainText("SECOND ASSIGNMENT RESULT");
    await page.reload();
    const restored = page.locator('[data-message-id="handoff_second"]').getByTestId("group-handoff");
    await expect(restored.getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
    await restored.getByRole("button").first().click();
    await expect(restored).toContainText("SECOND ASSIGNMENT RESULT");
  });
}

test("prepend, duplicate live delivery and reconnect preserve handoff identity and scroll", async ({ page, hub }) => {
  const history = await openGroup(page);
  const scroller = page.getByTestId("group-transcript-scroller");
  const row = page.locator('[data-message-id="handoff_first"]');
  const trigger = row.getByTestId("group-handoff").getByRole("button").first();
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  const topBefore = await scroller.evaluate((el) => el.scrollTop);
  await trigger.click();
  const anchorBefore = await row.evaluate((el) => el.getBoundingClientRect().top);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(topBefore);
  const live: ConversationMessageDto = { ...scope, id: "live_handoff", seq: 71, role: "system", senderBotId: "reviewer", runId: historical.id, content: "", handoff: { ...second.handoff! } };
  history.push(live);
  const event = { kind: "control-event" as const, instanceId: "i1", event: { type: "conversation-message" as const, message: live } };
  hub.send(event);
  hub.send(event);
  await expect(page.locator('[data-message-id="live_handoff"]')).toHaveCount(1);
  expect(await row.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(anchorBefore, 0);
  await page.getByTestId("group-load-older-button").click();
  await expect(page.locator('[data-message-id="older_0"]')).toHaveCount(1);
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => row.evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(anchorBefore, 0);
  const ids = await scroller.locator("[data-message-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id")));
  expect(ids.slice(20, 23)).toEqual(["handoff_first", "handoff_second", "reply_second"]);
  const oldSockets = new Set(hub.sockets);
  const reloaded = page.waitForResponse((response) => response.url().endsWith("/rpc")
    && response.request().postDataJSON()?.type === "control.conversation.history");
  hub.closeSockets();
  await expect.poll(() => hub.sockets.some((socket) => !oldSockets.has(socket) && socket.readyState === 1), { timeout: 20_000 }).toBe(true);
  await reloaded;
  await expect(page.locator('[data-message-id="live_handoff"]')).toHaveCount(1);
});

for (const distance of ["nearby", "distant"] as const) {
  test(`result navigation transfers keyboard focus and Tab stays at the ${distance} reply`, async ({ page }, info) => {
    const between: ConversationMessageDto[] = distance === "distant"
      ? Array.from({ length: 80 }, (_, index) => ({
        ...scope, id: `between_${index}`, seq: index + 23, role: "human",
        content: Array.from({ length: 1 + (index % 7) * 4 }, (_, line) => `History ${index}, line ${line}`).join("\n"),
      }))
      : [];
    const replySeq = between.length + 23;
    await openGroup(page, "en", [
      second, ...between, { ...result, seq: replySeq },
      ...Array.from({ length: 12 }, (_, index) => ({
        ...scope, id: `after_${index}`, seq: replySeq + index + 1, role: "human" as const,
        content: `After the result ${index}`,
      })),
    ]);
    const entry = page.locator('[data-message-id="handoff_second"]');
    const trigger = entry.getByTestId("group-handoff-toggle");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const jump = entry.getByTestId("group-handoff-jump");
    await expect(jump).toBeVisible();
    await jump.focus();
    await page.keyboard.press("Enter");
    const target = page.locator('[data-message-id="reply_second"]');
    const offset = await target.evaluate((row) => row.getBoundingClientRect().top
      - row.closest('[data-test="group-transcript-scroller"]')!.getBoundingClientRect().top);
    expect(Math.abs(offset)).toBeLessThanOrEqual(1);
    const replyText = target.getByText("SECOND ASSIGNMENT RESULT", { exact: true });
    await expect(replyText).toBeInViewport({ ratio: 1 });
    const focusedAfterJump = await page.evaluate(() => document.activeElement?.getAttribute("data-message-id"));
    await page.keyboard.press("Tab");
    await page.screenshot({ path: info.outputPath(`result-${distance}-keyboard.png`) });
    expect(focusedAfterJump).toBe("reply_second");
    await expect(target.getByTestId("agent-thinking-bubble")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(target.getByRole("button", { name: "Copy", exact: true })).toBeFocused();
    await expect(replyText).toBeInViewport({ ratio: 1 });
  });
}
