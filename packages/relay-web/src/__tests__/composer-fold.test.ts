import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
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

/** The affordance row is folded when it is both zero-height and un-hittable. */
function folded(wrapper: VueWrapper): boolean {
  const row = wrapper.find('[data-test="composer-affordances"]');
  return row.classes().includes("max-h-0") && row.classes().includes("invisible");
}

describe("ConversationComposer fold", () => {
  const deskWidth = window.innerWidth;
  beforeEach(() => setWidth(390));
  afterEach(() => { setWidth(deskWidth); document.body.innerHTML = ""; });

  it("hides controls/actions until focused; content keeps them open after blur", async () => {
    const wrapper = mount(Host);
    expect(folded(wrapper)).toBe(true);
    // The send button is never folded; the picker entry folds with the composer.
    expect(wrapper.find('[data-test="host-send"]').attributes("style") ?? "").not.toContain("display: none");
    const attachmentsFolded = () => {
      const fold = wrapper.find('[data-test="composer-attachments-fold"]');
      return fold.classes().includes("max-h-0") && fold.classes().includes("invisible");
    };
    expect(attachmentsFolded()).toBe(true);

    await wrapper.find("textarea").trigger("focus");
    expect(folded(wrapper)).toBe(false);
    expect(attachmentsFolded()).toBe(false);

    // Typed content keeps the affordances unfolded after blur.
    await wrapper.find("textarea").setValue("draft");
    await wrapper.find("textarea").trigger("blur");
    expect(folded(wrapper)).toBe(false);
    expect(attachmentsFolded()).toBe(false);

    // Clearing folds them back.
    await wrapper.find("textarea").setValue("");
    expect(folded(wrapper)).toBe(true);
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

  it("a tap on the control row keeps the card open through its own click; a tap away folds it", async () => {
    const wrapper = mount(Host, { attachTo: document.body });
    await wrapper.get("textarea").trigger("focus");
    expect(folded(wrapper)).toBe(false);

    // A phone tap on the chip blurs the textarea before the chip's click is
    // dispatched. Folding on that blur clips the row to zero height mid-gesture,
    // so the click never reaches the chip and its sheet renders inside a hidden
    // row — the card must stay open until the press lands outside it.
    const chip = wrapper.get('[data-test="slot-control"]');
    chip.element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await wrapper.get("textarea").trigger("blur");
    expect(folded(wrapper)).toBe(false);
    await chip.trigger("click");
    expect(folded(wrapper)).toBe(false);

    // Tapping outside the card is the "rest" gesture: empty + unfocused folds.
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(folded(wrapper)).toBe(true);
    wrapper.unmount();
  });

  it("pinExpanded keeps an empty, unfocused card open under a layer it opened", async () => {
    const wrapper = mount(ConversationComposer, {
      props: { modelValue: "", sendTestId: "send", pinExpanded: true },
      slots: { controls: () => h("button", { type: "button" }, "chip") },
      attachTo: document.body,
    });
    expect(folded(wrapper)).toBe(false);
    await wrapper.setProps({ pinExpanded: false });
    expect(folded(wrapper)).toBe(true);
    wrapper.unmount();
  });
});
