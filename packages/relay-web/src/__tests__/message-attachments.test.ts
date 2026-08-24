import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import type { AttachmentMetadata } from "@ganglion/xacpx-relay-protocol";

import MessageAttachments from "../components/MessageAttachments.vue";
import ImageLightbox from "../components/ImageLightbox.vue";
import { closeLightbox, useImageLightbox } from "../lib/use-image-lightbox";
import { useModalA11y } from "../lib/use-modal-a11y";
import type { VueWrapper } from "@vue/test-utils";

// Track every mount: the singleton lightbox state outlives a single wrapper, and a
// stale wrapper left open across tests re-patches its (cleared) teleported DOM.
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  closeLightbox();
});

afterEach(async () => {
  while (wrappers.length) void wrappers.pop()!.unmount();
  // Flush the close/unmount patches WHILE the teleported nodes are still attached,
  // then reset the body between tests.
  closeLightbox();
  await nextTick();
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});
const img = (id: string, previewUrl: string): AttachmentMetadata => ({
  id,
  filename: `${id}.png`,
  mimeType: "image/png",
  size: 10,
  kind: "image",
  previewUrl,
});

// Mirrors the real app shell: the viewer mounts only while the singleton state
// exists (App.vue uses v-if), so mount == open and lifecycle side effects are
// exercised exactly as in production.
const Harness = defineComponent(
  (props: { attachments: AttachmentMetadata[] }) => {
    const { state } = useImageLightbox();
    return () =>
      h("div", [
        h(MessageAttachments, { attachments: props.attachments }),
        state.value ? h(ImageLightbox) : null,
      ]);
  },
  { props: { attachments: { type: Array, required: true } } },
);

// attachTo: focus() must move document.activeElement, which jsdom only does for
// nodes in the document (a detached wrapper subtree won't take focus).
function mountHarness(attachments: AttachmentMetadata[]) {
  const wrapper = mount(Harness, { props: { attachments }, attachTo: document.body });
  wrappers.push(wrapper);
  return wrapper;
}

test("renders an image attachment as a thumbnail using previewUrl", () => {
  const wrapper = mount(MessageAttachments, {
    props: { attachments: [img("a", "data:image/png;base64,AA")] },
  });
  const thumb = wrapper.find('[data-test="att-image"]');
  expect(thumb.exists()).toBe(true);
  expect(thumb.find("img").attributes("src")).toBe("data:image/png;base64,AA");
});

test("renders a non-image attachment as a file card with name + size", () => {
  const wrapper = mount(MessageAttachments, {
    props: { attachments: [{ id: "2", filename: "report.pdf", mimeType: "application/pdf", size: 2048, kind: "file" }] },
  });
  expect(wrapper.find('[data-test="att-file"]').exists()).toBe(true);
  expect(wrapper.text()).toContain("report.pdf");
});

test("clicking a thumbnail opens the fullscreen viewer on that image", async () => {
  const wrapper = mountHarness([img("a", "data:image/png;base64,AA"), img("b", "data:image/png;base64,BB")]);
  await wrapper.findAll('[data-test="att-image"]')[1]!.trigger("click");
  await nextTick();

  expect(document.querySelector('[data-test="image-lightbox"]')).not.toBeNull();
  expect(document.querySelector('[data-test="lightbox-counter"]')?.textContent).toContain("2 / 2");
  const shown = document.querySelector<HTMLImageElement>('[data-test="lightbox-image"]');
  expect(shown?.getAttribute("src")).toBe("data:image/png;base64,BB");
});

