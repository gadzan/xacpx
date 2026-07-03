import { defineStore } from "pinia";
import { ref } from "vue";

export type CenterTab =
  | { kind: "file"; id: string; path: string }
  | { kind: "diff"; id: string; path: string }
  | { kind: "terminal"; id: string };

interface SessionTabs {
  tabs: CenterTab[];
  activeId: string;
}

/** Stable per-session key: `${instanceId}::${alias}`. */
export function sessionKey(instanceId: string, alias: string): string {
  return `${instanceId}::${alias}`;
}

export const useCenterTabsStore = defineStore("center-tabs", () => {
  const bySession = ref<Record<string, SessionTabs>>({});

  function tabsFor(key: string): CenterTab[] {
    return bySession.value[key]?.tabs ?? [];
  }

  function activeFor(key: string): string {
    return bySession.value[key]?.activeId ?? "chat";
  }

  /** Insert-or-activate a tab by id: existing id just activates; new id is appended and activated. */
  function upsertAndActivate(key: string, tab: CenterTab): void {
    const current = bySession.value[key] ?? { tabs: [], activeId: "chat" };
    const exists = current.tabs.some((t) => t.id === tab.id);
    const tabs = exists ? current.tabs : [...current.tabs, tab];
    bySession.value = { ...bySession.value, [key]: { tabs, activeId: tab.id } };
  }

  function openFile(key: string, path: string): void {
    upsertAndActivate(key, { kind: "file", id: path, path });
  }

  function openDiff(key: string, path: string): void {
    upsertAndActivate(key, { kind: "diff", id: `diff:${path}`, path });
  }

  function openTerminal(key: string): void {
    upsertAndActivate(key, { kind: "terminal", id: "terminal" });
  }

  function setActive(key: string, id: string): void {
    const current = bySession.value[key] ?? { tabs: [], activeId: "chat" };
    bySession.value = { ...bySession.value, [key]: { tabs: current.tabs, activeId: id } };
  }

  function closeTab(key: string, id: string): void {
    const current = bySession.value[key];
    if (!current) return;
    const index = current.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    const tabs = current.tabs.filter((t) => t.id !== id);
    const wasActive = current.activeId === id;
    const activeId = wasActive ? (current.tabs[index - 1]?.id ?? tabs[index]?.id ?? "chat") : current.activeId;
    bySession.value = { ...bySession.value, [key]: { tabs, activeId } };
  }

  function reorder(key: string, draggedId: string, targetId: string): void {
    if (draggedId === targetId) return;
    const current = bySession.value[key];
    if (!current) return;
    const draggedIndex = current.tabs.findIndex((t) => t.id === draggedId);
    const targetIndex = current.tabs.findIndex((t) => t.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return;
    const tabs = [...current.tabs];
    const [dragged] = tabs.splice(draggedIndex, 1);
    const insertAt = tabs.findIndex((t) => t.id === targetId);
    tabs.splice(insertAt, 0, dragged);
    bySession.value = { ...bySession.value, [key]: { tabs, activeId: current.activeId } };
  }

  function clearSession(key: string): void {
    if (!(key in bySession.value)) return;
    const next = { ...bySession.value };
    delete next[key];
    bySession.value = next;
  }

  function allOpenTabs(): { key: string; tab: CenterTab }[] {
    return Object.entries(bySession.value).flatMap(([key, s]) => s.tabs.map((tab) => ({ key, tab })));
  }

  return {
    tabsFor, activeFor,
    openFile, openDiff, openTerminal,
    setActive, closeTab, reorder, clearSession, allOpenTabs,
  };
});
