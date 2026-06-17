import { mount } from "@vue/test-utils";
import { describe, it, expect } from "vitest";
import PlanPanel from "../components/PlanPanel.vue";

describe("PlanPanel", () => {
  it("renders entries with a done count and strikes completed ones", () => {
    const w = mount(PlanPanel, { props: { entries: [
      { content: "a", status: "completed" }, { content: "b", status: "in_progress" },
    ] } });
    expect(w.find('[data-test="plan-panel"]').text()).toContain("1/2");
    const items = w.findAll("li");
    // The completed entry strikes through; the in-progress one does not.
    expect(items[0].find("span").classes()).toContain("line-through");
    expect(items[1].find("span").classes()).not.toContain("line-through");
  });
  it("renders nothing for an empty plan", () => {
    const w = mount(PlanPanel, { props: { entries: [] } });
    expect(w.find('[data-test="plan-panel"]').exists()).toBe(false);
  });
});
