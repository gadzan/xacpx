import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import PromptInput from "../components/PromptInput.vue";
import { useComposerStore } from "../stores/composer";

// PromptInput now uses the composer store, which needs an active pinia.
beforeEach(() => setActivePinia(createPinia()));

describe("PromptInput non-blocking composer (message queue)", () => {
  it("emits `send` on submit even while a turn is busy (server-side queueing)", async () => {
    const w = mount(PromptInput, { props: { busy: true } });
    const ta = w.find("textarea");
    await ta.setValue("queue me please");
    await ta.trigger("keydown", { key: "Enter" });
    expect(w.emitted("send")?.[0]).toEqual(["queue me please", []]);
  });

  it("busy + empty composer: the send button becomes Stop (cancel), Send unmounts", async () => {
    const w = mount(PromptInput, { props: { busy: true } });
    expect(w.find('[data-test="cancel-turn"]').exists()).toBe(true);
    expect(w.find('[data-test="composer-send"]').exists()).toBe(false);
  });

  it("typing while busy reverts Stop back to Send (so the message queues)", async () => {
    const w = mount(PromptInput, { props: { busy: true } });
    await w.find("textarea").setValue("queue me please");
    expect(w.find('[data-test="cancel-turn"]').exists()).toBe(false);
    expect(w.find('[data-test="composer-send"]').exists()).toBe(true);
  });

  it("still renders the Send button (not Stop) when not busy", () => {
    const w = mount(PromptInput, { props: { busy: false } });
    expect(w.find('[data-test="cancel-turn"]').exists()).toBe(false);
    expect(w.find('[data-test="composer-send"]').exists()).toBe(true);
  });

  // Review #353 Medium: cancelling an in-flight turn is independent of attachment
  // uploads (and `uploading` is shared composer state — it must never lock Stop).
  it("keeps Stop enabled and cancellable while an attachment is uploading", async () => {
    useComposerStore().uploading = true;
    const w = mount(PromptInput, { props: { busy: true } });
    const stop = w.find('[data-test="cancel-turn"]');
    expect(stop.exists()).toBe(true);
    expect((stop.element as HTMLButtonElement).disabled).toBe(false);
    await stop.trigger("click");
    expect(w.emitted("cancel")?.length).toBe(1);
  });
});
