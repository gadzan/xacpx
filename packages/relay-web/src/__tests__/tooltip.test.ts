import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import Tooltip from "../components/Tooltip.vue";

afterEach(() => { document.body.innerHTML = ""; });

describe("Tooltip", () => {
  it("renders the bubble outside overflow-hidden ancestors (teleported to body) on focus, hides on blur", async () => {
    const host = document.createElement("div");
    host.style.overflow = "hidden";
    document.body.appendChild(host);
    const w = mount(Tooltip, { props: { text: "cold" }, slots: { default: '<button data-test="anchor">x</button>' }, attachTo: host });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    (w.find('[data-test="anchor"]').element as HTMLElement).focus();
    await nextTick();
    const tip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tip?.textContent).toContain("cold");
    expect(host.contains(tip)).toBe(false);
    expect(tip!.className).toContain("fixed");
    (w.find('[data-test="anchor"]').element as HTMLElement).blur();
    await nextTick();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    w.unmount();
  });
});
