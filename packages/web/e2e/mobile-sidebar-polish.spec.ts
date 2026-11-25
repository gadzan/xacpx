import type { Page } from "@playwright/test";
import type {
  BotSummaryDto,
  ConversationMessageDto,
  ConversationTimelineDto,
  ConversationTimelineEntryDto,
} from "@ganglion/xacpx-relay-protocol";
import { RELAY_CAPABILITIES } from "@ganglion/xacpx-relay-protocol";
import { test, expect, loginAndShowInstances, expectTouchTarget } from "./fixtures";

/**
 * The mobile polish pass, on the real surface: the group timeline never scrolls
 * sideways, the composer's geometry holds at rest, the sidebar's segmented rail
 * and Bots rows keep their visual heights, and one collage layout serves both
 * entry points. Assertions are measurements, not class names.
 */

const createdAt = "2026-11-07T00:00:00.000Z";
const scope = { conversationId: "group_polish", topicId: "topic_polish" };
const longToken = "Z".repeat(160);

function character(shape: string, color: string) {
  return { version: 1 as const, kind: "character" as const, shape, color, expression: "neutre", motion: "auto" as const };
}

function members(count: number): BotSummaryDto[] {
  const shapes = [["galet", "violet"], ["squircle", "bleu"], ["nuage", "vert"], ["capsule", "ambre"], ["hexagone", "rose"]];
  return Array.from({ length: count }, (_, index) => {
    const [shape, color] = shapes[index % shapes.length]!;
    return {
      id: `bot_${index}`,
      name: `Member ${index}`,
      role: `Owns the ${"pipeline ".repeat(12)}${index}`,
      agent: "codex",
      workspace: "repo",
      enabled: true,
      avatar: character(shape!, color!),
      updatedAt: createdAt,
    };
  });
}

const state = {
  bots: members(4),
  messages: [] as ConversationMessageDto[],
};

function wideContent(): ConversationMessageDto[] {
  return [
    { ...scope, id: "m_plain", seq: 1, role: "human", content: `Plain request ${"Q".repeat(120)}`, createdAt },
    {
      ...scope, id: "m_inline", seq: 2, role: "bot", senderBotId: "bot_0",
      content: `Inline probe: \`${longToken}\` tail and https://example.com/${"p".repeat(120)} end.`,
      createdAt,
    },
    {
      ...scope, id: "m_pre", seq: 3, role: "bot", senderBotId: "bot_1",
      content: `Fenced probe:\n\n- list intro\n\n  \`\`\`ts\n  const wide = "${"y".repeat(220)}";\n  \`\`\`\n`,
      createdAt,
    },
    {
      ...scope, id: "m_table", seq: 4, role: "bot", senderBotId: "bot_2",
      content: [
        "Table probe:",
        "",
        `| ${Array.from({ length: 10 }, (_, i) => `Column ${i}`).join(" | ")} |`,
        `| ${Array.from({ length: 10 }, () => "---").join(" | ")} |`,
        `| ${Array.from({ length: 10 }, (_, i) => `cell ${i} ${"w".repeat(24)}`).join(" | ")} |`,
      ].join("\n"),
      createdAt,
    },
    { ...scope, id: "m_tail", seq: 5, role: "human", content: "Tail " + "tail text ".repeat(30), createdAt },
  ];
}

function entriesOf(list: ConversationMessageDto[]): ConversationTimelineEntryDto[] {
  return list.map((message) => ({
    kind: "message" as const,
    key: `message:${message.id}`,
    anchorSeq: message.seq,
    message,
  }));
}

