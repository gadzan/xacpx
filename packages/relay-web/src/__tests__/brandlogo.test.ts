import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import BrandLogo from "../components/BrandLogo.vue";

it("renders the green/blue X mark and the XACPX HUB wordmark", () => {
  const w = mount(BrandLogo);
  expect(w.find('[data-test="brand-x"]').exists()).toBe(true);
  // The mark is built from brand-color capsules (green ∨ + two blue legs), no gradient.
  const strokes = w.findAll("path").map((p) => p.attributes("stroke"));
  expect(strokes).toContain("#69D689");
  expect(strokes).toContain("#4F9BF5");
  expect(w.text()).toContain("XACPX");
  expect(w.text()).toContain("HUB");
});
