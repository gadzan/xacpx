import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionRequestDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";

const mockRpc = vi.fn();
const mockApiGet = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    rpc: (instanceId: string, type: string, payload?: unknown) => mockRpc(instanceId, type, payload),
    get: (path: string) => mockApiGet(path),
  },
}));
// ChatPane mounts MessageList → AgentIcon → the brand-SVG bundle, which Node
// cannot open on some Windows boxes (EPERM). Stub it like the other pane tests.
vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import { useChatStore } from "../stores/chat";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import ChatPane from "../components/ChatPane.vue";

/**
 * Session-scoped forms: an agent asking its operator a structured question
 * through an ordinary session chat.
 *
 * A session turn has no Conversation product row, so everything placement-related
 * is keyed by the turn's own session alias instead. These pin the two decisions
 * the browser owns: which pane the form belongs to, and which entry an answer is
 * applied to.
 */
describe("session-scoped interaction forms", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockRpc.mockReset();
    mockApiGet.mockReset();
    mockApiGet.mockResolvedValue({ instances: [] });
  });

  function formRequest(overrides: Partial<InteractionRequestDto> = {}): InteractionRequestDto {
    return {
      requestId: "req-session-1",
      kind: "elicitation",
      // No `conversation`: that absence is exactly what makes this a session form.
      sessionAlias: "relay:demo",
      expiresAt: Date.now() + 60_000,
      elicitation: {
        mode: "form",
        agent: { name: "codex", sessionAlias: "relay:demo" },
        message: "Which environment?",
        fields: [{ kind: "text", key: "env", title: "Environment", required: true }],
      },
      ...overrides,
    };
  }

  function openedEvent(
    request: InteractionRequestDto,
    instanceId = "inst_1",
    sessionAlias = "relay:demo",
  ): WebServerEvent {
    return {
      kind: "control-event",
      instanceId,
      event: {
        type: "interaction-opened",
        chatKey: "relay:acct-9",
        sessionAlias,
        instanceId,
        interaction: request,
      },
    } as unknown as WebServerEvent;
  }

  it("shows only the form belonging to the exact instance and session alias", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    expect(store.pendingSessionInteractionFor("inst_1", "relay:demo")?.request.requestId)
      .toBe("req-session-1");

    // Another session, another instance, and a missing selection all mean "not
    // this pane". Aliases are only unique per instance, so both keys matter.
    expect(store.pendingSessionInteractionFor("inst_1", "relay:other")).toBeNull();
    expect(store.pendingSessionInteractionFor("inst_2", "relay:demo")).toBeNull();
    expect(store.pendingSessionInteractionFor(null, "relay:demo")).toBeNull();
    expect(store.pendingSessionInteractionFor("inst_1", null)).toBeNull();
  });

  it("never lends a conversation form to a session pane", () => {
    // A Direct Bot form is placed by its topic. Rendering it here would put one
    // turn's question into another turn's transcript.
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest({
      sessionAlias: undefined,
      conversation: { conversationId: "c1", topicId: "t1" },
    })));
    expect(store.pendingSessionInteractionFor("inst_1", "relay:demo")).toBeNull();
  });

  it("drops the form from the session pane once the hub closes it", () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    store.applyEvent({
      kind: "control-event",
      instanceId: "inst_1",
      event: {
        type: "interaction-closed",
        chatKey: "relay:acct-9",
        sessionAlias: "relay:demo",
        instanceId: "inst_1",
        requestId: "req-session-1",
        reason: "withdrawn",
      },
    } as unknown as WebServerEvent);
    const shown = store.pendingSessionInteractionFor("inst_1", "relay:demo");
    // A terminal entry is still shown once, so the user learns why it went away.
    expect(shown?.outcome).toBe("withdrawn");
    expect(store.requestStillHeld("req-session-1")).toBe(false);
  });

  it("answers the session's own form, not the Direct Bot pane's", async () => {
    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));
    const target = store.pendingSessionInteractionFor("inst_1", "relay:demo");
    expect(target).not.toBeNull();

    store.setInteractionAnswer("env", "prod", target);
    // Read back through the getter: a patch replaces the entry, so the object the
    // caller passed in is a snapshot of the form BEFORE the edit.
    const updated = store.pendingSessionInteractionFor("inst_1", "relay:demo");
    expect(updated!.answers).toEqual({ env: "prod" });
    // The Direct Bot visible form is a different slot and stays empty.
    expect(store.pendingInteraction).toBeNull();

    await store.submitInteraction("accept", updated);
    expect(mockRpc).toHaveBeenCalledWith("inst_1", "control.interaction.respond", {
      requestId: "req-session-1",
      kind: "elicitation",
      action: "accept",
      content: { env: "prod" },
    });
  });

  it("renders the open form in the session chat pane", async () => {
    const instances = useInstancesStore();
    instances.instances.push({
      id: "inst_1", name: "prod-box", online: true, lastSeenAt: null,
      sessions: [{ alias: "relay:demo", agent: "codex", workspace: "gaia" }],
      agents: [], workspaces: [], agentCatalog: [],
    } as never);
    const chat = useChatStore();
    chat.select("inst_1", "relay:demo");

    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));

    const w = mount(ChatPane);
    await w.vm.$nextTick();
    const form = w.find('[data-test="interaction-form"]');
    expect(form.exists()).toBe(true);
    // The agent that asked is shown as identity, never inferred from the message.
    expect(form.text()).toContain("codex");
  });

  it("shows no form in a session that was not asked", async () => {
    const instances = useInstancesStore();
    instances.instances.push({
      id: "inst_1", name: "prod-box", online: true, lastSeenAt: null,
      sessions: [
        { alias: "relay:demo", agent: "codex", workspace: "gaia" },
        { alias: "relay:other", agent: "codex", workspace: "gaia" },
      ],
      agents: [], workspaces: [], agentCatalog: [],
    } as never);
    const chat = useChatStore();
    chat.select("inst_1", "relay:other");

    const store = useDirectBotsStore();
    store.applyEvent(openedEvent(formRequest()));

    const w = mount(ChatPane);
    await w.vm.$nextTick();
    expect(w.find('[data-test="interaction-form"]').exists()).toBe(false);
  });
});
