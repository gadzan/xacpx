import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import ExpandableBlock from "../components/ExpandableBlock.vue";

// jsdom reports scrollHeight = 0, so stub it per-test to simulate tall/short content.
const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
function stubScrollHeight(px: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => px });
}

afterEach(() => {
  if (orig) Object.defineProperty(HTMLElement.prototype, "scrollHeight", orig);
});

describe("ExpandableBlock", () => {
  it("renders content fully with no toggle when it fits", async () => {
    stubScrollHeight(40); // under the 200px default
    const wrapper = mount(ExpandableBlock, { slots: { default: "<p>short</p>" } });
    await flushPromises();
    expect(wrapper.text()).toContain("short");
    expect(wrapper.find('[data-test="expand-toggle"]').exists()).toBe(false);
  });

  it("clamps tall content and toggles between Show more / Show less", async () => {
    stubScrollHeight(900); // well over 200px
    const wrapper = mount(ExpandableBlock, { slots: { default: "<p>a long file</p>" } });
    await flushPromises();
    const toggle = wrapper.find('[data-test="expand-toggle"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain("Show more");
    // Collapsed: the inner wrapper is height-capped.
    const inner = wrapper.find('[data-test="clamp-inner"]');
    expect(inner.classes()).toContain("overflow-hidden");
    expect((inner.element as HTMLElement).style.maxHeight).toBe("200px");
    await toggle.trigger("click");
    expect(wrapper.find('[data-test="expand-toggle"]').text()).toContain("Show less");
    const innerOpen = wrapper.find('[data-test="clamp-inner"]');
    expect(innerOpen.classes()).not.toContain("overflow-hidden");
  });

  it("respects a custom maxPx threshold", async () => {
    stubScrollHeight(120);
    const wrapper = mount(ExpandableBlock, { props: { maxPx: 80 }, slots: { default: "<p>mid</p>" } });
    await flushPromises();
    expect(wrapper.find('[data-test="expand-toggle"]').exists()).toBe(true); // 120 > 80
  });
});
