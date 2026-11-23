import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import ConversationBubble from "../components/ConversationBubble.vue";
import ConversationMeta from "../components/ConversationMeta.vue";
import CopyButton from "../components/CopyButton.vue";
import { messageCopyText } from "../lib/message-copy";
import * as presentation from "../lib/turn-presentation";

const createdAt = "2026-10-21T12:00:00.000Z";
const activity: TurnPartDto = {
  type: "tool",
  step: { toolCallId: "read-1", toolName: "Read", kind: "read", status: "success", title: "file.ts" },
};

afterEach(() => vi.restoreAllMocks());

describe("message copy contract", () => {
  it("preserves plain markdown source exactly for conversation and session messages", () => {
    const source = "# Heading\n\n**bold** and `inline`\n\n```ts\nconst x = 1;\n```\n";
    expect(messageCopyText({ content: source, createdAt })).toBe(source);
    expect(messageCopyText({ text: source, createdAt })).toBe(source);
    expect(messageCopyText({ content: source, createdAt }, [])).toBe(source);
  });

  it("copies expanded plain final reply text while excluding hidden process content", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "Investigating." },
      { type: "reasoning", text: "Private thought." },
      activity,
      { type: "text", text: "**Fixed** with `code` and [docs](https://example.com)." },
    ];
    expect(messageCopyText({ content: "stale durable text", createdAt }, parts))
      .toBe("Fixed with code and docs.");
  });

  it("applies plain-text expansion even when structured parts contain no activity", () => {
    expect(messageCopyText({ text: "**bold** `code`", createdAt }, [
      { type: "text", text: "**bold** `code`" },
    ])).toBe("bold code");
  });

  it("uses the final reply layout across a markdown delimiter interrupted by activity", () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "Working **carefully " }, activity,
      { type: "text", text: "now**. Fixed." },
    ];
    expect(messageCopyText({ text: "raw", createdAt }, parts)).toBe("now. Fixed.");
  });

  it("keeps image alt text and omits copies when the turn has no public final reply", () => {
    expect(messageCopyText({ content: "raw", createdAt }, [activity, { type: "text", text: "![plot](https://example.com/p.png)" }])).toBe("plot");
    expect(messageCopyText({ content: "process", createdAt }, [{ type: "text", text: "process" }, activity])).toBe("");
  });

  it("reuses the session's cached presentation instead of deriving another plan", () => {
    const parts: TurnPartDto[] = [activity, { type: "text", text: "**Final**" }];
    const cached = presentation.deriveTurnPresentation(parts);
    const derive = vi.spyOn(presentation, "deriveTurnPresentation");
    expect(messageCopyText({ text: "raw", createdAt }, parts, cached)).toBe("Final");
    expect(derive).not.toHaveBeenCalled();
  });

  it("writes raw plain content through the shared metadata copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const message = { content: "**raw**\n`code`\n", createdAt };
    const wrapper = mount(ConversationMeta, { props: { message } });
    expect(wrapper.find("time").text()).not.toBe("");
    expect(wrapper.findComponent(CopyButton).attributes("disabled")).toBeUndefined();
    await wrapper.find("button").trigger("click");
    expect(writeText).toHaveBeenCalledWith(message.content);
    wrapper.unmount();
  });

  it("writes the same expanded copy after rich parts change", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const message = { content: "fallback", createdAt };
    const wrapper = mount(ConversationMeta, { props: { message, parts: [activity, { type: "text", text: "**First**" }] } });
    await wrapper.find("button").trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("First");
    await wrapper.setProps({ parts: [activity, { type: "text", text: "**Second**" }] });
    await wrapper.find("button").trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("Second");
    await wrapper.setProps({ parts: [activity] });
    expect(wrapper.findComponent(CopyButton).exists()).toBe(false);
    expect(wrapper.find("time").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders a canonical rich reply once without duplicating the plain body", () => {
    const parts: TurnPartDto[] = [activity, { type: "text", text: "Final reply" }];
    const plan = presentation.deriveTurnPresentation(parts);
    const wrapper = mount(ConversationBubble, {
      props: { message: { content: "duplicate body", createdAt }, parts, presentation: plan, collapseTrace: true, traceKey: "member:attempt" },
      global: { stubs: { TurnParts: { name: "TurnParts", props: ["parts", "presentation", "collapseTrace", "traceKey"], template: '<div data-test="rich">Final reply</div>' }, StreamMarkdown: { props: ["text"], template: '<div data-test="plain">{{ text }}</div>' } } },
    });
    expect(wrapper.findAll('[data-test="rich"]')).toHaveLength(1);
    expect(wrapper.find('[data-test="plain"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("duplicate body");
    wrapper.unmount();
  });

  it("copies the same final reply before and after expanding the trace", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const message = { content: "durable fallback", createdAt };
    const parts: TurnPartDto[] = [{ type: "text", text: "Working." }, activity, { type: "text", text: "**Final**" }];
    const wrapper = mount({
      components: { ConversationBubble, ConversationMeta },
      setup() { return { message, parts }; },
      template: '<div><ConversationBubble :message="message" :parts="parts" collapse-trace /><ConversationMeta :message="message" :parts="parts" /></div>',
    }, { global: { stubs: { StreamMarkdown: true, ToolStepCard: true } } });
    expect(wrapper.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("false");
    await wrapper.find('[data-test="copy-button"]').trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("Final");
    await wrapper.find('[data-test="trace-toggle"]').trigger("click");
    expect(wrapper.find('[data-test="trace-toggle"]').attributes("aria-expanded")).toBe("true");
    await wrapper.find('[data-test="copy-button"]').trigger("click");
    expect(writeText).toHaveBeenLastCalledWith("Final");
    wrapper.unmount();
  });

  it("shows attachment-only messages through the shared existing renderer", () => {
    const attachments = [{ id: "file-1", filename: "report.txt", mimeType: "text/plain", size: 42, kind: "file" as const }];
    const wrapper = mount(ConversationBubble, {
      props: { message: { content: "", createdAt }, attachments, own: true },
      global: { stubs: { MessageAttachments: { name: "MessageAttachments", props: ["attachments"], template: '<div data-test="attachments">{{ attachments[0].filename }}</div>' } } },
    });
    expect(wrapper.text()).toContain("report.txt");
    expect(wrapper.findComponent({ name: "MessageAttachments" }).props("attachments")).toEqual(attachments);
    wrapper.unmount();
  });

  it("marks own bubbles so only their markdown soft-wraps long words", () => {
    const own = mount(ConversationBubble, {
      props: { message: { content: "a-very-long-unbroken-token", createdAt }, own: true },
      global: { stubs: { StreamMarkdown: { props: ["text"], template: '<div class="stream-md">{{ text }}</div>' } } },
    });
    // `.own` is what the scoped stylesheet keys on; the bot variant must not carry it,
    // because `.stream-md`'s non-scoped `overflow-wrap: anywhere` has to keep applying
    // to Bot long links.
    const ownBubble = own.get(".conversation-bubble");
    expect(ownBubble.classes()).toContain("own");
    expect(ownBubble.find(".stream-md").exists()).toBe(true);
    own.unmount();

    const bot = mount(ConversationBubble, {
      props: { message: { content: "https://example.test/an-unbroken/link/segment", createdAt } },
      global: { stubs: { StreamMarkdown: { props: ["text"], template: '<div class="stream-md">{{ text }}</div>' } } },
    });
    expect(bot.get(".conversation-bubble").classes()).not.toContain("own");
    bot.unmount();
  });

  it("overrides wrap on the own bubble's markdown, which the bubble-level rule cannot reach", () => {
    // StreamMarkdown renders v-html with a NON-scoped `.stream-md { overflow-wrap: anywhere }`.
    // The bubble's own `overflow-wrap` sits on the parent, so only a :deep rule on the
    // child actually wins the cascade for own bubbles.
    const sfc = readFileSync(resolve(__dirname, "../components/ConversationBubble.vue"), "utf8");
    const rule = sfc.match(/\.conversation-bubble\.own\s*:deep\(\.stream-md\)\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("overflow-wrap: break-word");
    // Bot bubbles never carry `.own`, so this selector can never match them.
    expect(sfc).not.toMatch(/\.conversation-bubble\s*:deep\(\.stream-md\)/);
  });
});
