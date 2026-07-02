import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import PromptInput from "../components/PromptInput.vue";

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

  it("never renders the Stop button; the Send button stays mounted while busy", async () => {
    const w = mount(PromptInput, { props: { busy: true } });
    expect(w.find('[data-test="composer-stop"]').exists()).toBe(false);
    expect(w.find('[data-test="composer-send"]').exists()).toBe(true);
  });

  it("still renders the Send button (not Stop) when not busy", () => {
    const w = mount(PromptInput, { props: { busy: false } });
    expect(w.find('[data-test="composer-stop"]').exists()).toBe(false);
    expect(w.find('[data-test="composer-send"]').exists()).toBe(true);
  });
});
