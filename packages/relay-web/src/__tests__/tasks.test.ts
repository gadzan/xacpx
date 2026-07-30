import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("../api/client", () => ({
  api: { rpc: vi.fn() },
  ApiError: class extends Error {},
}));

import { api } from "../api/client";
import { useTasksStore } from "../stores/tasks";
import { useAuthStore } from "../stores/auth";
import {
  dropSession as dropSessionViewSnapshots,
  read as readViewSnapshot,
  write as writeViewSnapshot,
} from "../lib/view-snapshot-cache";

const rpc = api.rpc as unknown as ReturnType<typeof vi.fn>;

describe("tasks store", () => {
  beforeEach(() => { setActivePinia(createPinia()); rpc.mockReset(); });

  it("loadScheduled stores only the current session's tasks", async () => {
    rpc.mockResolvedValueOnce({ tasks: [
      { id: "1", sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z", message: "a", status: "pending", createdAt: "x" },
      { id: "2", sessionAlias: "frontend", executeAt: "2030-01-01T00:00:00Z", message: "b", status: "pending", createdAt: "x" },
    ]});
    const store = useTasksStore();
    await store.loadScheduled("inst", "backend");
    expect(rpc).toHaveBeenCalledWith("inst", "control.scheduled.list");
    expect(store.scheduled.map((t) => t.id)).toEqual(["1"]);
  });

  it("loadOrchestration stores all instance tasks", async () => {
    rpc.mockResolvedValueOnce({ tasks: [{ taskId: "t1", status: "running", targetAgent: "claude", workspace: "/w", task: "x", summary: "", createdAt: "x", updatedAt: "x" }] });
    const store = useTasksStore();
    await store.loadOrchestration("inst");
    expect(rpc).toHaveBeenCalledWith("inst", "control.orchestration.list");
    expect(store.orchestration).toHaveLength(1);
  });

  it("loadFor paints cached tasks before both refreshes settle", async () => {
    useAuthStore().account = { username: "alice" };
    const scheduledTask = {
      id: "cached",
      sessionAlias: "backend",
      executeAt: "2030-01-01T00:00:00Z",
      message: "cached",
      status: "pending",
      createdAt: "x",
    };
    await writeViewSnapshot("alice", "scheduled-tasks", "inst", "backend", [scheduledTask]);
    await writeViewSnapshot("alice", "orchestration-tasks", "inst", "", [{
      taskId: "cached-orchestration",
      status: "running",
      targetAgent: "claude",
      workspace: "/w",
      task: "cached",
      summary: "",
      createdAt: "x",
      updatedAt: "x",
    }]);
    let resolveScheduled!: (value: unknown) => void;
    let resolveOrchestration!: (value: unknown) => void;
    rpc
      .mockReturnValueOnce(new Promise((resolve) => { resolveScheduled = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveOrchestration = resolve; }));
    const store = useTasksStore();
    const pending = store.loadFor("inst", "backend");

    expect(store.scheduled.map((task) => task.id)).toEqual(["cached"]);
    expect(store.orchestration.map((task) => task.taskId)).toEqual(["cached-orchestration"]);

    resolveScheduled({ tasks: [] });
    resolveOrchestration({ tasks: [] });
    await pending;
    expect(store.scheduled).toEqual([]);
    expect(store.orchestration).toEqual([]);
  });

  it("does not repopulate a deleted session cache from an older task refresh", async () => {
    useAuthStore().account = { username: "task-delete-race-user" };
    let resolveScheduled!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((resolve) => { resolveScheduled = resolve; }));
    const store = useTasksStore();
    const pending = store.loadScheduled("inst", "deleted-session");
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());

    await dropSessionViewSnapshots("task-delete-race-user", "inst", "deleted-session");
    resolveScheduled({ tasks: [{
      id: "stale-task",
      sessionAlias: "deleted-session",
      executeAt: "2030-01-01T00:00:00Z",
      message: "stale",
      status: "pending",
      createdAt: "x",
    }] });
    await pending;

    expect(
      await readViewSnapshot("task-delete-race-user", "scheduled-tasks", "inst", "deleted-session"),
    ).toBeNull();
  });

  it("createScheduled posts then reloads", async () => {
    rpc.mockResolvedValueOnce({});
    rpc.mockResolvedValueOnce({ tasks: [] });
    const store = useTasksStore();
    await store.createScheduled("inst", "backend", "2030-01-01T00:00:00Z", "do it");
    expect(rpc).toHaveBeenNthCalledWith(1, "inst", "control.scheduled.create", { sessionAlias: "backend", executeAt: "2030-01-01T00:00:00Z", message: "do it" });
    expect(rpc).toHaveBeenNthCalledWith(2, "inst", "control.scheduled.list");
  });

  it("cancelScheduled posts then reloads", async () => {
    rpc.mockResolvedValueOnce({ cancelled: true });
    rpc.mockResolvedValueOnce({ tasks: [] });
    const store = useTasksStore();
    store.scope = { instanceId: "inst", sessionAlias: "backend" };
    await store.cancelScheduled("9");
    expect(rpc).toHaveBeenNthCalledWith(1, "inst", "control.scheduled.cancel", { id: "9" });
  });

  it("applyEvent reloads scheduled for the scoped instance on scheduled-changed", async () => {
    rpc.mockResolvedValue({ tasks: [] });
    const store = useTasksStore();
    store.scope = { instanceId: "inst", sessionAlias: "backend" };
    store.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "scheduled-changed", chatKey: "relay:a" } });
    expect(rpc).toHaveBeenCalledWith("inst", "control.scheduled.list");
  });
});
