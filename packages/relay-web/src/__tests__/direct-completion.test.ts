import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { api } from "../api/client";
import { i18n } from "../i18n";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useDirectComposerStore } from "../stores/direct-composer";
import Input from "../components/ConversationPromptInput.vue";
import type { ConversationCompletions } from "@ganglion/xacpx-relay-protocol";
let wrappers: Array<ReturnType<typeof mount>> = [];
function ready(
  scope = { conversationId: "c1", topicId: "t1", botId: "b1" },
): ConversationCompletions {
  return {
    version: 1,
    scope,
    revision: "r1",
    commands: {
      status: "ready",
      items: [{ name: "review", description: "adapter" }, { name: "reload" }],
    },
    mentions: {
      status: "ready",
      items: [
        {
          handle: "agent:n:b2",
          displayName: "同名",
          agent: "codex",
          workspace: "backend",
        },
        {
          handle: "agent:n:b3",
          displayName: "同名",
          agent: "claude",
          workspace: "frontend",
        },
      ],
    },
  };
}
function seed() {
  const s = useDirectBotsStore();
  s.instanceId = "i1";
  s.selectedBotId = "b1";
  s.activeConversationId = "c1";
  s.activeTopicId = "t1";
  s.topicReady = true;
  s.botsByInstance.i1 = [
    {
      id: "b1",
      name: "A",
      agent: "codex",
      workspace: "backend",
      enabled: true,
      updatedAt: "now",
      profileRevision: 1,
    },
  ];
  return s;
}
function input(props = {}) {
  const w = mount(Input, {
    props,
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  wrappers.push(w);
  return w;
}
beforeEach(() => {
  setActivePinia(createPinia());
  seed();
  vi.spyOn(api, "rpc").mockResolvedValue(ready());
});
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  vi.restoreAllMocks();
});
describe("Direct completion", () => {
  it("queries first slash without sending, owns Enter/Tab and exposes a listbox", async () => {
    const w = input(),
      t = w.get("textarea");
    await t.setValue("/re");
    await flushPromises();
    expect(api.rpc).toHaveBeenCalledWith(
      "i1",
      "control.conversation.completions.get",
      { conversationId: "c1", topicId: "t1" },
    );
    expect(w.find('[role="listbox"]').exists()).toBe(true);
    expect(t.attributes("aria-expanded")).toBe("true");
    await t.trigger("keydown", { key: "ArrowDown" });
    await t.trigger("keydown", { key: "Tab" });
    expect((t.element as HTMLTextAreaElement).value).toBe("/reload ");
    expect(w.emitted("send")).toBeUndefined();
    await t.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["/reload ", []]);
  });
  it("reopens the mention menu after a committed slash dismissed it", async () => {
    const w = input(),
      t = w.get("textarea");
    // Tab commits the first match and marks the menu dismissed.
    await t.setValue("/re");
    await flushPromises();
    await t.trigger("keydown", { key: "Tab" });
    expect((t.element as HTMLTextAreaElement).value).toBe("/review ");
    // A fresh `@` in a new draft must reopen the menu: the dismissal belongs to
    // the committed token, not to the composer.
    await t.setValue("😀 @");
    await flushPromises();
    expect(w.find('[role="listbox"]').exists()).toBe(true);
    expect(t.attributes("aria-expanded")).toBe("true");
  });
  it("slash mode sends no mention query even when the token also looks like a mention", async () => {
    const w = input(),
      t = w.get("textarea");
    await t.setValue("/(@x");
    await flushPromises();
    for (const call of vi.mocked(api.rpc).mock.calls)
      expect(call[2]).not.toHaveProperty("query");
    expect(api.rpc).toHaveBeenCalledWith("i1", "control.conversation.completions.get", { conversationId: "c1", topicId: "t1" });
  });
  it("cold-bot mention mode does not re-poll and keeps pages loaded via more", async () => {
    vi.useFakeTimers();
    try {
      const many = (from: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({ handle: "agent:n:m" + (from + i), displayName: "M" + (from + i), agent: "codex", workspace: "backend" }));
      vi.mocked(api.rpc).mockImplementation(async (_i, _t, payload) => {
        const cursor = (payload as { cursor?: number }).cursor ?? 0;
        return {
          ...ready(),
          commands: { status: "loading", items: [] },
          mentions: { status: "ready", items: many(cursor, 8), ...(cursor === 0 ? { nextCursor: 8 } : {}) },
        };
      });
      const w = input(),
        t = w.get("textarea");
      await t.setValue("@");
      await flushPromises();
      expect(w.text()).toContain("M0");
      const more = w.findAll("button").find((b) => b.text() === i18n.global.t("bot.prompt.moreCompletions"));
      expect(more).toBeDefined();
      await more!.trigger("click");
      await flushPromises();
      expect(w.text()).toContain("M8");
      const calls = vi.mocked(api.rpc).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(vi.mocked(api.rpc).mock.calls.length).toBe(calls);
      expect(w.text()).toContain("M8");
    } finally {
      vi.useRealTimers();
    }
  });
  it("slash mode still re-polls while commands are loading", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.rpc).mockResolvedValue({ ...ready(), commands: { status: "loading", items: [] } });
      const w = input(),
        t = w.get("textarea");
      await t.setValue("@a /");
      await t.setValue("/");
      await flushPromises();
      const calls = vi.mocked(api.rpc).mock.calls.length;
      await vi.advanceTimersByTimeAsync(1600);
      await flushPromises();
      expect(vi.mocked(api.rpc).mock.calls.length).toBeGreaterThan(calls);
    } finally {
      vi.useRealTimers();
    }
  });
  it("chooses duplicate names by handle with mouse/touch click and edit removes identity", async () => {
    const deliver = vi.fn().mockResolvedValue("uncertain");
    const w = input({ deliver }),
      t = w.get("textarea");
    await t.setValue("😀 @");
    await flushPromises();
    const choices = w.findAll('[role="option"]');
    expect(choices).toHaveLength(2);
    expect(choices[0]?.text()).toContain("backend");
    await choices[1]!.trigger("click");
    await t.trigger("keydown", { key: "Enter" });
    expect(deliver).toHaveBeenLastCalledWith("😀 @同名 ", [
      { range: [3, 6], handle: "agent:n:b3" },
    ]);
    expect((t.element as HTMLTextAreaElement).value).toBe("😀 @同名 ");
    await t.setValue("😀 @修改 ");
    await t.trigger("keydown", { key: "Enter" });
    expect(deliver).toHaveBeenLastCalledWith("😀 @修改 ", []);
  });
  it("keeps rejected/uncertain drafts and isolates accepted clearing across scope switches", async () => {
    let resolve!: (s: string) => void;
    const deliver = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const w = input({ deliver }),
      t = w.get("textarea"),
      s = useDirectBotsStore();
    await t.setValue("  first  ");
    await t.trigger("keydown", { key: "Enter" });
    s.activeTopicId = "t2";
    await flushPromises();
    await t.setValue("second");
    resolve("accepted");
    await flushPromises();
    expect((t.element as HTMLTextAreaElement).value).toBe("second");
    s.activeTopicId = "t1";
    await flushPromises();
    expect((t.element as HTMLTextAreaElement).value).toBe("");
    s.activeTopicId = "t2";
    await flushPromises();
    expect((t.element as HTMLTextAreaElement).value).toBe("second");
  });
  it("IME cannot commit or send; unavailable menus hold Enter until dismissed", async () => {
    vi.mocked(api.rpc).mockResolvedValue({
      ...ready(),
      commands: { status: "unavailable", items: [] },
    });
    const w = input(),
      t = w.get("textarea");
    await t.setValue("/");
    await flushPromises();
    await t.trigger("compositionstart");
    await t.trigger("keydown", { key: "Enter", isComposing: false });
    expect(w.emitted("send")).toBeUndefined();
    await t.trigger("compositionend");
    await t.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")).toBeUndefined();
    await t.trigger("keydown", { key: "Escape" });
    await t.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["/", []]);
  });
  it("scope drafts survive unmount and raw typed names carry no refs", async () => {
    const w = input(),
      t = w.get("textarea");
    await t.setValue("raw @同名 ");
    w.unmount();
    wrappers = [];
    const next = input();
    await flushPromises();
    expect((next.get("textarea").element as HTMLTextAreaElement).value).toBe(
      "raw @同名 ",
    );
    expect(
      useDirectComposerStore().get(JSON.stringify(["i1", "c1", "t1", "b1"]))
        .mentions,
    ).toEqual([]);
  });
});

