import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));

import ChatPane from "../components/ChatPane.vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => { i18n.global.locale.value = "en"; });

function seedOmpSession() {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "backend", agent: "omp", driver: "omp", workspace: "gaia" }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
}

it("OMP restore failure banner offers the model-picker refresh action instead of the raw error", async () => {
  seedOmpSession();
  const chat = useChatStore();
  chat.select("i1", "backend");
  chat.error = 'Could not restore model gpt-5.2[high]: the ACP agent did not advertise it';
  const w = mount(ChatPane);
  await w.vm.$nextTick();

  const banner = w.find('[data-test="chat-error"]');
  expect(banner.exists()).toBe(true);
  expect(banner.text()).not.toContain("Could not restore model");
  expect(banner.text()).toContain("gpt-5.2[high]");
  expect(w.find('[data-test="model-recovery-refresh"]').exists()).toBe(true);
});

it("non-OMP errors keep showing the raw message with no recovery action", async () => {
  seedOmpSession();
  const chat = useChatStore();
  chat.select("i1", "backend");
  chat.error = "adapter timed out after 30s";
  const w = mount(ChatPane);
  await w.vm.$nextTick();

  expect(w.find('[data-test="chat-error"]').text()).toContain("adapter timed out");
  expect(w.find('[data-test="model-recovery-refresh"]').exists()).toBe(false);
});
