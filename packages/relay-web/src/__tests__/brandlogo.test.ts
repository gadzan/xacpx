import { mount } from "@vue/test-utils";
import { expect, it } from "vitest";
import BrandLogo from "../components/BrandLogo.vue";

it("renders the gradient X mark and the xacpx · relay wordmark", () => {
  const w = mount(BrandLogo);
  expect(w.find('[data-test="brand-x"]').exists()).toBe(true);
  expect(w.find("linearGradient").exists()).toBe(true);
  expect(w.text()).toContain("xacpx");
  expect(w.text()).toContain("relay");
});
