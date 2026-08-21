import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import PromptInput from "../components/PromptInput.vue";
import { useInstancesStore } from "../stores/instances";
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
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe(
      "half-typed",
    );
  });

  it("typing / shows agent-command autocomplete and Enter completes without sending", async () => {
    const { useChatStore } = await import("../stores/chat");
    const chat = useChatStore();
    chat.select("i1", "backend");
    chat.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "agent-commands",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        commands: [
          { name: "compact", description: "Compact the conversation" },
          { name: "clear" },
        ],
      },
    } as never);
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
    chat.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "agent-commands",
        chatKey: "relay:a1",
        sessionAlias: "backend",
        commands: [{ name: "compact" }],
      },
    } as never);
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
    expect(
      (w.get('[data-test="composer-send"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    composer.uploading = true;
    await w.vm.$nextTick();
    expect(
      (w.get('[data-test="composer-send"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("inserts text from a composer store request targeting this session", async () => {
    const { useComposerStore } = await import("../stores/composer");
    const composer = useComposerStore();
    const w = mount(PromptInput, { props: { draftKey: "ins-key" } });
    composer.requestInsert("ins-key", "/status");
    await w.vm.$nextTick();
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe(
      "/status",
    );
    // a request for a different session is ignored
    composer.requestInsert("other", "/help");
    await w.vm.$nextTick();
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe(
      "/status",
    );
  });

  it("typing @ displays agent mention autocomplete from canonical directory and emits structured agentMentions", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-backend",
        displayName: "Backend",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
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

    expect((ta.element as HTMLTextAreaElement).value).toBe(
      "Please check with @Backend ",
    );
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
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-backend",
        displayName: "Backend",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
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
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-backend-1",
        displayName: "Backend",
        agent: "codex",
        workspace: "backend-api",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-2",
        nodeId: "node-2",
        endpointId: "ep-backend-2",
        displayName: "Backend",
        agent: "claude",
        workspace: "billing-service",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
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

  it("Test A: custom display name renders primary @displayName and secondary sessionAlias · workspace · agent", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-12345",
        endpointId: "ep-1",
        displayName: "发布机器人",
        sessionAlias: "omp-2",
        agent: "codex",
        workspace: "weacpx-github",
        state: "running",
        activity: { status: "working", summary: "Building release" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @发布");
    await ta.trigger("input");
    await w.vm.$nextTick();

    expect(w.find('[data-test="mention-menu"]').exists()).toBe(true);
    const item = w.find('[data-test="mention-item"]');
    expect(item.find('[data-test="mention-primary"]').text()).toBe(
      "@发布机器人",
    );
    expect(item.find('[data-test="mention-secondary"]').text()).toBe(
      "omp-2 · weacpx-github · codex",
    );
    expect(item.find('[data-test="mention-activity"]').text()).toBe("Working");

    // Selecting binds canonical handle
    await ta.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();
    await ta.trigger("keydown", { key: "Enter" });

    expect(w.emitted("send")?.[0]).toEqual([
      "Ask @发布机器人",
      [],
      [
        {
          range: [4, 10],
          handle: "agent:node-12345:ep-1",
        },
      ],
    ]);
  });

  it("Test B: no custom display name (displayName === sessionAlias) does not duplicate alias", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-12345",
        endpointId: "ep-1",
        displayName: "omp-2",
        sessionAlias: "omp-2",
        agent: "codex",
        workspace: "weacpx-github",
        state: "idle",
        activity: { status: "idle" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @omp");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const item = w.find('[data-test="mention-item"]');
    expect(item.find('[data-test="mention-primary"]').text()).toBe("@omp-2");
    expect(item.find('[data-test="mention-secondary"]').text()).toBe(
      "weacpx-github · codex",
    );
    expect(item.find('[data-test="mention-secondary"]').text()).not.toContain(
      "omp-2 · omp-2",
    );
    expect(item.find('[data-test="mention-activity"]').text()).toBe("Idle");
  });

  it("Test C: search by sessionAlias finds agent with custom displayName", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-1",
        displayName: "发布机器人",
        sessionAlias: "omp-2",
        agent: "codex",
        workspace: "weacpx-github",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    // Type @omp which matches sessionAlias 'omp-2' even though displayName is '发布机器人'
    await ta.setValue("Ask @omp");
    await ta.trigger("input");
    await w.vm.$nextTick();

    expect(w.find('[data-test="mention-menu"]').exists()).toBe(true);
    const item = w.find('[data-test="mention-item"]');
    expect(item.find('[data-test="mention-primary"]').text()).toBe(
      "@发布机器人",
    );
    expect(item.find('[data-test="mention-secondary"]').text()).toBe(
      "omp-2 · weacpx-github · codex",
    );
  });

  it("Test D & E: duplicate displayNames render distinct human metadata and no normal nodeId exposure", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node_4c860598-e4ba-4205-ad59-08f0fb683dbc",
        endpointId: "ep_789123456_a",
        displayName: "Backend",
        sessionAlias: "backend-api",
        agent: "claude",
        workspace: "xacpx",
        state: "running",
        activity: { status: "working" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-2",
        nodeId: "node_99887766-aaaa-bbbb-cccc-112233445566",
        endpointId: "ep_789123456_b",
        displayName: "Backend",
        sessionAlias: "billing-service",
        agent: "codex",
        workspace: "billing",
        state: "idle",
        activity: { status: "idle" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ping @Back");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@Backend",
    );
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "backend-api · xacpx · claude",
    );
    // Test E: assert full nodeId/endpointId is NOT in normal row text
    expect(items[0].text()).not.toContain(
      "node_4c860598-e4ba-4205-ad59-08f0fb683dbc",
    );
    expect(items[0].text()).not.toContain("ep_789123456_a");

    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@Backend",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "billing-service · billing · codex",
    );
    expect(items[1].text()).not.toContain(
      "node_99887766-aaaa-bbbb-cccc-112233445566",
    );
    expect(items[1].text()).not.toContain("ep_789123456_b");

    // Select second item
    await ta.trigger("keydown", { key: "ArrowDown" });
    await ta.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();
    await ta.trigger("keydown", { key: "Enter" });

    expect(w.emitted("send")?.[0]).toEqual([
      "Ping @Backend",
      [],
      [
        {
          range: [5, 13],
          handle:
            "agent:node_99887766-aaaa-bbbb-cccc-112233445566:ep_789123456_b",
        },
      ],
    ]);
  });

  it("Test F: Session Tree consistency under workspace grouped mode", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const { sessionPresentationName } =
      await import("../lib/sidebar-group-mode");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "MacBook Air", online: true, sessionsLoaded: true },
    ] as never;
    instances.setGroupMode("inst-1", "workspace");

    // Session in workspace "weacpx-github" with alias "weacpx-github-omp-2"
    const sessionAlias = "weacpx-github-omp-2";
    const workspace = "weacpx-github";

    // 1. Shared helper (also used by InstanceTree.vue rowName) returns "omp-2"
    const treeRowName = sessionPresentationName({
      alias: sessionAlias,
      workspace,
      agent: "codex",
      groupMode: instances.groupModeFor("inst-1"),
    });
    expect(treeRowName).toBe("omp-2");

    // 2. PromptInput autocomplete directory item from inst-1
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-1",
        sessionAlias,
        agent: "codex",
        workspace,
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @omp");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const item = w.find('[data-test="mention-item"]');
    // The primary name MUST match the Session Tree grouped presentation ("omp-2"), NOT "weacpx-github-omp-2"
    expect(item.find('[data-test="mention-primary"]').text()).toBe("@omp-2");
    expect(item.find('[data-test="mention-secondary"]').text()).toBe(
      "weacpx-github · codex",
    );
  });

  it("Test G: duplicate displayNames across Relay instances disambiguate using instance name, not technical nodeId", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-mac", name: "MacBook Air", online: true },
      { id: "inst-dev", name: "Dev Server", online: true },
    ] as never;

    instances.agentDirectory = [
      {
        instanceId: "inst-mac",
        nodeId: "node_4c860598-e4ba-4205-ad59-08f0fb683dbc",
        endpointId: "ep_1",
        displayName: "Backend",
        sessionAlias: "backend",
        agent: "codex",
        workspace: "xacpx",
        state: "running",
        activity: { status: "working" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-dev",
        nodeId: "node_99887766-aaaa-bbbb-cccc-112233445566",
        endpointId: "ep_2",
        displayName: "Backend",
        sessionAlias: "backend",
        agent: "codex",
        workspace: "xacpx",
        state: "idle",
        activity: { status: "idle" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ping @Back");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    // Both have exact same (displayName, sessionAlias, workspace, agent).
    // They MUST disambiguate via Relay instance names (MacBook Air / Dev Server)
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "backend · xacpx · codex · MacBook Air",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "backend · xacpx · codex · Dev Server",
    );

    // Must NOT contain technical nodeId suffix
    expect(items[0].text()).not.toContain("…83dbc");
    expect(items[1].text()).not.toContain("…45566");
  });
  it("Test H: activity badges display localized strings and deterministic ranking", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-1",
        displayName: "发布机器人",
        sessionAlias: "omp-2",
        agent: "codex",
        workspace: "weacpx-github",
        state: "running",
        activity: { status: "working" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-2",
        displayName: "omp-builder",
        sessionAlias: "omp-builder",
        agent: "codex",
        workspace: "weacpx-github",
        state: "idle",
        activity: { status: "waiting" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("@omp");
    await ta.trigger("input");
    await w.vm.$nextTick();
    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);
    // omp-builder has displayName prefix match (rank 3), while 发布机器人 has sessionAlias prefix match (rank 4)
    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@omp-builder",
    );
    expect(items[0].find('[data-test="mention-activity"]').text()).toBe(
      "Waiting",
    );

    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@发布机器人",
    );
    expect(items[1].find('[data-test="mention-activity"]').text()).toBe(
      "Working",
    );
  });

  it("Test I: same instance duplicate endpoints disambiguate with endpointId suffix", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "MacBook Air", online: true },
    ] as never;

    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_worker_1234a",
        displayName: "Reviewer",
        agent: "claude",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_worker_5678b",
        displayName: "Reviewer",
        agent: "claude",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @Rev");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    // Both are on the SAME instance with the same human metadata.
    // They MUST append endpointId technical suffix to guarantee unique distinction!
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "project · claude · MacBook Air · …1234a",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "project · claude · MacBook Air · …5678b",
    );

    // Selecting the second binds the second endpoint
    await ta.trigger("keydown", { key: "ArrowDown" });
    await ta.trigger("keydown", { key: "Enter" });
    await w.vm.$nextTick();
    await ta.trigger("keydown", { key: "Enter" });

    expect(w.emitted("send")?.[0]).toEqual([
      "Ask @Reviewer",
      [],
      [
        {
          range: [4, 13],
          handle: "agent:node-1:ep_worker_5678b",
        },
      ],
    ]);
  });

  it("Test J: instances with duplicate name disambiguate using endpointId suffix", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    // Two different instances legally sharing the same name "Dev Server"
    instances.instances = [
      { id: "inst-1", name: "Dev Server", online: true },
      { id: "inst-2", name: "Dev Server", online: true },
    ] as never;

    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_aaaa_11111",
        displayName: "Backend",
        sessionAlias: "backend",
        agent: "codex",
        workspace: "xacpx",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-2",
        nodeId: "node-2",
        endpointId: "ep_bbbb_22222",
        displayName: "Backend",
        sessionAlias: "backend",
        agent: "codex",
        workspace: "xacpx",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ping @Back");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "backend · xacpx · codex · Dev Server · …11111",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "backend · xacpx · codex · Dev Server · …22222",
    );
  });

  it("Test K: full-field ranking ensures exact matches on workspace/agent beat prefix matches on displayName", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-1",
        displayName: "codex-helper",
        sessionAlias: "codex-helper",
        agent: "claude",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-2",
        displayName: "Helper",
        sessionAlias: "helper",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-3",
        displayName: "xacpx-runner",
        sessionAlias: "xacpx-runner",
        agent: "claude",
        workspace: "other",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-4",
        displayName: "Runner",
        sessionAlias: "runner",
        agent: "claude",
        workspace: "xacpx",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");

    // 1. Query @codex: exact match on agent (ep-2: Helper) MUST beat prefix match on displayName (ep-1: codex-helper)
    await ta.setValue("@codex");
    await ta.trigger("input");
    await w.vm.$nextTick();

    let items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);
    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@Helper",
    );
    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@codex-helper",
    );

    // 2. Query @xacpx: exact match on workspace (ep-4: Runner) MUST beat prefix match on displayName (ep-3: xacpx-runner)
    await ta.setValue("@xacpx");
    await ta.trigger("input");
    await w.vm.$nextTick();

    items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);
    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@Runner",
    );
    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@xacpx-runner",
    );
  });

  it("Test L: activity fallback normalizes from state when activity field is omitted", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-1",
        displayName: "RunningBot",
        agent: "codex",
        workspace: "project",
        state: "running",
        // activity omitted (e.g. older connector or state-only publish)
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-2",
        displayName: "IdleBot",
        agent: "codex",
        workspace: "project",
        state: "idle",
        // activity omitted
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("@Bot");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);
    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@IdleBot",
    );
    expect(items[0].find('[data-test="mention-activity"]').text()).toBe("Idle");
    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@RunningBot",
    );
    expect(items[1].find('[data-test="mention-activity"]').text()).toBe(
      "Working",
    );
  });

  it("Test M: shortest unique suffix dynamically expands when last 5 characters of endpointId collide", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "MacBook Air", online: true },
    ] as never;

    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "endpoint_worker_A12345",
        displayName: "Reviewer",
        agent: "claude",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "endpoint_worker_B12345",
        displayName: "Reviewer",
        agent: "claude",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @Rev");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    // Both end with "12345" (5 chars collision).
    // The suffix MUST dynamically expand to 6 characters ("…A12345" vs "…B12345") to guarantee uniqueness!
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "project · claude · MacBook Air · …A12345",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "project · claude · MacBook Air · …B12345",
    );
  });

  it("Test N: cross-node identical endpointIds with duplicate instance names dynamically expand to include node discriminator", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "Dev Server", online: true },
      { id: "inst-2", name: "Dev Server", online: true },
    ] as never;

    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-alpha",
        endpointId: "endpoint_worker_default",
        displayName: "Backend",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-2",
        nodeId: "node-beta",
        endpointId: "endpoint_worker_default",
        displayName: "Backend",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
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

    // endpointId is identical across two nodes ("endpoint_worker_default").
    // The suffix MUST dynamically expand until the node discriminator is included!
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "project · codex · Dev Server · …ha:endpoint_worker_default",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "project · codex · Dev Server · …ta:endpoint_worker_default",
    );
  });

  it("Test O: group mode folding different raw aliases into same presentation alias correctly triggers Level-3 disambiguation", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "MacBook Air", online: true },
    ] as never;
    instances.setGroupMode("inst-1", "workspace");

    // Two endpoints on the same instance:
    // raw alias "project-review" folds to "review" under workspace mode
    // raw alias "review" is already "review"
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_aaaa_1",
        displayName: "Reviewer",
        sessionAlias: "project-review",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_bbbb_2",
        displayName: "Reviewer",
        sessionAlias: "review",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @Rev");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    // Both display @Reviewer with visible presentation alias "review", "project", "codex", "MacBook Air".
    // Because the VISIBLE Level-1 metadata and nodeLabel collide, Level-3 routing suffix MUST trigger!
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "review · project · codex · MacBook Air · …aaa_1",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "review · project · codex · MacBook Air · …bbb_2",
    );
  });

  it("Test P: search ranking matches visible presentation alias as exact match over displayName prefix match", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "MacBook Air", online: true },
    ] as never;
    instances.setGroupMode("inst-1", "workspace");

    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-1",
        displayName: "发布机器人",
        sessionAlias: "weacpx-github-omp-2", // folds to visible presentation alias "omp-2"
        agent: "codex",
        workspace: "weacpx-github",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-2",
        displayName: "omp-2-helper",
        sessionAlias: "omp-2-helper",
        agent: "claude",
        workspace: "weacpx-github",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    // User types @omp-2:
    // ep-1 has visible presentation alias "omp-2" (Exact match, Rank 12)
    // ep-2 has displayName "omp-2-helper" (Prefix match, Rank 21)
    await ta.setValue("@omp-2");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    // Exact match on visible presentation alias MUST rank #1!
    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@发布机器人",
    );
    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@omp-2-helper",
    );
  });

  it("Test Q: collision key aligns with visible secondary parts when one endpoint has custom displayName and another does not", async () => {
    const { useInstancesStore } = await import("../stores/instances");
    const instances = useInstancesStore();
    instances.instances = [
      { id: "inst-1", name: "MacBook Air", online: true },
    ] as never;
    instances.setGroupMode("inst-1", "workspace");

    // Endpoint A: custom displayName "review", raw sessionAlias "project-review" (folds to "review" under workspace mode)
    // Endpoint B: no custom displayName, raw sessionAlias "review" (folds to "review" under workspace mode)
    // Both render primary: @review
    // Both render initial secondary: project · codex
    // Level-3 routing suffix MUST trigger to disambiguate!
    instances.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_aaaa_1",
        displayName: "review",
        sessionAlias: "project-review",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep_bbbb_2",
        sessionAlias: "review",
        agent: "codex",
        workspace: "project",
        state: "idle",
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
        },
        updatedAt: Date.now(),
      },
    ];

    const w = mount(PromptInput);
    const ta = w.find("textarea");
    await ta.setValue("Ask @rev");
    await ta.trigger("input");
    await w.vm.$nextTick();

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);

    expect(items[0].find('[data-test="mention-primary"]').text()).toBe(
      "@review",
    );
    expect(items[0].find('[data-test="mention-secondary"]').text()).toBe(
      "project · codex · MacBook Air · …aaa_1",
    );

    expect(items[1].find('[data-test="mention-primary"]').text()).toBe(
      "@review",
    );
    expect(items[1].find('[data-test="mention-secondary"]').text()).toBe(
      "project · codex · MacBook Air · …bbb_2",
    );
  });

  it("v0.3 Gate D & Self: mounted PromptInput ranks @ mentions by context tier and excludes self", async () => {
    const instancesStore = useInstancesStore();
    instancesStore.instances = [
      {
        id: "inst-1",
        name: "Local Instance",
        sessions: [
          { alias: "current-session", workspace: "xacpx", agent: "codex" } as unknown as (typeof instancesStore.instances)[number]["sessions"][number],
          { alias: "same-inst-other-ws", workspace: "other-ws", agent: "codex" } as unknown as (typeof instancesStore.instances)[number]["sessions"][number],
        ],
      } as unknown as (typeof instancesStore.instances)[number],
      {
        id: "inst-2",
        name: "Remote Instance",
        sessions: [
          { alias: "remote-same-ws", workspace: "xacpx", agent: "claude" } as unknown as (typeof instancesStore.instances)[number]["sessions"][number],
          { alias: "remote-other-ws", workspace: "other-ws", agent: "claude" } as unknown as (typeof instancesStore.instances)[number]["sessions"][number],
        ],
      } as unknown as (typeof instancesStore.instances)[number],
    ];

    instancesStore.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-self",
        sessionAlias: "current-session",
        displayName: "Self Agent",
        agent: "codex",
        workspace: "xacpx",
        endpointKind: "logical",
        channelId: "relay",
      } as unknown as (typeof instancesStore.agentDirectory)[number],
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-same-inst",
        sessionAlias: "same-inst-other-ws",
        displayName: "Same Inst Other Ws",
        agent: "codex",
        workspace: "other-ws",
        endpointKind: "logical",
        channelId: "relay",
      } as unknown as (typeof instancesStore.agentDirectory)[number],
      {
        instanceId: "inst-2",
        nodeId: "node-2",
        endpointId: "ep-remote-same-ws",
        sessionAlias: "remote-same-ws",
        displayName: "Remote Same Ws",
        agent: "claude",
        workspace: "xacpx",
        endpointKind: "logical",
        channelId: "relay",
      } as unknown as (typeof instancesStore.agentDirectory)[number],
      {
        instanceId: "inst-2",
        nodeId: "node-2",
        endpointId: "ep-remote-other-ws",
        sessionAlias: "remote-other-ws",
        displayName: "Remote Other Ws",
        agent: "claude",
        workspace: "other-ws",
        endpointKind: "logical",
        channelId: "relay",
      } as unknown as (typeof instancesStore.agentDirectory)[number],
    ];

    const w = mount(PromptInput, {
      props: {
        instanceId: "inst-1",
        sessionAlias: "current-session",
      },
      attachTo: document.body,
    });

    const ta = w.find("textarea");
    await ta.setValue("@");
    await ta.trigger("input");

    const items = w.findAll('[data-test="mention-item"]');
    // Self excluded → 3 items remaining
    expect(items.length).toBe(3);
    // Order: Tier 0 (same ws: Remote Same Ws) -> Tier 1 (same inst: Same Inst Other Ws) -> Tier 2 (Remote Other Ws)
    expect(items[0].find('[data-test="mention-primary"]').text()).toBe("@Remote Same Ws");
    expect(items[1].find('[data-test="mention-primary"]').text()).toBe("@Same Inst Other Ws");
    expect(items[2].find('[data-test="mention-primary"]').text()).toBe("@Remote Other Ws");
  });

  it("v0.3 Gate G: non-Relay and worker candidates are labeled visibly in secondary line", async () => {
    const instancesStore = useInstancesStore();
    instancesStore.instances = [{ id: "inst-1", name: "Main", sessions: [] } as unknown as (typeof instancesStore.instances)[number]];
    instancesStore.agentDirectory = [
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-worker",
        sessionAlias: "worker-1",
        displayName: "Review Worker",
        agent: "codex",
        workspace: "xacpx",
        endpointKind: "worker",
      } as unknown as (typeof instancesStore.agentDirectory)[number],
      {
        instanceId: "inst-1",
        nodeId: "node-1",
        endpointId: "ep-wechat",
        sessionAlias: "wechat-bot",
        displayName: "WeChat Reviewer",
        agent: "claude",
        workspace: "xacpx",
        endpointKind: "logical",
        channelId: "weixin",
      } as unknown as (typeof instancesStore.agentDirectory)[number],
    ];

    const w = mount(PromptInput, {
      props: { instanceId: "inst-1", sessionAlias: "active-session" },
      attachTo: document.body,
    });

    const ta = w.find("textarea");
    await ta.setValue("@");
    await ta.trigger("input");

    const items = w.findAll('[data-test="mention-item"]');
    expect(items.length).toBe(2);
    expect(items[0].find('[data-test="mention-secondary"]').text()).toContain("Worker");
    expect(items[1].find('[data-test="mention-secondary"]').text()).toContain("WeChat");
  });
});
