import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import DropdownPanel from "../components/DropdownPanel.vue";
import { useDropdown } from "../lib/use-dropdown";
import { i18n } from "../i18n";

const prevWidth = window.innerWidth;
afterEach(() => { window.innerWidth = prevWidth; document.body.innerHTML = ""; });

function makeHost(rowCount: number) {
  return defineComponent({
    setup() {
      const dd = useDropdown();
      const rows = Array.from({ length: rowCount }, (_, i) => ({
        value: `model-${i}`,
        label: `model-${i}`,
        testId: "row",
      }));
      return () => h("div", [
        h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
        h(DropdownPanel, { dd, title: "Model", testId: "dd", groups: [{ rows }] }),
      ]);
    },
  });
}

describe("DropdownPanel search filter", () => {
  it("stays visible when the filter narrows below the auto-search threshold", async () => {
    window.innerWidth = 1280;
    const w = mount(makeHost(10), { attachTo: document.body, global: { plugins: [i18n] } });
    await w.find('[data-test="trigger"]').trigger("click");
    await nextTick();
    expect(document.querySelector('[data-test="dd-search"]')).not.toBeNull();

    // Narrow to a single row: the search box must stay so typing can continue.
    const search = document.querySelector<HTMLInputElement>('[data-test="dd-search"]')!;
    search.value = "model-1";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    expect(document.querySelectorAll('[data-test="row"]')).toHaveLength(1);
    expect(document.querySelector('[data-test="dd-search"]')).not.toBeNull();

    // No match at all: the search box must still stay for continued typing.
    search.value = "zzz-no-such-model";
    search.dispatchEvent(new Event("input"));
    await nextTick();
    expect(document.querySelectorAll('[data-test="row"]')).toHaveLength(0);
    expect(document.querySelector('[data-test="dd-search"]')).not.toBeNull();
    w.unmount();
  });
});
