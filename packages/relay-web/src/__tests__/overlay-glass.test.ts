import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import DropdownPanel from "../components/DropdownPanel.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import { useDropdown } from "../lib/use-dropdown";
import { confirm, settleConfirm } from "../lib/use-confirm";
import { i18n } from "../i18n";

const prevWidth = window.innerWidth;
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  window.innerWidth = prevWidth;
  // Unmount before clearing the body: a still-mounted teleport would otherwise
  // patch nodes that the reset already removed.
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
  settleConfirm(false);
});

function menuHost() {
  return defineComponent({
    setup() {
      const dd = useDropdown();
      const rows = [
        { value: "a", label: "alpha", selected: true, testId: "row" },
        { value: "b", label: "beta", testId: "row" },
      ];
      return () => h("div", [
        h("button", { "data-test": "trigger", onClick: () => dd.toggle() }, "open"),
        h(DropdownPanel, { dd, title: "Model", testId: "dd", groups: [{ rows }] }),
      ]);
    },
  });
}

async function openMenu() {
  window.innerWidth = 1280;
  const w = mount(menuHost(), { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(w);
  await w.find('[data-test="trigger"]').trigger("click");
  await nextTick();
}

describe("overlay glass treatment", () => {
  it("renders the menu as a glass-strong surface, not a solid filled panel", async () => {
    await openMenu();
    const panel = document.querySelector<HTMLElement>('[data-test="dd"]')!;
    expect(panel).not.toBeNull();
    const cls = panel.className.split(/\s+/);
    for (const token of ["bg-glass-strong", "backdrop-blur-glass", "backdrop-saturate-glass", "shadow-glass-float"]) {
      expect(cls).toContain(token);
    }
    expect(panel.className).not.toContain("bg-surface");
    expect(panel.className).not.toContain("bg-raised");
    expect(panel.className).not.toContain("shadow-float");
  });

  it("selects the row with background only — semibold check, no tint or blue text", async () => {
    await openMenu();
    const selected = Array.from(document.querySelectorAll<HTMLElement>('[data-test="row"]'))
      .find((el) => el.getAttribute("aria-selected") === "true")!;
    expect(selected).toBeDefined();
    const cls = selected.className.split(/\s+/);
    expect(cls).toContain("bg-fill-strong");
    expect(cls).toContain("font-semibold");
    expect(selected.querySelector("svg")).not.toBeNull();
    expect(selected.querySelector("svg")!.getAttribute("class") ?? "").toContain("text-accent-text");
  });

  it("renders a confirm dialog as a rounded-2xl glass card with no close button", async () => {
    const w = mount(ConfirmDialog, { attachTo: document.body, global: { plugins: [i18n] } });
    mounted.push(w);
    void confirm({ title: "Delete session?", tone: "danger" });
    await flushPromises();
    const dialog = document.querySelector<HTMLElement>('[data-test="confirm-dialog"]')!;
    expect(dialog).not.toBeNull();
    const cls = dialog.className.split(/\s+/);
    for (const token of ["bg-glass-strong", "backdrop-blur-glass", "backdrop-saturate-glass", "shadow-glass-float", "rounded-2xl"]) {
      expect(cls).toContain(token);
    }
    // No backdoor out: cancel is the way out, not a ✕.
    expect(dialog.querySelector('[aria-label="Close"]')).toBeNull();
    expect(dialog.querySelector('[data-test="confirm-cancel"]')).not.toBeNull();
  });
});
