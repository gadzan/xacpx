import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import type { AttachmentMetadata } from "@ganglion/xacpx-relay-protocol";

import MessageAttachments from "../components/MessageAttachments.vue";
import ImageLightbox from "../components/ImageLightbox.vue";
import { closeLightbox, useImageLightbox } from "../lib/use-image-lightbox";

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

// The viewer lives in App.vue (singleton state), so the harness pairs the list
// renderer with one viewer instance the way the real app shell does.
const Harness = defineComponent(
  (props: { attachments: AttachmentMetadata[] }) => {
    return () =>
      h("div", [
        h(MessageAttachments, { attachments: props.attachments }),
        h(ImageLightbox),
      ]);
  },
  { props: { attachments: { type: Array, required: true } } },
);

function mountHarness(attachments: AttachmentMetadata[]) {
  const wrapper = mount(Harness, { props: { attachments } });
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
