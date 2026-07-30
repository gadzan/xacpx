import { defineStore } from "pinia";
import { ref } from "vue";
import type { OrchestrationTaskDto, ScheduledTaskDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import * as viewCache from "../lib/view-snapshot-cache";
import { useAuthStore } from "./auth";

export interface TasksScope {
  instanceId: string;
  sessionAlias: string;
}

export const useTasksStore = defineStore("tasks", () => {
  const scheduled = ref<ScheduledTaskDto[]>([]);
  const orchestration = ref<OrchestrationTaskDto[]>([]);
  const scope = ref<TasksScope | null>(null);
  let scheduledRevision = 0;
  let orchestrationRevision = 0;

  const cacheUser = (): string | null => useAuthStore().account?.username ?? null;
  const isScheduledScope = (instanceId: string, sessionAlias: string): boolean =>
    scope.value === null
    || (scope.value.instanceId === instanceId && scope.value.sessionAlias === sessionAlias);
  const isOrchestrationScope = (instanceId: string): boolean =>
    scope.value === null || scope.value.instanceId === instanceId;

  async function loadScheduled(instanceId: string, sessionAlias: string): Promise<void> {
    const revision = ++scheduledRevision;
    const user = cacheUser();
    if (user) {
      const cached = viewCache.peek<ScheduledTaskDto[]>(user, "scheduled-tasks", instanceId, sessionAlias)
        ?? await viewCache.read<ScheduledTaskDto[]>(user, "scheduled-tasks", instanceId, sessionAlias);
      if (revision !== scheduledRevision || !isScheduledScope(instanceId, sessionAlias) || cacheUser() !== user) return;
      if (Array.isArray(cached)) scheduled.value = cached;
    }
    const { tasks } = await api.rpc<{ tasks: ScheduledTaskDto[] }>(instanceId, "control.scheduled.list");
    const filtered = tasks.filter((t) => t.sessionAlias === sessionAlias);
    if (user && cacheUser() === user) void viewCache.write(user, "scheduled-tasks", instanceId, sessionAlias, filtered);
    if (revision === scheduledRevision && isScheduledScope(instanceId, sessionAlias)) scheduled.value = filtered;
  }

  async function loadOrchestration(instanceId: string): Promise<void> {
    const revision = ++orchestrationRevision;
    const user = cacheUser();
    if (user) {
      const cached = viewCache.peek<OrchestrationTaskDto[]>(user, "orchestration-tasks", instanceId, "")
        ?? await viewCache.read<OrchestrationTaskDto[]>(user, "orchestration-tasks", instanceId, "");
      if (revision !== orchestrationRevision || !isOrchestrationScope(instanceId) || cacheUser() !== user) return;
      if (Array.isArray(cached)) orchestration.value = cached;
    }
    const { tasks } = await api.rpc<{ tasks: OrchestrationTaskDto[] }>(instanceId, "control.orchestration.list");
    if (user && cacheUser() === user) void viewCache.write(user, "orchestration-tasks", instanceId, "", tasks);
    if (revision === orchestrationRevision && isOrchestrationScope(instanceId)) orchestration.value = tasks;
  }

  async function loadFor(instanceId: string, sessionAlias: string): Promise<void> {
    const previous = scope.value;
    const sameSession = previous?.instanceId === instanceId && previous.sessionAlias === sessionAlias;
    const sameInstance = previous?.instanceId === instanceId;
    scope.value = { instanceId, sessionAlias };
    if (!sameSession) scheduled.value = [];
    if (!sameInstance) orchestration.value = [];
    await Promise.all([
      loadScheduled(instanceId, sessionAlias).catch(() => {}),
      loadOrchestration(instanceId).catch(() => {}),
    ]);
  }

  async function createScheduled(instanceId: string, sessionAlias: string, executeAt: string, message: string): Promise<void> {
    await api.rpc(instanceId, "control.scheduled.create", { sessionAlias, executeAt, message });
    await loadScheduled(instanceId, sessionAlias);
  }

  async function cancelScheduled(id: string): Promise<void> {
    const s = scope.value;
    if (!s) return;
    await api.rpc(s.instanceId, "control.scheduled.cancel", { id });
    await loadScheduled(s.instanceId, s.sessionAlias);
  }

  async function cancelOrchestration(taskId: string): Promise<void> {
    const s = scope.value;
    if (!s) return;
    await api.rpc(s.instanceId, "control.orchestration.cancel", { taskId });
    await loadOrchestration(s.instanceId);
  }

  function applyEvent(event: WebServerEvent): void {
    if (event.kind !== "control-event") return;
    const s = scope.value;
    if (!s || event.instanceId !== s.instanceId) return;
    if (event.event.type === "scheduled-changed") void loadScheduled(s.instanceId, s.sessionAlias).catch(() => {});
    else if (event.event.type === "orchestration-changed") void loadOrchestration(s.instanceId).catch(() => {});
  }

  return { scheduled, orchestration, scope, loadScheduled, loadOrchestration, loadFor, createScheduled, cancelScheduled, cancelOrchestration, applyEvent };
});
