import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TaskPanel from "../components/TaskPanel.vue";
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";
import { settleConfirm } from "../lib/use-confirm";

describe("TaskPanel", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => settleConfirm(false));

  it("shows a hint when no session is selected", () => {
    const w = mount(TaskPanel);
    expect(w.text()).toContain("No session selected");
  });

  it("renders scheduled and orchestration rows for the selected session", async () => {
    const chat = useChatStore();
    chat.select("inst", "backend");
    const tasks = useTasksStore();
    tasks.scope = { instanceId: "inst", sessionAlias: "backend" };
    tasks.scheduled = [{ id: "1", sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z", message: "ping", status: "pending", createdAt: "x" }] as never;
    tasks.orchestration = [{ taskId: "t1", status: "running", targetAgent: "claude", workspace: "/w", task: "build", summary: "", createdAt: "x", updatedAt: "x" }] as never;
    const w = mount(TaskPanel);
    await w.vm.$nextTick();
    expect(w.text()).toContain("ping");
    expect(w.text()).toContain("build");
  });

  it("cancel button invokes cancelScheduled", async () => {
    const chat = useChatStore();
    chat.select("inst", "backend");
    const tasks = useTasksStore();
    tasks.scope = { instanceId: "inst", sessionAlias: "backend" };
    tasks.scheduled = [{ id: "9", sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z", message: "ping", status: "pending", createdAt: "x" }] as never;
    const spy = vi.spyOn(tasks, "cancelScheduled").mockResolvedValue();
    const w = mount(TaskPanel);
    await w.find('[data-test="cancel-scheduled"]').trigger("click");
    expect(spy).not.toHaveBeenCalled(); // awaits popup confirm
    settleConfirm(true);
    await flushPromises();
    expect(spy).toHaveBeenCalledWith("9");
  });
});
