import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";
import ConversationComposer from "../components/ConversationComposer.vue";

// A host with real two-way binding: the fold depends on the bound model value,
// so a bare mount with a frozen prop would test the wrong thing.
const Host = defineComponent(() => {
  const text = ref("");
  return () =>
    h(ConversationComposer, {
      modelValue: text.value,
      "onUpdate:modelValue": (value: string) => {
        text.value = value;
      },
      sendTestId: "host-send",
    }, {
      controls: () => h("button", { type: "button", "data-test": "slot-control" }, "chip"),
      actions: () => h("button", { type: "button", "data-test": "slot-action" }, "attach"),
      attachments: () => h("div", { "data-test": "slot-attachments" }, [
        h("button", { type: "button", "data-test": "slot-attach-btn" }, "pick"),
      ]),
    });
});

// Fold is a phone affordance only: jsdom's 1024px window is desktop, so each
// case pins the width it means to exercise.
function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
}

describe("ConversationComposer fold", () => {
  const deskWidth = window.innerWidth;
  beforeEach(() => setWidth(390));
  afterEach(() => setWidth(deskWidth));

  it("hides controls/actions until focused; content keeps them open after blur", async () => {
    const wrapper = mount(Host);
    const folded = () => {
      const row = wrapper.find('[data-test="composer-affordances"]');
      return row.classes().includes("max-h-0") && row.classes().includes("invisible");
    };
    expect(folded()).toBe(true);
    // The send button is never folded; the picker entry folds with the composer.
    expect(wrapper.find('[data-test="host-send"]').attributes("style") ?? "").not.toContain("display: none");
    const attachmentsFolded = () => {
      const fold = wrapper.find('[data-test="composer-attachments-fold"]');
      return fold.classes().includes("max-h-0") && fold.classes().includes("invisible");
    };
    expect(attachmentsFolded()).toBe(true);

    await wrapper.find("textarea").trigger("focus");
    expect(folded()).toBe(false);
    expect(attachmentsFolded()).toBe(false);

    // Typed content keeps the affordances unfolded after blur.
    await wrapper.find("textarea").setValue("draft");
    await wrapper.find("textarea").trigger("blur");
    expect(folded()).toBe(false);
    expect(attachmentsFolded()).toBe(false);

    // Clearing folds them back.
    await wrapper.find("textarea").setValue("");
    expect(folded()).toBe(true);
    expect(attachmentsFolded()).toBe(true);
    wrapper.unmount();
  });

  it("keeps the affordances visible at rest on desktop", () => {
    setWidth(1280);
    const wrapper = mount(Host);
    const row = wrapper.find('[data-test="composer-affordances"]');
    expect(row.classes()).not.toContain("max-h-0");
    expect(row.classes()).not.toContain("invisible");
    expect(wrapper.find('[data-test="slot-action"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it("panes without controls/actions slots render no affordance row at all", () => {
    const wrapper = mount(ConversationComposer, { props: { modelValue: "", sendTestId: "send" } });
    expect(wrapper.find('[data-test="composer-affordances"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
