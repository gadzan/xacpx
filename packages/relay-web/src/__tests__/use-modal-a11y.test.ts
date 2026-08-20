import { describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { mount } from "@vue/test-utils";
import { useModalA11y } from "../lib/use-modal-a11y";

// Minimal dialog using the composable: no Teleport needed, it only requires a
// dialog element ref and reports closes through the onClose prop.
const TestDialog = defineComponent({
  props: { onClose: { type: Function, required: true } },
  setup(props) {
    const dialogEl = ref<HTMLElement | null>(null);
    useModalA11y(dialogEl, () => props.onClose());
    return () => h("div", { ref: dialogEl, tabindex: "-1" }, "dialog");
  },
});

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

describe("useModalA11y", () => {
  it("Escape closes only the top-most dialog; the parent closes after the child unmounts", async () => {
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    const parent = mount(TestDialog, { props: { onClose: closeParent } });
    const child = mount(TestDialog, { props: { onClose: closeChild } });

    pressEscape();
    expect(closeChild).toHaveBeenCalledTimes(1);
    expect(closeParent).not.toHaveBeenCalled();

    child.unmount();
    pressEscape();
    expect(closeParent).toHaveBeenCalledTimes(1);
    expect(closeChild).toHaveBeenCalledTimes(1);

    parent.unmount();
  });
});
