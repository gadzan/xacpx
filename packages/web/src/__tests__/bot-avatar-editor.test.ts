import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import {
  needsSetupCapability,
  type BotAvatarConfig,
  type BotDetailDto,
  type CharacterAvatarConfig,
} from "@ganglion/xacpx-relay-protocol";
import { i18n } from "../i18n";
import BotAvatarEditor from "../components/BotAvatarEditor.vue";
import BotDialog from "../components/BotDialog.vue";
import { useInstancesStore } from "../stores/instances";
import { useDirectBotsStore } from "../stores/direct-bots";

const DEFAULT_AVATAR: CharacterAvatarConfig = {
  version: 1, kind: "character", shape: "cercle", color: "bleu", expression: "neutre", motion: "auto",
};
const wrappers: VueWrapper[] = [];
function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper);
  return wrapper;
}
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});
function editor(avatar?: BotAvatarConfig) {
  return track(mount(BotAvatarEditor, {
    props: { modelValue: avatar, driver: "codex", name: "Reviewer" },
    global: { plugins: [i18n], stubs: { BotAvatar: true } },
  }));
}

describe("Bot avatar appearance editor", () => {
  it("preserves legacy text safely in full without loading or executing it", async () => {
    const value = 'https://example.invalid/<svg onload="alert(1)">🤖';
    const wrapper = editor({ version: 1, kind: "text", value });
    expect(wrapper.get('[data-test="avatar-retained-text"]').text()).toBe(value);
    expect(wrapper.find("svg[onload]").exists()).toBe(false);
    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});

const DETAIL: BotDetailDto = {
  id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true,
  instructions: "Remote instructions", model: "remote-model", profileRevision: 2,
  createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
  avatar: { ...DEFAULT_AVATAR, color: "rose" },
};
function dialog(avatar?: BotAvatarConfig) {
  return track(mount(BotDialog, {
    props: {
      instanceId: "i1", instanceName: "Local",
      bot: { id: "bot_1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "open", avatar },
    },
    global: { plugins: [i18n], stubs: { teleport: true, BotAvatar: true } },
  }));
}

describe("Bot dialog avatar draft", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const instances = useInstancesStore();
    instances.instances = [{
      id: "i1", name: "Local", online: true, lastSeenAt: null, sessions: [],
      agents: [{ name: "codex", driver: "codex" }], workspaces: [{ name: "repo", cwd: "/repo" }],
    } as never];
    vi.spyOn(instances, "loadFormOptions").mockResolvedValue(undefined);
    vi.spyOn(instances, "getAgentCapabilities").mockResolvedValue(needsSetupCapability(
      { code: "discovery-available", message: "Fetch models" }, "Fetch models",
      { fetchedAt: "2026-10-14T00:00:00.000Z" },
    ));
  });

  it("hydrates an untouched copied avatar without submitting it during other edits", async () => {
    const store = useDirectBotsStore();
    const gate = Promise.withResolvers<BotDetailDto>();
    vi.spyOn(store, "loadBotDetail").mockReturnValue(gate.promise);
    const update = vi.spyOn(store, "updateBot").mockResolvedValue(DETAIL);
    const wrapper = dialog(DEFAULT_AVATAR);
    await flushPromises();
    gate.resolve(DETAIL);
    await flushPromises();
    await wrapper.get("#bot-name").setValue("Local name");
    await wrapper.get("form").trigger("submit.prevent");
    await flushPromises();
    expect(update).toHaveBeenCalledWith("i1", "bot_1", { name: "Local name" });
  });

  it("retains edit-then-revert over late details and submits only the chosen config", async () => {
    const store = useDirectBotsStore();
    const gate = Promise.withResolvers<BotDetailDto>();
    vi.spyOn(store, "loadBotDetail").mockReturnValue(gate.promise);
    const update = vi.spyOn(store, "updateBot").mockResolvedValue(DETAIL);
    const wrapper = dialog(DEFAULT_AVATAR);
    await flushPromises();
    await wrapper.get('[data-test="bot-avatar-edit"]').trigger("click");
    await wrapper.get('[data-test="avatar-color-rouge"]').trigger("click");
    await wrapper.get('[data-test="avatar-color-bleu"]').trigger("click");
    gate.resolve(DETAIL);
    await flushPromises();
    expect(wrapper.getComponent(BotAvatarEditor).props("modelValue")).toEqual(DEFAULT_AVATAR);
    expect(DEFAULT_AVATAR.color).toBe("bleu");
    expect(DETAIL.avatar).toEqual({ ...DEFAULT_AVATAR, color: "rose" });
    await wrapper.get("form").trigger("submit.prevent");
    await flushPromises();
    expect(update).toHaveBeenCalledWith("i1", "bot_1", { avatar: DEFAULT_AVATAR });
  });

  it("clears a configured avatar only when saved and uses explicit null", async () => {
    const store = useDirectBotsStore();
    vi.spyOn(store, "loadBotDetail").mockResolvedValue(DETAIL);
    const update = vi.spyOn(store, "updateBot").mockResolvedValue({ ...DETAIL, avatar: undefined });
    const wrapper = dialog();
    await flushPromises();
    await wrapper.get('[data-test="bot-avatar-edit"]').trigger("click");
    await wrapper.get('[data-test="avatar-reset"]').trigger("click");
    expect(update).not.toHaveBeenCalled();
    await wrapper.get("form").trigger("submit.prevent");
    await flushPromises();
    expect(update).toHaveBeenCalledWith("i1", "bot_1", { avatar: null });
  });

  it("keeps preview state and selection across badge navigation and discards on cancel", async () => {
    const store = useDirectBotsStore();
    vi.spyOn(store, "loadBotDetail").mockResolvedValue(DETAIL);
    const update = vi.spyOn(store, "updateBot").mockResolvedValue(DETAIL);
    const wrapper = dialog();
    await flushPromises();
    await wrapper.get('[data-test="bot-avatar-edit"]').trigger("click");
    await wrapper.get('[data-test="avatar-shape-nuage"]').trigger("click");
    await wrapper.get('[data-test="avatar-preview-working"]').trigger("click");
    expect(wrapper.get('[data-test="avatar-preview-working"]').attributes("aria-pressed")).toBe("true");
    await wrapper.get('[data-test="bot-avatar-back"]').trigger("click");
    expect(wrapper.get('[data-test="avatar-shape-nuage"]').isVisible()).toBe(false);
    await wrapper.get('[data-test="bot-avatar-edit"]').trigger("click");
    expect(wrapper.get('[data-test="avatar-preview-working"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.getComponent(BotAvatarEditor).props("modelValue")).toEqual({ ...DETAIL.avatar, shape: "nuage" });
    const cancel = wrapper.findAll("button").find((button) => button.text() === i18n.global.t("common.cancel"))!;
    await cancel.trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    expect(DETAIL.avatar).toEqual({ ...DEFAULT_AVATAR, color: "rose" });
  });

  it("opens the enlarged quick view from the embedded avatar and closes it", async () => {
    const store = useDirectBotsStore();
    vi.spyOn(store, "loadBotDetail").mockResolvedValue(DETAIL);
    const wrapper = dialog(DETAIL.avatar);
    await flushPromises();
    expect(wrapper.find('[data-test="bot-avatar-quick-view-overlay"]').exists()).toBe(false);
    await wrapper.get('[data-test="bot-avatar-quick-view"]').trigger("click");
    expect(wrapper.get('[data-test="bot-avatar-quick-view-overlay"]').isVisible()).toBe(true);
    await wrapper.get('[data-test="bot-avatar-quick-view-overlay"] button').trigger("click");
    expect(wrapper.find('[data-test="bot-avatar-quick-view-overlay"]').exists()).toBe(false);
  });

  it("closes the enlarged quick view on Escape without closing the dialog", async () => {
    const store = useDirectBotsStore();
    vi.spyOn(store, "loadBotDetail").mockResolvedValue(DETAIL);
    const wrapper = dialog(DETAIL.avatar);
    await flushPromises();
    await wrapper.get('[data-test="bot-avatar-quick-view"]').trigger("click");
    expect(wrapper.find('[data-test="bot-avatar-quick-view-overlay"]').exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.find('[data-test="bot-avatar-quick-view-overlay"]').exists()).toBe(false);
    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("generates a random character avatar for a new Bot", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const wrapper = track(mount(BotDialog, {
      props: { instanceId: "i1", instanceName: "Local" },
      global: { plugins: [i18n], stubs: { teleport: true, BotAvatar: true } },
    }));
    await flushPromises();
    const avatar = wrapper.getComponent(BotAvatarEditor).props("modelValue") as CharacterAvatarConfig;
    expect(avatar).toEqual({ version: 1, kind: "character", shape: "goutte", color: "creme", expression: "somnolent", motion: "auto" });
  });
});
