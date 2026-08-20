import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import PromptInput from "../components/PromptInput.vue";

// PromptInput now uses the composer store, which needs an active pinia.
beforeEach(() => setActivePinia(createPinia()));

describe("PromptInput composer", () => {
  it("does not surface an xacpx slash-command popover (web forwards `/` to the agent)", async () => {
    const w = mount(PromptInput);
    await w.find("textarea").setValue("/se");
    // The dashboard is GUI-first: typing `/` no longer pops a command catalog.
    expect(w.find('[data-test="cmd-suggestions"]').exists()).toBe(false);
  });

  it("uses a 16px textarea on mobile (iOS auto-zoom guard) and 14px on desktop", () => {
    const w = mount(PromptInput);
    const cls = w.find("textarea").classes();
    expect(cls).toContain("text-[16px]");
    expect(cls).toContain("lg:text-[14px]");
  });

  it("Enter submits a `/`-prefixed message verbatim (no autocomplete interception)", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("/status");
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["/status", []]);
  });

  it("Enter sends a plain message and records it in history for ↑ recall", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("hello there");
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["hello there", []]);
    expect((ta.element as HTMLTextAreaElement).value).toBe(""); // cleared
    // Caret at start of an empty field → ArrowUp recalls the last sent line.
    await ta.trigger("keydown", { key: "ArrowUp" });
    expect((ta.element as HTMLTextAreaElement).value).toBe("hello there");
  });

  it("ignores Enter mid-IME-composition (CJK input)", async () => {
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("你好");
    await ta.trigger("keydown", { key: "Enter", isComposing: true });
    expect(w.emitted("send")).toBeFalsy(); // composition confirm, not submit
  });

  it("persists a per-session draft and restores it when the key returns", async () => {
    sessionStorage.clear();
    const w = mount(PromptInput, { props: { draftKey: "k1" } });
    await w.find("textarea").setValue("half-typed");
    await w.setProps({ draftKey: "k2" }); // switch session → draft stashed, k2 empty
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("");
    await w.setProps({ draftKey: "k1" }); // back → restored
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("half-typed");
  });

  it("typing / shows agent-command autocomplete and Enter completes without sending", async () => {
    const { useChatStore } = await import("../stores/chat");
    const chat = useChatStore();
    chat.select("i1", "backend");
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: {
      type: "agent-commands", chatKey: "relay:a1", sessionAlias: "backend",
      commands: [{ name: "compact", description: "Compact the conversation" }, { name: "clear" }],
    } } as never);
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("/co");
    await w.vm.$nextTick();
    const items = w.findAll('[data-test="cmd-item"]');
    expect(items.length).toBe(1); // only /compact matches "/co"
    expect(items[0].text()).toContain("/compact");
    // Enter completes the command (and does NOT submit the turn).
    await ta.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();
    expect((ta.element as HTMLTextAreaElement).value).toBe("/compact ");
    expect(w.emitted("send")).toBeFalsy();
  });

  it("closes the agent-command menu once the token is no longer a bare /word", async () => {
    const { useChatStore } = await import("../stores/chat");
    const chat = useChatStore();
    chat.select("i1", "backend");
    chat.applyEvent({ kind: "control-event", instanceId: "i1", event: {
      type: "agent-commands", chatKey: "relay:a1", sessionAlias: "backend",
      commands: [{ name: "compact" }],
    } } as never);
    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("/co");
    await w.vm.$nextTick();
    expect(w.find('[data-test="cmd-menu"]').exists()).toBe(true);
    // A space ends the command token → menu closes and Enter submits verbatim.
    await ta.setValue("/compact now");
    await w.vm.$nextTick();
    expect(w.find('[data-test="cmd-menu"]').exists()).toBe(false);
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["/compact now", []]);
  });

  it("disables the send button while an upload is in flight (no silent dead click)", async () => {
    const { useComposerStore } = await import("../stores/composer");
    const composer = useComposerStore();
    const w = mount(PromptInput);
    await w.find("textarea").setValue("ready to go"); // would normally enable Send
    expect((w.get('[data-test="composer-send"]').element as HTMLButtonElement).disabled).toBe(false);
    composer.uploading = true;
    await w.vm.$nextTick();
    expect((w.get('[data-test="composer-send"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it("inserts text from a composer store request targeting this session", async () => {
    const { useComposerStore } = await import("../stores/composer");
    const composer = useComposerStore();
    const w = mount(PromptInput, { props: { draftKey: "ins-key" } });
    composer.requestInsert("ins-key", "/status");
    await w.vm.$nextTick();
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("/status");
    // a request for a different session is ignored
    composer.requestInsert("other", "/help");
    await w.vm.$nextTick();
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("/status");
  });

  it("typing @ displays agent mention autocomplete from canonical directory and emits structured agentMentions", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        nodeId: "node-1",
        endpointId: "ep-backend",
        displayName: "Backend",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false, conversation: true },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Please check with @Back");
    await ta.trigger("input");
    await w.vm.$nextTick();

    expect(w.find('[data-test="mention-menu"]').exists()).toBe(true);
    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(1);
    expect(items[0].text()).toContain("@Backend");

    // Enter selects the mention
    await ta.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();

    expect((ta.element as HTMLTextAreaElement).value).toBe("Please check with @Backend ");
    expect(w.find('[data-test="mention-menu"]').exists()).toBe(false);

    // Submit
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual([
      "Please check with @Backend",
      [],
      [
        {
          range: [18, 26],
          handle: "agent:node-1:ep-backend",
        },
      ],
    ]);
  });

  it("negative gate: typing raw @Backend without autocomplete selection does NOT produce structured agentMentions", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        nodeId: "node-1",
        endpointId: "ep-backend",
        displayName: "Backend",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false, conversation: true },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    // User types raw text with @Backend but never interacts with/picks from autocomplete dropdown
    await ta.setValue("Please check with @Backend directly");
    // User hits Escape to close dropdown, then Enter to send
    await ta.trigger("keydown", { key: "Escape" });
    await w.vm.$nextTick();
    await ta.trigger("keydown", { key: "Enter" });

    // Must NOT auto-upgrade raw text to structured mentions
    expect(w.emitted("send")?.[0]).toEqual([
      "Please check with @Backend directly",
      [],
    ]);
  });

  it("negative gate: selecting between duplicate displayName agents binds ONLY the selected canonical endpoint", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        nodeId: "node-1",
        endpointId: "ep-backend-1",
        displayName: "Backend",
        agent: "codex",
        workspace: "backend-api",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false, conversation: true },
        updatedAt: Date.now(),
      },
      {
        nodeId: "node-2",
        endpointId: "ep-backend-2",
        displayName: "Backend",
        agent: "claude",
        workspace: "billing-service",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false, conversation: true },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @Back");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    // Arrow down to pick the second one ("billing-service" on node-2)
    await ta.trigger("keydown", { key: "ArrowDown" });
    await ta.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();

    // Submit
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual([
      "Ask @Backend",
      [],
      [
        {
          range: [4, 12],
          handle: "agent:node-2:ep-backend-2", // ONLY the selected endpoint
        },
      ],
    ]);
  });
});