async function installRoutes(page: Page, hub: { port: number }): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("relay-locale", "en");
    localStorage.setItem("relay-theme", "light");
  });
  await page.route("**/api/instances", async (route) => {
    const response = await fetch(`http://127.0.0.1:${hub.port}/api/instances`);
    const body = await response.json() as { instances: Array<{ capabilities?: string[] }> };
    for (const instance of body.instances) {
      instance.capabilities = [...new Set([
        ...(instance.capabilities ?? []),
        RELAY_CAPABILITIES.conversationTimelineV1,
        RELAY_CAPABILITIES.roundtableV1,
      ])];
    }
    await route.fulfill({ json: body });
  });
  await page.route("**/api/instances/i1/rpc", async (route) => {
    const { type } = route.request().postDataJSON() as { type: string };
    const group = {
      id: scope.conversationId, kind: "group", title: "Polish team",
      botIds: state.bots.map((bot) => bot.id), leadBotId: state.bots[0]?.id ?? null, createdAt, updatedAt: createdAt,
    };
    const topic = {
      id: scope.topicId, conversationId: scope.conversationId, title: "Polish topic",
      status: "active", createdAt, updatedAt: createdAt,
    };
    let result: unknown;
    switch (type) {
      case "control.bots.list": result = { bots: state.bots }; break;
      case "control.agents.list": result = { agents: [{ name: "codex", driver: "codex" }] }; break;
      case "control.workspaces.list": result = { workspaces: [{ name: "repo", cwd: "/repo" }] }; break;
      case "control.agents.catalog": result = { agents: [] }; break;
      case "control.groups.list": result = { groups: [group] }; break;
      case "control.groups.get": result = { group: { ...group, topics: [topic] } }; break;
      case "control.topics.list": result = { topics: [topic] }; break;
      case "control.runs.list": result = { runs: [] }; break;
      case "control.conversation.history": result = {
        ...scope, messages: state.messages, oldestSeq: 1, newestSeq: state.messages.at(-1)?.seq,
        hasMoreBefore: false, hasMoreAfter: false,
      }; break;
      case "control.conversation.timeline": {
        const timeline: ConversationTimelineDto = { ...scope, entries: entriesOf(state.messages) } as ConversationTimelineDto;
        result = timeline;
        break;
      }
      default: return route.fallback();
    }
    await route.fulfill({ json: { result } });
  });
}

async function openGroup(page: Page, hub: { port: number }): Promise<void> {
  await installRoutes(page, hub);
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.getByTestId("conversation-timeline-scroller")).toBeVisible();
  await expect(page.locator(".conversation-row").first()).toBeVisible();
}

function mobileOnly(testInfo: { project: { name: string } }): void {
  test.skip(testInfo.project.name !== "chromium-mobile", "phone geometry");
}

test.beforeEach(() => {
  state.bots = members(4);
  state.messages = wideContent();
});

test("group timeline never scrolls sideways on a phone", async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "phone widths");
  await page.setViewportSize({ width: 390, height: 844 });
  await openGroup(page, hub);

  for (const width of [320, 360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 });
    const measured = await page.evaluate(() => {
      const scroller = document.querySelector('[data-test="conversation-timeline-scroller"]') as HTMLElement;
      const root = document.documentElement;
      const right = scroller.getBoundingClientRect().right;
      const blocks = Array.from(document.querySelectorAll(".stream-md pre, .stream-md .md-table-wrap")).map((el) => ({
        tag: el.tagName.toLowerCase(),
        innerOverflow: el.scrollWidth - el.clientWidth,
        rightOverhang: Math.round(el.getBoundingClientRect().right - right),
      }));
      return {
        page: root.scrollWidth - root.clientWidth,
        scroller: scroller.scrollWidth - scroller.clientWidth,
        blocks,
        codes: Array.from(document.querySelectorAll(".stream-md code")).filter((el) => !el.closest("pre")).map((el) => el.getBoundingClientRect().width),
      };
    });
    expect(measured.page, `${width}: page horizontal overflow`).toBeLessThanOrEqual(1);
    expect(measured.scroller, `${width}: timeline horizontal overflow`).toBeLessThanOrEqual(1);
    for (const block of measured.blocks) {
      expect(block.rightOverhang, `${width}: ${block.tag} pushes the column`).toBeLessThanOrEqual(1);
    }
    // The wide content is present, and it scrolls inside its own block.
    expect(measured.blocks.some((block) => block.innerOverflow > 1), `${width}: no locally scrolling block`).toBe(true);
    for (const code of measured.codes) expect(code, `${width}: inline code wider than the column`).toBeLessThanOrEqual(width);
  }
});

