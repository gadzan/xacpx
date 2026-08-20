import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../lib/agent-icons", () => ({ agentIconSvg: () => null }));

import AgentMessageCard from "../components/AgentMessageCard.vue";
import type { PeerMessageHistoryEntry } from "@ganglion/xacpx-relay-protocol";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("AgentMessageCard", () => {
  it("renders sender card with 'Sent to', peer displayName, agent, workspace, and content", () => {
    const message: PeerMessageHistoryEntry = {
      kind: "agent_message",
      direction: "sent",
      messageId: "msg_1",
      conversationId: "conv_1",
      peer: {
        handle: "agent:node_2:endpoint_b",
        displayName: "Backend Specialist",
        agent: "codex",
        workspace: "server",
      },
      content: "User schema changed: legacy_id has been removed.",
      createdAt: 1771234567890,
      status: "sent",
    };

    const wrapper = mount(AgentMessageCard, {
      props: { message },
    });

    expect(wrapper.find('[data-test="agent-message-card"]').exists()).toBe(true);
    expect(wrapper.attributes("data-direction")).toBe("sent");
    expect(wrapper.find('[data-test="direction-sent"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="peer-name"]').text()).toBe("Backend Specialist");
    expect(wrapper.find('[data-test="peer-agent"]').text()).toContain("codex");
    expect(wrapper.find('[data-test="peer-workspace"]').text()).toContain("server");
    expect(wrapper.text()).toContain("User schema changed: legacy_id has been removed.");
  });

  it("renders receiver card with 'From', peer fallback handle when no displayName, and delivered status", () => {
    const message: PeerMessageHistoryEntry = {
      kind: "agent_message",
      direction: "received",
      messageId: "msg_2",
      conversationId: "conv_1",
      peer: {
        handle: "agent:node_1:endpoint_reviewer",
        displayName: "",
        agent: "claude",
      },
      content: "LGTM, ready to merge.",
      createdAt: 1771234567890,
      status: "delivered",
    };

    const wrapper = mount(AgentMessageCard, {
      props: { message },
    });

    expect(wrapper.attributes("data-direction")).toBe("received");
    expect(wrapper.find('[data-test="direction-received"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="peer-name"]').text()).toBe("agent:node_1:endpoint_reviewer");
    expect(wrapper.find('[data-test="peer-agent"]').text()).toContain("claude");
    expect(wrapper.find('[data-test="peer-workspace"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="msg-status-delivered"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("LGTM, ready to merge.");
  });

  it("renders failed status badge when status is failed", () => {
    const message: PeerMessageHistoryEntry = {
      kind: "agent_message",
      direction: "sent",
      messageId: "msg_3",
      conversationId: "conv_2",
      peer: {
        handle: "agent:node_3:endpoint_c",
        displayName: "Worker C",
        agent: "gemini",
      },
      content: "Failed send",
      createdAt: 1771234567890,
      status: "failed",
    };

    const wrapper = mount(AgentMessageCard, {
      props: { message },
    });

    expect(wrapper.find('[data-test="msg-status-failed"]').exists()).toBe(true);
  });
});
