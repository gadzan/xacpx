import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, test, expect, vi } from "vitest";
import DialogShell from "../components/DialogShell.vue";
import { modalLayers } from "../lib/mobile-back";

// The shell owns the modal contract that every centred dialog now inherits:
// the scrim closes, Escape closes through the shared layer stack, the rung
// comes from the z-index ladder, and focus goes back where it came from.

beforeEach(() => setActivePinia(createPinia()));

function mountShell(props: Record<string, unknown> = {}) {
  return mount(DialogShell, {
    props: { labelledby: "shell-title", testId: "shell-panel", ...props },
    slots: {
      default: `<h2 id="shell-title">Title</h2>
        <button data-test="first">first</button>
        <button data-test="last">last</button>`,
    },
    attachTo: document.body,
  });
}

test("renders the panel contract and the base rung", async () => {
  const wrapper = mountShell();
  await flushPromises();
  const panel = document.querySelector('[data-test="shell-panel"]') as HTMLElement;
  expect(panel.getAttribute("role")).toBe("dialog");
  expect(panel.getAttribute("aria-modal")).toBe("true");
  expect(panel.getAttribute("aria-labelledby")).toBe("shell-title");
  expect(panel.parentElement?.className).toContain("z-dialog");
  expect(panel.parentElement?.className).toContain("bg-scrim");
  expect(modalLayers.value.at(-1)?.id).toBe("shell-panel");
  wrapper.unmount();
});

test("the rung follows level, not a raw z-index", async () => {
  for (const [level, token] of [["nested", "z-dialog-nested"], ["top", "z-dialog-top"]] as const) {
    const wrapper = mountShell({ level });
    await flushPromises();
    const overlay = document.querySelector('[data-test="shell-panel"]')!.parentElement;
    expect(overlay?.className).toContain(token);
    wrapper.unmount();
  }
});

test("Escape closes once through the layer stack and the scrim click emits close", async () => {
  const wrapper = mountShell();
  await flushPromises();

  // Escape goes through navigateBack, which closes the top layer; the shell's
  // close handler is what emits, so the key and the back gesture cannot drift.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await flushPromises();
  expect(wrapper.emitted("close")).toHaveLength(1);

  const overlay = document.querySelector('[data-test="shell-panel"]')!.parentElement as HTMLElement;
  overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(wrapper.emitted("close")).toHaveLength(2);
  wrapper.unmount();
});

test("unregisters its layer and restores the opener's focus", async () => {
  const opener = document.createElement("button");
  opener.id = "opener";
  document.body.appendChild(opener);
  opener.focus();

  const wrapper = mountShell();
  await flushPromises();
  expect(modalLayers.value.map((layer) => layer.id)).toContain("shell-panel");

  wrapper.unmount();
  expect(modalLayers.value.map((layer) => layer.id)).not.toContain("shell-panel");
  expect(document.activeElement?.id).toBe("opener");
  opener.remove();
});

test("focusChild moves focus inside the panel", async () => {
  const wrapper = mountShell();
  await flushPromises();
  wrapper.vm.focusChild('[data-test="last"]');
  expect(document.activeElement?.getAttribute("data-test")).toBe("last");
  wrapper.unmount();
});

test("a scrim pointer sequence closes only on the completed click, never on pointerdown", async () => {
  const covered = document.createElement("button");
  covered.setAttribute("data-test", "covered-new");
  const onCovered = vi.fn();
  covered.addEventListener("click", onCovered);
  document.body.appendChild(covered);

  const wrapper = mountShell();
  await flushPromises();
  const overlay = document.querySelector('[data-test="shell-panel"]')!.parentElement as HTMLElement;
  const seq = (type: string) =>
    overlay.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));

  // Isolation holds: the sequence's pointerdown must not tear the scrim down,
  // or the click that follows would land on whatever it uncovered.
  seq("pointerdown");
  await flushPromises();
  expect(wrapper.emitted("close")).toBeUndefined();
  seq("pointerup");
  await flushPromises();
  expect(wrapper.emitted("close")).toBeUndefined();
  seq("click");
  await flushPromises();

  expect(wrapper.emitted("close")).toHaveLength(1);
  expect(onCovered).toHaveBeenCalledTimes(0);
  wrapper.unmount();
  covered.remove();
});

test("a pointerdown inside the panel never starts a close", async () => {
  const wrapper = mountShell();
  await flushPromises();
  const panel = document.querySelector('[data-test="shell-panel"]') as HTMLElement;
  for (const type of ["pointerdown", "pointerup", "click"]) {
    panel.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  await flushPromises();
  expect(wrapper.emitted("close")).toBeUndefined();
  wrapper.unmount();
});

test("nested shells each own a rung; the top scrim closes one layer and the lock is ref-counted", async () => {
  const parent = mountShell({ testId: "parent-panel" });
  await flushPromises();
  expect(document.body.style.overflow).toBe("hidden");
  const child = mountShell({ testId: "child-panel", level: "nested" });
  await flushPromises();
  expect(document.body.style.overflow).toBe("hidden");
  expect(modalLayers.value.map((l) => l.id)).toEqual(["parent-panel", "child-panel"]);

  const childOverlay = document.querySelector('[data-test="child-panel"]')!.parentElement as HTMLElement;
  childOverlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  expect(child.emitted("close")).toHaveLength(1);
  expect(parent.emitted("close")).toBeUndefined();
  expect(modalLayers.value.map((l) => l.id)).toEqual(["parent-panel", "child-panel"]);

  // Child unmounts (popstate close) → the parent's lock still holds the page.
  child.unmount();
  expect(document.body.style.overflow).toBe("hidden");
  parent.unmount();
  expect(document.body.style.overflow).toBe("");
});
