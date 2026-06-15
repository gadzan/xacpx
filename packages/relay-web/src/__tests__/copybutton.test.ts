import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CopyButton from "../components/CopyButton.vue";

describe("CopyButton", () => {
  it("writes text to the clipboard and shows a transient confirmation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const w = mount(CopyButton, { props: { text: "hello world" } });
    expect(w.text()).toContain("⧉");
    await w.find('[data-test="copy-button"]').trigger("click");
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("hello world");
    await w.vm.$nextTick();
    expect(w.text()).toContain("✓");
  });
});