it("clears an identical reference draft on durable WS acceptance even when HTTP loses its response", async () => {
  const s = useDirectBotsStore();
  let fail!: (error: Error) => void;
  vi.mocked(api.rpc).mockImplementation(async (_instance, type) => {
    if (type === "control.conversation.prompt")
      return await new Promise((_resolve, reject) => {
        fail = reject;
      });
    return ready() as never;
  });
  const w = input({
      deliver: (
        text: string,
        mentions: import("@ganglion/xacpx-relay-protocol").AgentMention[],
      ) => s.sendPrompt(text, mentions),
    }),
    t = w.get("textarea");
  await t.setValue("😀 @");
  await flushPromises();
  await w.get('[role="option"]').trigger("click");
  await t.trigger("keydown", { key: "Enter" });
  await flushPromises();
  const requestId = s.currentDraftRequestId!;
  expect(requestId).toBeTruthy();
  s.applyEvent({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "conversation-run-changed",
      run: {
        id: "r1",
        conversationId: "c1",
        topicId: "t1",
        requestMessageId: "m1",
        requestId,
        mode: "explicit",
        state: "queued",
        profileRevision: 1,
        createdAt: "now",
      },
    },
  } as never);
  fail(new Error("response lost"));
  await flushPromises();
  expect((t.element as HTMLTextAreaElement).value).toBe("");
  expect(
    useDirectComposerStore().get(JSON.stringify(["i1", "c1", "t1", "b1"]))
      .mentions,
  ).toEqual([]);
  expect(s.promptError).toBeNull();
});

