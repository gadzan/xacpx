import { afterEach, describe, expect, it, vi } from "vitest";
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
    const w = await openSheet();
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

  it("closes the dropdown on a tap that lands in a plain page sheet instead", async () => {
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
    // The close lands on the sequence's click, not its pointerdown.
    plainRow.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await nextTick();
    expect(document.querySelector(SHEET)).not.toBeNull();
    plainRow.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    plainRow.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector(SHEET)).toBeNull();
    w.unmount();
  });

  it("puts the search field in the sheet's fixed band, outside the row scroller", async () => {
    window.innerWidth = 420;
    const SearchHost = defineComponent({
      setup() {
        const dd = useDropdown();
        return () => h("div", [
          h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
          h(DropdownPanel, {
            dd, title: "Workspace", testId: "dd", searchable: true,
            groups: [{ rows: [{ value: "a", label: "backend", testId: "row" }] }],
          }),
        ]);
      },
    });
    const w = mount(SearchHost, { attachTo: document.body, global: { plugins: [i18n] } });
    await w.find('[data-test="trigger"]').trigger("click");
    await nextTick();
    const search = document.querySelector<HTMLElement>('[data-test="dd-search"]');
    expect(search).not.toBeNull();
    const row = document.querySelector<HTMLElement>('[data-test="row"]')!;
    const scroller = row.closest(".thin-scroll") as HTMLElement;
    expect(scroller).not.toBeNull();
    expect(scroller.contains(search)).toBe(false);
    w.unmount();
  });

  // Item 5 (blocking): one pointerdown→pointerup→click on the backdrop closes the
  // top layer and NOTHING under it. The bottom layer is a Bot row and the blue
  // New button — the two places users reported click-through.
  it("a backdrop tap sequence never reaches the covered Bot row or New button", async () => {
    window.innerWidth = 420;
    const onBotRow = vi.fn();
    const onNewButton = vi.fn();
    const Host = defineComponent({
      setup() {
        const dd = useDropdown();
        return () => h("div", [
          h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
          h(DropdownPanel, {
            dd, title: "Bot", testId: "dd",
            groups: [{ rows: [{ value: "edit", label: "Edit bot", testId: "row" }] }],
          }),
          // The covered page: a Bot row and the New button live underneath.
          h("button", { "data-test": "bot-row", onClick: onBotRow }, "codex"),
          h("button", { "data-test": "new-button", onClick: onNewButton }, "New"),
        ]);
      },
    });
    const w = mount(Host, { attachTo: document.body, global: { plugins: [i18n] } });
    await w.find('[data-test="trigger"]').trigger("click");
    await nextTick();
    const backdrop = document.querySelector<HTMLElement>('[data-test="sheet-backdrop"]')!;
    expect(backdrop).not.toBeNull();

    const sequence = (type: string) =>
      backdrop.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 195, clientY: 400 }));

    sequence("pointerdown");
    await nextTick();
    // Isolation holds through the whole sequence: the sheet is still mounted.
    expect(document.querySelector(SHEET)).not.toBeNull();
    sequence("pointerup");
    sequence("click");
    await nextTick();

    expect(document.querySelector(SHEET)).toBeNull();
    expect(onBotRow).toHaveBeenCalledTimes(0);
    expect(onNewButton).toHaveBeenCalledTimes(0);
    w.unmount();
  });
});