test("viewer pages prev/next within the bubble's image set and stops at the ends", async () => {
  const wrapper = mountHarness([
    img("a", "data:image/png;base64,AA"),
    img("b", "data:image/png;base64,BB"),
    img("c", "data:image/png;base64,CC"),
  ]);
  await wrapper.findAll('[data-test="att-image"]')[0]!.trigger("click");
  await nextTick();

  // Opened on the first image: no prev arrow (start of set), next available.
  expect(document.querySelector('[data-test="lightbox-prev"]')).toBeNull();
  expect(document.querySelector('[data-test="lightbox-next"]')).not.toBeNull();

  (document.querySelector<HTMLButtonElement>('[data-test="lightbox-next"]')!).click();
  await nextTick();
  expect(document.querySelector('[data-test="lightbox-counter"]')?.textContent).toContain("2 / 3");

  (document.querySelector<HTMLButtonElement>('[data-test="lightbox-prev"]')!).click();
  await nextTick();
  expect(document.querySelector('[data-test="lightbox-counter"]')?.textContent).toContain("1 / 3");

  // Close restores state.
  (document.querySelector<HTMLButtonElement>('[data-test="lightbox-close"]')!).click();
  await nextTick();
  expect(useImageLightbox().state.value).toBeNull();
});

test("closed viewer leaves body scroll untouched; open locks and close restores it without unmount", async () => {
  document.body.style.overflow = "auto";
  const wrapper = mountHarness([img("a", "data:image/png;base64,AA")]);
  await nextTick();
  // Never opened: no scroll lock, no overlay.
  expect(document.body.style.overflow).toBe("auto");
  expect(document.querySelector('[data-test="image-lightbox"]')).toBeNull();

  await wrapper.find('[data-test="att-image"]').trigger("click");
  await nextTick();
  expect(document.body.style.overflow).toBe("hidden");

  (document.querySelector<HTMLButtonElement>('[data-test="lightbox-close"]')!).click();
  await nextTick();
  expect(useImageLightbox().state.value).toBeNull();
  expect(document.querySelector('[data-test="image-lightbox"]')).toBeNull();
  // Restored WITHOUT unmounting the harness.
  expect(document.body.style.overflow).toBe("auto");
  document.body.style.overflow = "";
});

test("focus moves into the viewer while open and returns to the trigger on close", async () => {
  const wrapper = mountHarness([img("a", "data:image/png;base64,AA"), img("b", "data:image/png;base64,BB")]);
  const thumbEl = wrapper.findAll('[data-test="att-image"]')[1]!.element as HTMLElement;
  thumbEl.focus();
  expect(document.activeElement).toBe(thumbEl);

  await wrapper.findAll('[data-test="att-image"]')[1]!.trigger("click");
  await nextTick();
  // useModalA11y focuses the first focusable (the ✕ button) on mount; the key
  // invariant is that focus LIVES INSIDE the overlay while open.
  const overlay = document.querySelector<HTMLElement>('[data-test="image-lightbox"]')!;
  expect(overlay).not.toBeNull();
  expect(overlay.contains(document.activeElement)).toBe(true);

  (document.querySelector<HTMLButtonElement>('[data-test="lightbox-close"]')!).click();
  await nextTick();
  expect(document.activeElement).toBe(thumbEl);
});

test("Escape closes only the lightbox, not an underlying modal-stack dialog", async () => {
  const events: string[] = [];
  // A stand-in for SubagentTraceDialog: registered in the same shared stack.
  const underDialogClose = vi.fn(() => events.push("under"));
  const Under = defineComponent({
    setup() {
      const el = ref<HTMLElement | null>(null);
      useModalA11y(el, underDialogClose);
      return () =>
        h(
          "div",
          { ref: el, tabindex: "-1", role: "dialog", "aria-modal": "true", "data-test": "under-dialog" },
          [h(MessageAttachments, { attachments: [img("a", "data:image/png;base64,AA")] }), h(ImageLightboxGate)],
        );
    },
  });
  // Lightbox must be mounted AFTER the underlying dialog so it sits on top of the stack.
  const ImageLightboxGate = defineComponent({
    setup() {
      const { state } = useImageLightbox();
      return () => (state.value ? h(ImageLightbox) : null);
    },
  });
  const wrapper = mount(Under);
  wrappers.push(wrapper);
  await wrapper.find('[data-test="att-image"]').trigger("click");
  await nextTick();

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await nextTick();
  expect(events).toEqual([]); // lightbox handled it first
  expect(useImageLightbox().state.value).toBeNull(); // lightbox closed…
  expect(underDialogClose).not.toHaveBeenCalled(); // …underlying dialog did NOT
});
