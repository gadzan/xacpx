import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { Check, Copy } from "lucide-vue-next";
import CopyButton from "../components/CopyButton.vue";

describe("CopyButton", () => {
  it("writes text to the clipboard and shows a transient confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const w = mount(CopyButton, { props: { text: "hello world" } });
    // Default state shows the Copy (not Check) icon.
    expect(w.findComponent(Copy).exists()).toBe(true);
    expect(w.findComponent(Check).exists()).toBe(false);
    await w.find('[data-test="copy-button"]').trigger("click");
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("hello world");
    await w.vm.$nextTick();
    // Success state swaps to the Check icon.
    expect(w.findComponent(Check).exists()).toBe(true);
  });

  it("keeps the swap in one fixed box and answers the press", () => {
    // The two glyphs share a 14px box, so the confirmation cannot shift the
    // surrounding row while it swaps; the press scale is the same 150ms gesture
    // every other control uses.
    const w = mount(CopyButton, { props: { text: "x" } });
    const button = w.find('[data-test="copy-button"]');
    expect(button.classes()).toEqual(expect.arrayContaining([
      "active:scale-95", "motion-reduce:active:scale-100", "motion-reduce:transition-none",
    ]));
    expect(button.find("span.relative").classes()).toEqual(expect.arrayContaining(["h-3.5", "w-3.5"]));
  });
});
