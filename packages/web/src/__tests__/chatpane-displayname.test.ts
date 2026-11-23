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

function seedInstance() {
  const instances = useInstancesStore();
  instances.instances.push({
    id: "i1", name: "prod-box", online: true, lastSeenAt: null,
    sessions: [{ alias: "backend", agent: "codex", workspace: "gaia", displayName: "API hotfix" }],
    agents: [], workspaces: [], agentCatalog: [],
  } as never);
}

it("shows the session displayName in the chat header instead of the alias", async () => {
  seedInstance();
  const chat = useChatStore();
  chat.select("i1", "backend");
  const w = mount(ChatPane);
  await w.vm.$nextTick();
  expect(w.find("h1").text()).toBe("API hotfix");
});
