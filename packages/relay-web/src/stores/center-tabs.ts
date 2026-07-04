import { defineStore } from "pinia";
import { ref } from "vue";

export type CenterTab =
  // targetLine/targetRev: a scroll-to-line request (e.g. from a content-search hit). rev is
  // bumped on every openFile so re-opening the SAME file at the same line still re-scrolls.
  | { kind: "file"; id: string; path: string; targetLine?: number; targetRev?: number; dirty?: boolean }
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

/** Sentinel `targetId` for `reorder()`: drop past the last tab moves the
 *  dragged tab to the end of the list instead of before a real tab. */
export const TAB_DROP_END = "__end__";

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

  // Bumped on every openFile so a scroll-to-line request re-fires even when the target file
  // (and line) is already open — FileViewer watches targetRev.
  let revCounter = 0;
  function openFile(key: string, path: string, line?: number): void {
    revCounter += 1;
    const id = `file:${path}`;
    const current = bySession.value[key] ?? { tabs: [], activeId: "chat" };
    const idx = current.tabs.findIndex((t) => t.id === id);
    const existing = idx === -1 ? undefined : current.tabs[idx];
    const tab: CenterTab = {
      kind: "file", id, path, targetLine: line, targetRev: revCounter,
      dirty: existing?.kind === "file" ? existing.dirty : undefined,
    };
    const tabs = idx === -1 ? [...current.tabs, tab] : current.tabs.map((t, i) => (i === idx ? tab : t));
    bySession.value = { ...bySession.value, [key]: { tabs, activeId: id } };
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

  /** Moves `draggedId` before `targetId`, or to the end of the list when
   *  `targetId` is `TAB_DROP_END` (a drop past the last tab). No-op if
   *  `draggedId` isn't open, or `targetId` is neither `TAB_DROP_END` nor an
   *  open tab. */
  function reorder(key: string, draggedId: string, targetId: string): void {
    if (draggedId === targetId) return;
    const current = bySession.value[key];
    if (!current) return;
    const draggedIndex = current.tabs.findIndex((t) => t.id === draggedId);
    if (draggedIndex === -1) return;
    const isEnd = targetId === TAB_DROP_END;
    if (!isEnd && !current.tabs.some((t) => t.id === targetId)) return;
    const tabs = [...current.tabs];
    const [dragged] = tabs.splice(draggedIndex, 1);
    if (isEnd) {
      tabs.push(dragged);
    } else {
      const insertAt = tabs.findIndex((t) => t.id === targetId);
      tabs.splice(insertAt, 0, dragged);
    }
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

  function setDirty(key: string, id: string, dirty: boolean): void {
    const current = bySession.value[key];
    if (!current) return;
    const tabs = current.tabs.map((t) => (t.id === id && t.kind === "file" ? { ...t, dirty } : t));
    bySession.value = { ...bySession.value, [key]: { tabs, activeId: current.activeId } };
  }

  function isDirty(key: string, id: string): boolean {
    const t = bySession.value[key]?.tabs.find((x) => x.id === id);
    return !!(t && t.kind === "file" && t.dirty);
  }

  /** Close `id`, but if it holds unsaved edits, ask `confirm()` first. Returns whether the
   *  tab was closed. `confirm` is injected (the store cannot show UI) — callers pass e.g.
   *  `() => window.confirm(t("files.unsavedConfirm"))`. */
  function closeTabGuarded(key: string, id: string, confirm: () => boolean): boolean {
    if (isDirty(key, id) && !confirm()) return false;
    closeTab(key, id);
    return true;
  }

  return {
    tabsFor, activeFor,
    openFile, openDiff, openTerminal,
    setActive, closeTab, reorder, clearSession, allOpenTabs,
    setDirty, isDirty, closeTabGuarded,
  };
});
