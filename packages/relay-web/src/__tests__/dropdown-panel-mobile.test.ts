import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import DropdownPanel from "../components/DropdownPanel.vue";
import MobileSheet from "../components/MobileSheet.vue";
import { useDropdown } from "../lib/use-dropdown";
import { i18n } from "../i18n";

const prevWidth = window.innerWidth;
afterEach(() => { window.innerWidth = prevWidth; document.body.innerHTML = ""; });

const picked: string[] = [];
const SHEET = '[data-test="dd"]';
const Host = defineComponent({
  setup() {
    const dd = useDropdown();
    return () => h("div", [
      h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
      h(DropdownPanel, {
        dd, title: "Model", testId: "dd",
        groups: [{ rows: [
          { value: "a", label: "gpt-5.2", selected: true, testId: "row" },
          { value: "b", label: "gpt-4.1", testId: "row" },
        ] }],
        onSelect: (value: string) => picked.push(value),
      }),
    ]);
  },
});

async function openSheet() {
  const w = mount(Host, { attachTo: document.body, global: { plugins: [i18n] } });
  await w.find('[data-test="trigger"]').trigger("click");
  await nextTick();
  return w;
}

describe("DropdownPanel mobile sheet", () => {
  it("shows only the ✓ for the selected row — no persistent or hover highlight on touch", async () => {
    window.innerWidth = 420;
    const w = await openSheet();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-test="row"]'));
    expect(rows).toHaveLength(2);
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    await nextTick();
    for (const row of rows) expect(row.className.split(/\s+/)).not.toContain("bg-surface-2");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[0]!.querySelector("svg")).not.toBeNull();
    w.unmount();
  });

  it("slot-mode sheets (caller-rendered rows) never show the items-mode empty text", async () => {
    window.innerWidth = 420;
    const SlotHost = defineComponent({
      setup() {
        const dd = useDropdown();
        return () => h("div", [
          h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
          h(DropdownPanel, { dd, title: "Topics", testId: "dd" }, { default: () => h("p", { "data-test": "slot-row" }, "Default") }),
        ]);
      },
    });
    const w = mount(SlotHost, { attachTo: document.body, global: { plugins: [i18n] } });
    await w.find('[data-test="trigger"]').trigger("click");
    await nextTick();
    expect(document.querySelector('[data-test="slot-row"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(i18n.global.t("common.noMatch"));
    w.unmount();
  });

  it("keeps the sheet open through a tap inside it, then selects on the tap's click", async () => {
    window.innerWidth = 420;
    picked.length = 0;
    const row = document.querySelectorAll<HTMLElement>('[data-test="row"]')[1]!;
    row.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector(SHEET)).not.toBeNull();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(picked).toEqual(["b"]);
    expect(document.querySelector(SHEET)).toBeNull();
    w.unmount();
  });

  it("keeps the sheet open through a tap on its own chrome", async () => {
    window.innerWidth = 420;
    const w = await openSheet();
    const title = document.querySelector(SHEET)!.querySelector("h2")!;
    title.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector(SHEET)).not.toBeNull();
    w.unmount();
  });

  it("closes the dropdown when the tap lands in a plain page sheet instead", async () => {
    window.innerWidth = 420;
    const MixedHost = defineComponent({
      setup() {
        const dd = useDropdown();
        return () => h("div", [
          h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
          h(DropdownPanel, {
            dd, title: "Model", testId: "dd",
            groups: [{ rows: [{ value: "a", label: "gpt-5.2", testId: "row" }] }],
          }),
          h(MobileSheet, { title: "More", testId: "plain" }, {
            default: () => h("button", { "data-test": "plain-row" }, "x"),
          }),
        ]);
      },
    });
    const w = mount(MixedHost, { attachTo: document.body, global: { plugins: [i18n] } });
    await w.find('[data-test="trigger"]').trigger("click");
    await nextTick();
    expect(document.querySelector(SHEET)).not.toBeNull();
    const plainRow = document.querySelector<HTMLElement>('[data-test="plain-row"]')!;
    plainRow.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector(SHEET)).toBeNull();
    w.unmount();
  });
});
