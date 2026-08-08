import { mount } from "@vue/test-utils";
import { describe, it, expect } from "vitest";
import PlanPanel from "../components/PlanPanel.vue";

// jsdom has no scrollIntoView; the panel calls it on update.
(window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

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
  it("collapses and expands when the header toggle is clicked", async () => {
    const w = mount(PlanPanel, { props: { entries: [
      { content: "a", status: "completed" }, { content: "b", status: "in_progress" },
    ] } });
    // Expanded by default: the list is visible.
    expect(w.find("#plan-list").attributes("style") ?? "").not.toContain("display: none");
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
    // Collapse.
    await w.find('[data-test="plan-toggle"]').trigger("click");
    expect(w.find("#plan-list").attributes("style")).toContain("display: none");
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("false");
    // Expand again.
    await w.find('[data-test="plan-toggle"]').trigger("click");
    expect(w.find("#plan-list").attributes("style") ?? "").not.toContain("display: none");
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
  });
  it("caps the list height with a scroll container", () => {
    const w = mount(PlanPanel, { props: { entries: [
      { content: "a", status: "in_progress" },
    ] } });
    const classes = w.find("#plan-list").classes();
    expect(classes).toContain("max-h-48");
    expect(classes).toContain("overflow-y-auto");
  });
  it("bounds the list height in the overlay variant", () => {
    const w = mount(PlanPanel, { props: { variant: "overlay", entries: [
      { content: "a", status: "in_progress" },
    ] } });
    const classes = w.find("#plan-list").classes();
    expect(classes).not.toContain("max-h-48");
    expect(classes).toContain("max-h-[calc(min(40vh,20rem)-2.5rem)]");
    expect(classes).toContain("overflow-y-auto");
    expect(w.find('[data-test="plan-panel"]').classes()).toContain("max-h-[min(40vh,20rem)]");
  });
  it("still toggles in the overlay variant", async () => {
    const w = mount(PlanPanel, { props: { variant: "overlay", entries: [
      { content: "a", status: "in_progress" },
    ] } });
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
    await w.find('[data-test="plan-toggle"]').trigger("click");
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("false");
  });
  it("scrolls the active task into view on an entries update", async () => {
    const calls: unknown[] = [];
    (window.HTMLElement.prototype as unknown as { scrollIntoView: (a?: unknown) => void })
      .scrollIntoView = (a) => { calls.push(a); };
    const w = mount(PlanPanel, { props: { entries: [
      { content: "a", status: "completed" }, { content: "b", status: "in_progress" },
    ] } });
    await w.setProps({ entries: [
      { content: "a", status: "completed" }, { content: "b", status: "completed" },
      { content: "c", status: "in_progress" },
    ] });
    await w.vm.$nextTick();
    expect(calls.length).toBeGreaterThan(0);
  });
  it("auto-collapses when the turn ends and expands when it runs", async () => {
    const w = mount(PlanPanel, { props: { active: true, entries: [
      { content: "a", status: "in_progress" },
    ] } });
    // active turn → expanded
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
    // turn ends → collapses but STAYS mounted
    await w.setProps({ active: false });
    expect(w.find('[data-test="plan-panel"]').exists()).toBe(true);
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("false");
    // a new turn starts → expands again
    await w.setProps({ active: true });
    expect(w.find('[data-test="plan-toggle"]').attributes("aria-expanded")).toBe("true");
  });
});