test("composer rests at 48px with a 32px disc inside a 44px hit box", async ({ page, hub }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGroup(page, hub);

  const box = await page.evaluate(() => {
    const rect = (el: Element | null) => el ? el.getBoundingClientRect().toJSON() : null;
    const surface = document.querySelector('[data-test="composer-surface"]');
    const send = document.querySelector('[data-test="group-send-prompt-button"]') as HTMLButtonElement | null;
    const disc = send?.querySelector("span") ?? null;
    const textarea = document.querySelector('[data-test="group-composer-textarea"]') as HTMLTextAreaElement | null;
    return {
      surface: rect(surface),
      send: rect(send),
      disc: rect(disc),
      textareaPaddingRight: textarea ? Number.parseFloat(getComputedStyle(textarea).paddingRight) : null,
      sendDisabled: send?.disabled ?? null,
      discColor: disc ? getComputedStyle(disc).backgroundColor : null,
    };
  });

  expect(box.surface!.height).toBeGreaterThanOrEqual(47);
  expect(box.surface!.height).toBeLessThanOrEqual(49);
  expect(box.send!.width).toBeGreaterThanOrEqual(44);
  expect(box.send!.height).toBeGreaterThanOrEqual(44);
  // Inside the shell, not hanging over its rounded edge.
  expect(box.send!.y).toBeGreaterThanOrEqual(box.surface!.y - 0.5);
  expect(box.send!.y + box.send!.height).toBeLessThanOrEqual(box.surface!.y + box.surface!.height + 0.5);
  expect(box.disc!.width).toBe(32);
  expect(box.disc!.height).toBe(32);
  // The text never runs under the hit box.
  expect(box.textareaPaddingRight).toBeGreaterThanOrEqual(52);
  expect(box.sendDisabled).toBe(true);

  // A dead Send is dimmed by the button's own disabled state.
  const disabledColor = box.discColor;
  await page.getByTestId("group-composer-textarea").fill("Ready");
  await expect.poll(async () => page.getByTestId("group-send-prompt-button").locator("span").first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(disabledColor);

  // Expanded: the disc drops to the bottom-right corner of the grown card.
  await page.getByTestId("group-composer-textarea").fill("Line one\nLine two\nLine three");
  const expanded = await page.evaluate(() => {
    const rect = (el: Element | null) => el ? el.getBoundingClientRect().toJSON() : null;
    const surface = document.querySelector('[data-test="composer-surface"]');
    const disc = document.querySelector('[data-test="group-send-prompt-button"] span');
    const textarea = document.querySelector('[data-test="group-composer-textarea"]');
    return { surface: rect(surface), disc: rect(disc), line: rect(textarea) };
  });
  expect(expanded.surface!.height).toBeGreaterThan(60);
  expect(expanded.disc!.y + expanded.disc!.height)
    .toBeGreaterThan(expanded.line!.y + expanded.line!.height - 16);
  expect(expanded.disc!.x).toBeGreaterThan(expanded.surface!.x + expanded.surface!.width / 2);
});

test("sidebar segments keep 32 and 28 while the hit boxes are 44", async ({ page, hub }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await openGroup(page, hub);
  await page.getByTestId("mobile-back").click();
  await expect(page.getByTestId("instance-nav-track")).toBeVisible();

  const measured = await page.evaluate(() => {
    const rect = (el: Element | null) => el ? el.getBoundingClientRect().toJSON() : null;
    const rail = document.querySelector('[data-test="instance-nav-rail"]');
    const selected = document.querySelector('[data-test="instance-nav-bots"] [data-test="instance-nav-pill"]');
    const segments = Array.from(document.querySelectorAll('[data-test="instance-nav-track"] > button')).map(rect);
    const card = document.querySelector('[data-test="instance-card"]');
    return { rail: rect(rail), selected: rect(selected), segments, card: rect(card) };
  });

  expect(measured.rail!.height).toBe(32);
  expect(measured.selected!.height).toBe(28);
  expect(measured.segments).toHaveLength(2);
  for (const segment of measured.segments) {
    expect(segment!.height).toBeGreaterThanOrEqual(44);
    expect(segment!.width).toBeGreaterThanOrEqual(44);
  }
  // No two hit boxes overlap horizontally.
  const [first, second] = measured.segments as Array<{ x: number; width: number }>;
  expect(first!.x + first!.width).toBeLessThanOrEqual(second!.x + 0.5);
  // The 44px boxes stay above the first instance card, not on top of it.
  const bottom = Math.max(...measured.segments.map((segment) => segment!.y + segment!.height));
  expect(bottom).toBeLessThanOrEqual(measured.card!.y + 0.5);
  // Real targets: each edge midpoint resolves back to its own segment.
  for (const id of ["instance-nav-sessions", "instance-nav-bots"]) {
    await expectTouchTarget(page, id);
  }
});

test("desktop segments stay 32 and 28 with a fine pointer", async ({ page, hub }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "fine pointer");
  await openGroup(page, hub);
  const measured = await page.evaluate(() => {
    const rect = (el: Element | null) => el ? el.getBoundingClientRect().toJSON() : null;
    return {
      rail: rect(document.querySelector('[data-test="instance-nav-rail"]')),
      selected: rect(document.querySelector('[data-test="instance-nav-sessions"] [data-test="instance-nav-pill"]')),
      segment: rect(document.querySelector('[data-test="instance-nav-sessions"]')),
    };
  });
  expect(measured.rail!.height).toBe(32);
  expect(measured.selected!.height).toBe(28);
  expect(measured.segment!.height).toBe(28);
});

