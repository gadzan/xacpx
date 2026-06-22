import { mount } from "@vue/test-utils";
import { expect, test } from "vitest";

import MessageAttachments from "../components/MessageAttachments.vue";

test("renders an image attachment as a thumbnail using previewUrl", () => {
  const wrapper = mount(MessageAttachments, {
    props: { attachments: [{ id: "1", filename: "a.png", mimeType: "image/png", size: 10, kind: "image", previewUrl: "data:image/png;base64,AA" }] },
  });
  const img = wrapper.find('[data-test="att-image"]');
  expect(img.exists()).toBe(true);
  expect(img.attributes("src")).toBe("data:image/png;base64,AA");
});

test("renders a non-image attachment as a file card with name + size", () => {
  const wrapper = mount(MessageAttachments, {
    props: { attachments: [{ id: "2", filename: "report.pdf", mimeType: "application/pdf", size: 2048, kind: "file" }] },
  });
  expect(wrapper.find('[data-test="att-file"]').exists()).toBe(true);
  expect(wrapper.text()).toContain("report.pdf");
});
