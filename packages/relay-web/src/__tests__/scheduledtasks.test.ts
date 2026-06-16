import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ScheduledTasks from "../components/ScheduledTasks.vue";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";

describe("ScheduledTasks panel", () => {
  beforeEach(() => setActivePinia(createPinia()));

  function seed(scheduled: unknown[]) {
    const chat = useChatStore();
    chat.select("inst", "backend");
    const tasks = useTasksStore();
    tasks.scope = { instanceId: "inst", sessionAlias: "backend" };
    tasks.scheduled = scheduled as never;
    return { chat, tasks };
  }

  it("shows a status pill per task and keeps fired runs in place (Done/Failed)", () => {
    seed([
      { id: "up1", sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z", message: "soon", status: "pending", createdAt: "x" },
      { id: "ok1", sessionAlias: "backend", executeAt: "2026-01-01T00:00:00Z", message: "ran", status: "executed", createdAt: "x", executedAt: "y" },
      { id: "bad1", sessionAlias: "backend", executeAt: "2026-01-01T00:00:00Z", message: "broke", status: "failed", createdAt: "x", failedAt: "y", lastError: "channel offline" },
    ]);
    const w = mount(ScheduledTasks);
    // Status pills are always visible in the compact header.
    expect(w.find('[data-test="scheduled-status-up1"]').text()).toContain("Upcoming");
    expect(w.find('[data-test="scheduled-status-ok1"]').text()).toContain("Done");
    expect(w.find('[data-test="scheduled-status-bad1"]').text()).toContain("Failed");
  });

  it("collapses rows by default and reveals the failure reason on expand", async () => {
    seed([
      { id: "bad1", sessionAlias: "backend", executeAt: "2026-01-01T00:00:00Z", message: "broke", status: "failed", createdAt: "x", failedAt: "y", lastError: "channel offline" },
    ]);
    const w = mount(ScheduledTasks);
    // Collapsed: the error text is not shown until the row is expanded.
    expect(w.find('[data-test="scheduled-error-bad1"]').exists()).toBe(false);
    await w.find('[data-test="scheduled-toggle-bad1"]').trigger("click");
    expect(w.find('[data-test="scheduled-error-bad1"]').text()).toContain("channel offline");
    // Toggling again collapses it back.
    await w.find('[data-test="scheduled-toggle-bad1"]').trigger("click");
    expect(w.find('[data-test="scheduled-error-bad1"]').exists()).toBe(false);
  });

  it("offers Cancel only for upcoming tasks and View only for fired runs", () => {
    seed([
      { id: "up1", sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z", message: "soon", status: "pending", createdAt: "x" },
      { id: "ok1", sessionAlias: "backend", executeAt: "2026-01-01T00:00:00Z", message: "ran", status: "executed", createdAt: "x", executedAt: "y" },
    ]);
    const w = mount(ScheduledTasks);
    // Exactly one cancel (the pending one) and one view (the executed one).
    expect(w.findAll('[data-test="cancel-scheduled"]').length).toBe(1);
    expect(w.findAll('[data-test="view-scheduled"]').length).toBe(1);
  });

  it("View asks the conversation to jump to that run", async () => {
    const { chat } = seed([
      { id: "ok1", sessionAlias: "backend", executeAt: "2026-01-01T00:00:00Z", message: "ran", status: "executed", createdAt: "x", executedAt: "y" },
    ]);
    const spy = vi.spyOn(chat, "requestScrollToScheduled");
    const w = mount(ScheduledTasks);
    await w.find('[data-test="view-scheduled"]').trigger("click");
    expect(spy).toHaveBeenCalledWith("ok1");
  });

  function many(n: number): unknown[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z",
      message: `task ${i}`, status: "pending", createdAt: "x",
    }));
  }

  it("caps the inline list at three and offers View all for the rest", () => {
    seed(many(5));
    const w = mount(ScheduledTasks, { global: { stubs: { teleport: true } } });
    // Only the first three render inline; the drawer is closed so nothing extra mounts.
    expect(w.findAll('[data-test="scheduled-item"]').length).toBe(3);
    expect(w.find('[data-test="scheduled-view-all"]').text()).toContain("View all 5");
    expect(w.find('[data-test="scheduled-drawer"]').exists()).toBe(false);
  });

  it("does not offer View all when three or fewer tasks", () => {
    seed(many(3));
    const w = mount(ScheduledTasks, { global: { stubs: { teleport: true } } });
    expect(w.find('[data-test="scheduled-view-all"]').exists()).toBe(false);
  });

  it("opens a drawer with the full list and closes it again", async () => {
    seed(many(5));
    const w = mount(ScheduledTasks, { global: { stubs: { teleport: true } } });
    await w.find('[data-test="scheduled-view-all"]').trigger("click");
    expect(w.find('[data-test="scheduled-drawer"]').exists()).toBe(true);
    // Inline three + all five in the drawer = eight rows total.
    expect(w.findAll('[data-test="scheduled-item"]').length).toBe(8);
    await w.find('[data-test="scheduled-drawer-close"]').trigger("click");
    expect(w.find('[data-test="scheduled-drawer"]').exists()).toBe(false);
  });
});
