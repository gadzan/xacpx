import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { flushPromises } from "@vue/test-utils";
import PromptInput from "../components/PromptInput.vue";
import { useChatStore } from "../stores/chat";
import { api } from "../api/client";
import { settleConfirm, useConfirmState } from "../lib/use-confirm";
import { i18n } from "../i18n";

beforeEach(() => {
  setActivePinia(createPinia());
  settleConfirm(false);
  i18n.global.locale.value = "en";
});

/**
 * The clear-context control lives in the composer's action row. Pressing it must ask
 * first (the transcript is gone afterwards) and then run the ordinary session reset
 * addressed by alias.
 */
describe("PromptInput clear context", () => {
  it("hides the control until a session is open", async () => {
    const w = mount(PromptInput, { props: { instanceId: null, sessionAlias: null } });
    expect(w.find('[data-test="clear-context-btn"]').exists()).toBe(true);
    expect(w.find('[data-test="clear-context-btn"]').attributes("disabled")).toBeDefined();
  });

  it("does nothing when the confirmation is declined", async () => {
    const rpc = vi.spyOn(api, "rpc");
    const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "s1" } });
    await w.find('[data-test="clear-context-btn"]').trigger("click");
    await flushPromises();
    // The dialog is up and waiting; declining must not reach the daemon.
    expect(useConfirmState().value?.title).toBe(i18n.global.t("chat.clearContext.title"));
    settleConfirm(false);
    await flushPromises();
    // Only the clear RPC matters here: mounting loads model state through other calls.
    expect(rpc.mock.calls.filter(([, type]) => type === "control.sessions.clear")).toEqual([]);
    rpc.mockRestore();
  });

  it("clears the session through control.sessions.clear once confirmed", async () => {
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ output: "context cleared" } as never);
    const chat = useChatStore();
    chat.instanceId = "i1";
    chat.sessionAlias = "s1";
    const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "s1" } });
    await w.find('[data-test="clear-context-btn"]').trigger("click");
    await flushPromises();
    settleConfirm(true);
    await flushPromises();
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.clear", { alias: "s1" });
    rpc.mockRestore();
  });

  it("keeps the control disabled while a turn is running", async () => {
    const w = mount(PromptInput, { props: { instanceId: "i1", sessionAlias: "s1", busy: true } });
    expect(w.find('[data-test="clear-context-btn"]').attributes("disabled")).toBeDefined();
  });
});
