import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ConversationMessageDto } from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import DispatchedSessionCard from "../components/DispatchedSessionCard.vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useSplitLayoutStore, primaryKeyFor } from "../stores/split-layout";

vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

const NOW = "2026-11-07T00:00:00.000Z";

function message(patch: Partial<ConversationMessageDto> = {}): ConversationMessageDto {
  return {
    id: "m1",
    conversationId: "c1",
    topicId: "t1",
    seq: 1,
    role: "system",
    content: "",
    createdAt: NOW,
    dispatchedSession: {
      sessionAlias: "worker-1",
      displayName: "Worker One",
      agent: "codex",
      workspace: "home",
    },
    ...patch,
  } as ConversationMessageDto;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
});

describe("DispatchedSessionCard", () => {
  it("renders name/agent/workspace/status and opens via reopenDispatchedSession", async () => {
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1",
        name: "pc",
        online: true,
        lastSeenAt: null,
        sessions: [
          { alias: "worker-1", agent: "codex", workspace: "home", transportSession: "t", running: true, archived: false },
          { alias: "primary", agent: "codex", workspace: "home", transportSession: "t2", running: false, archived: false },
        ],
        sessionsLoaded: true,
        agents: [],
        workspaces: [],
      },
    ] as never;
    const chat = useChatStore();
    chat.select("i1", "primary");

    const wrapper = mount(DispatchedSessionCard, {
      props: { message: message(), instanceId: "i1" },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="dispatched-session-card"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="dispatched-session-name"]').text()).toContain("Worker One");
    expect(wrapper.find('[data-test="dispatched-session-agent"]').text()).toContain("codex");
    expect(wrapper.find('[data-test="dispatched-session-workspace"]').text()).toContain("home");
    expect(wrapper.find('[data-test="dispatched-session-status"]').text()).toContain("Running");

    const split = useSplitLayoutStore();
    const spy = vi.spyOn(split, "reopenDispatchedSession");
    await wrapper.find('[data-test="dispatched-session-open"]').trigger("click");
    const primary = primaryKeyFor({ kind: "session", instanceId: "i1", sessionAlias: "primary" });
    expect(spy).toHaveBeenCalledWith(primary, "i1", "worker-1");
    wrapper.unmount();
  });

  it("shows idle when no matching running session row exists", () => {
    const instances = useInstancesStore();
    instances.instances = [
      {
        id: "i1",
        name: "pc",
        online: true,
        lastSeenAt: null,
        sessions: [{ alias: "worker-1", agent: "codex", workspace: "home", transportSession: "t", running: false, archived: false }],
        sessionsLoaded: true,
        agents: [],
        workspaces: [],
      },
    ] as never;
    const wrapper = mount(DispatchedSessionCard, {
      props: { message: message(), instanceId: "i1" },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="dispatched-session-status"]').attributes("data-state")).toBe("idle");
    wrapper.unmount();
  });

  it("renders nothing without a dispatchedSession", () => {
    const wrapper = mount(DispatchedSessionCard, {
      props: { message: message({ dispatchedSession: undefined, content: "plain system" }) as ConversationMessageDto, instanceId: "i1" },
      global: { plugins: [i18n] },
    });
    expect(wrapper.find('[data-test="dispatched-session-card"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