test("bots rows paint a 40px avatar that fills its box", async ({ page, hub }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page, hub);
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();
  await expect(page.getByTestId("bot-row").first()).toBeVisible();

  const measured = await page.evaluate(() => {
    const row = document.querySelector('[data-test="bot-row"]') as HTMLElement;
    const avatar = row.querySelector('[data-test="bot-avatar"]') as HTMLElement;
    const body = avatar.querySelector("path.bot-avatar-body") as SVGPathElement | null;
    const box = avatar.getBoundingClientRect();
    const bbox = body?.getBBox();
    const viewBoxWidth = 80;
    const name = row.querySelector('[data-test="bot-name"]') as HTMLElement;
    // The name sits in a wrapper that also holds the pin marker, so the role is the
    // row's last text line rather than the name's immediate sibling.
    const role = row.querySelector('[data-test="bot-role"]') as HTMLElement | null;
    return {
      avatar: box.width,
      painted: bbox ? Math.round((bbox.width / viewBoxWidth) * box.width * 10) / 10 : null,
      rowHeight: row.getBoundingClientRect().height,
      overflow: row.scrollWidth - row.clientWidth,
      nameClipped: name.scrollWidth > name.clientWidth,
      roleClipped: role ? role.scrollWidth > role.clientWidth : null,
    };
  });

  expect(measured.avatar, "avatar box").toBe(40);
  expect(measured.painted, "painted body width").toBeGreaterThanOrEqual(32);
  expect(measured.rowHeight).toBeGreaterThanOrEqual(40);
  expect(measured.overflow).toBeLessThanOrEqual(1);
  // Long names and roles ellipsize instead of pushing the row sideways.
  expect(measured.nameClipped || measured.roleClipped).toBe(true);
});

test("one collage layout serves the sidebar and the top bar", async ({ page, hub }, testInfo) => {
  mobileOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page, hub);
  await loginAndShowInstances(page);
  await page.getByTestId("instance-nav-bots").click();

  const read = async (selector: string) => page.evaluate((sel) => {
    const stack = document.querySelector(sel) as HTMLElement | null;
    if (!stack) return null;
    const box = stack.getBoundingClientRect();
    const items = Array.from(stack.querySelectorAll('[data-test="group-avatar-item"]')).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.getAttribute("data-bot-id"),
        x: Math.round(rect.x - box.x),
        y: Math.round(rect.y - box.y),
        w: Math.round(rect.width),
      };
    });
    return {
      size: Math.round(box.width),
      items,
      more: stack.querySelector('[data-test="group-avatar-more"]')?.textContent ?? null,
    };
  }, selector);

  // The sidebar is the visible surface here; the pane covers it on a phone.
  await expect.poll(async () => (await read('[data-test="group-row"] [data-test="group-avatar-stack"]'))?.items.length ?? 0)
    .toBe(4);
  const sidebar = await read('[data-test="group-row"] [data-test="group-avatar-stack"]');

  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.locator(".conversation-row").first()).toBeVisible();
  const header = await read('[data-test="group-avatar-button"] [data-test="group-avatar-stack"]');
  for (const collage of [sidebar, header]) {
    expect(collage).not.toBeNull();
    expect(collage!.items).toHaveLength(4);
    expect(collage!.more).toBeNull();
    // 2x2 of four overlapping cells: neighbours press into each other.
    const [a, b] = collage!.items;
    const gap = Math.abs(b!.x - a!.x);
    expect(a!.w, "cell width").toBeGreaterThan(gap);
    // Same order as the group's members, so the z order is the DOM order.
    expect(collage!.items.map((item) => item.id)).toEqual(["bot_0", "bot_1", "bot_2", "bot_3"]);
  }
  expect(sidebar!.size).toBe(40);
  expect(header!.size).toBe(32);

  // Five members: three cells plus a count, in both entry points.
  state.bots = members(5);
  await page.getByTestId("mobile-back").click();
  await page.reload();
  await expect(page.getByTestId("instance-nav-bots")).toBeVisible();
  await page.getByTestId("instance-nav-bots").click();
  await expect.poll(async () => (await read('[data-test="group-row"] [data-test="group-avatar-stack"]'))?.items.length ?? 0)
    .toBe(3);
  const overflowSidebar = await read('[data-test="group-row"] [data-test="group-avatar-stack"]');
  await page.getByTestId("group-row").first().getByRole("button").first().click();
  await expect(page.locator(".conversation-row").first()).toBeVisible();
  const overflowHeader = await read('[data-test="group-avatar-button"] [data-test="group-avatar-stack"]');
  for (const collage of [overflowSidebar, overflowHeader]) {
    expect(collage!.items).toHaveLength(3);
    expect(collage!.more).toBe("+2");
  }
});