it("refuses a restored reference draft through an old Hub without sending or losing identity", async () => {
  const s = useDirectBotsStore();
  const refs = [{ range: [0, 3] as [number, number], handle: "agent:n:b2" }];
  const scopeKey = JSON.stringify(["i1", "c1", "t1", "b1"]);
  useDirectComposerStore().set(scopeKey, "@同名 ", refs);
  const prompt = vi.fn();
  let supported = false;
  let unknownType = false;
  vi.mocked(api.rpc).mockImplementation(async (_instance, type) => {
    if (type === "control.conversation.completions.get") return (supported ? { ...ready(), mentions: { status: 'unavailable', items: [] } } : unknownType ? { error: { code: 'unknown-type', message: 'old Hub' } } : { version: 0 }) as never;
    if (type === "control.conversation.prompt") { prompt(); return { error: { code: "test-rejected", message: "retry" } } as never; }
    return {} as never;
  });
  expect(await s.sendPrompt("@同名 ", refs)).toBe("rejected");
  expect(prompt).not.toHaveBeenCalled();
  expect(s.promptError).toBe("connectorOutdated");
  expect(useDirectComposerStore().get(scopeKey)).toEqual({ text: "@同名 ", mentions: refs });
  const requestId = s.currentDraftRequestId;
  unknownType = true;
  expect(await s.sendPrompt("@同名 ", refs)).toBe("rejected");
  expect(prompt).not.toHaveBeenCalled();
  expect(s.promptError).toBe("connectorOutdated");
  supported = true;
  await s.sendPrompt("@同名 ", refs);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(s.currentDraftRequestId).toBe(requestId);
});
