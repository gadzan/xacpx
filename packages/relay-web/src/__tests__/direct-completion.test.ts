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
