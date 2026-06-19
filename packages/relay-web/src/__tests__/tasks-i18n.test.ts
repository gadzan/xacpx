import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../i18n";
import ScheduledTasks from "../components/ScheduledTasks.vue";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";

describe("task panels i18n", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => { i18n.global.locale.value = "en"; });

  it("renders Chinese status labels and affordances when locale is zh-CN", () => {
    i18n.global.locale.value = "zh-CN";
    const chat = useChatStore();
    chat.select("inst", "backend");
    const tasks = useTasksStore();
    tasks.scope = { instanceId: "inst", sessionAlias: "backend" };
    tasks.scheduled = [
      { id: "ok1", sessionAlias: "backend", executeAt: "2026-01-01T00:00:00Z", message: "ran", status: "executed", createdAt: "x", executedAt: "y" },
    ] as never;
    const w = mount(ScheduledTasks);
    // Status pill ("Done" → 已完成) and the view-run affordance ("View run" → 查看运行).
    expect(w.find('[data-test="scheduled-status-ok1"]').text()).toContain("已完成");
    expect(w.find('[data-test="view-scheduled"]').attributes("aria-label")).toBe("查看运行");
    // Section header is localized too ("Scheduled" → 计划任务).
    expect(w.text()).toContain("计划任务");
  });
});
