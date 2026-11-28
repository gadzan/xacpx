import { defineStore } from "pinia";
import type { InjectionKey, Ref } from "vue";

/** Injection key through which SplitWorkbench shares its layout's primary key
 *  with the columns it hosts (scoped panes open dispatched sessions under the
 *  layout they live in, not under the global selection). */
export const splitPrimaryKey: InjectionKey<Ref<string> | null> = Symbol("splitPrimaryKey");

export type SplitPaneTarget =
  | { kind: "session"; instanceId: string; sessionAlias: string }
  | { kind: "bot"; instanceId: string; botId: string; topicId?: string };

export interface SplitColumn {
  id: string;
  target: SplitPaneTarget;
  widthFraction: number;
  source?: "manual" | "bot-dispatch";
}

export interface SplitLayoutState {
  columns: SplitColumn[];
  focusedColumnId: string;
  dismissedSessionKeys: string[];
}

export const SPLIT_MAX_COLUMNS = 4;
export const SPLIT_MIN_WIDTH_PX = 280;

const LAYOUTS_STORAGE_KEY = "xacpx.splitLayouts.v1";
const SCROLL_STORAGE_KEY = "xacpx.splitScroll.v1";

export function primaryKeyFor(target: SplitPaneTarget): string {
  if (target.kind === "session") return `session::${target.instanceId}::${target.sessionAlias}`;
  return `bot::${target.instanceId}::${target.botId}`;
}

export function paneKeyFor(target: SplitPaneTarget): string {
  const base = primaryKeyFor(target);
  if (target.kind === "bot" && target.topicId) return `${base}#${target.topicId}`;
  return base;
}

function targetsEqual(a: SplitPaneTarget, b: SplitPaneTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.instanceId !== b.instanceId) return false;
  if (a.kind === "session" && b.kind === "session") return a.sessionAlias === b.sessionAlias;
  if (a.kind === "bot" && b.kind === "bot") {
    return a.botId === b.botId && (a.topicId ?? undefined) === (b.topicId ?? undefined);
  }
  return false;
}

function parsePrimary(primary: string): SplitPaneTarget | null {
  const parts = primary.split("::");
  if (parts[0] === "session" && parts.length >= 3) {
    const instanceId = parts[1]!;
    const sessionAlias = parts.slice(2).join("::");
    if (!instanceId || !sessionAlias) return null;
    return { kind: "session", instanceId, sessionAlias };
  }
  if (parts[0] === "bot" && parts.length >= 3) {
    const instanceId = parts[1]!;
    const botId = parts.slice(2).join("::");
    if (!instanceId || !botId) return null;
    return { kind: "bot", instanceId, botId };
  }
  return null;
}

let columnSeq = 0;
function mintColumnId(): string {
  columnSeq += 1;
  return `col_${Date.now().toString(36)}_${columnSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

function equalizeWidths(columns: SplitColumn[]): void {
  const n = columns.length;
  if (n === 0) return;
  const w = 1 / n;
  for (const c of columns) c.widthFraction = w;
}

function renormalizeWidths(columns: SplitColumn[]): void {
  const sum = columns.reduce((acc, c) => acc + c.widthFraction, 0);
  if (sum <= 0 || columns.length === 0) {
    equalizeWidths(columns);
    return;
  }
  for (const c of columns) c.widthFraction = c.widthFraction / sum;
}

function isValidTarget(v: unknown): v is SplitPaneTarget {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  if (t.kind === "session") {
    return typeof t.instanceId === "string" && typeof t.sessionAlias === "string";
  }
  if (t.kind === "bot") {
    return (
      typeof t.instanceId === "string" &&
      typeof t.botId === "string" &&
      (t.topicId === undefined || typeof t.topicId === "string")
    );
  }
  return false;
}

function isValidLayout(v: unknown): v is SplitLayoutState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s.columns) || typeof s.focusedColumnId !== "string" || !Array.isArray(s.dismissedSessionKeys)) {
    return false;
  }
  if (!(s.dismissedSessionKeys as unknown[]).every((k) => typeof k === "string")) return false;
  for (const c of s.columns as unknown[]) {
    if (typeof c !== "object" || c === null) return false;
    const col = c as Record<string, unknown>;
    if (typeof col.id !== "string" || typeof col.widthFraction !== "number") return false;
    if (!isValidTarget(col.target)) return false;
    if (col.source !== undefined && col.source !== "manual" && col.source !== "bot-dispatch") return false;
  }
  return true;
}

function loadPersistedLayouts(): Record<string, SplitLayoutState> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(LAYOUTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, SplitLayoutState> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidLayout(v)) out[k] = v;
      // Corrupt → reset that primary (skip it).
    }
    return out;
  } catch {
    return {};
  }
}

function persistLayouts(layouts: Record<string, SplitLayoutState>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LAYOUTS_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // Best-effort.
  }
}

type ScrollPos = { scrollTop: number; atBottom: boolean };
const scrollMemory = new Map<string, ScrollPos>();

function readPersistedScroll(): Record<string, ScrollPos> {
  try {
    if (typeof sessionStorage === "undefined") return {};
    const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, ScrollPos>;
  } catch {
    return {};
  }
}

function persistScrollMemory(): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const obj: Record<string, ScrollPos> = {};
    for (const [k, v] of scrollMemory) obj[k] = v;
    // Merge with whatever is already in sessionStorage so two tabs don't clobber.
    const existing = readPersistedScroll();
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify({ ...existing, ...obj }));
  } catch {
    // Best-effort.
  }
}

export const useSplitLayoutStore = defineStore("splitLayout", {
  state: () => ({
    layoutsByPrimary: loadPersistedLayouts() as Record<string, SplitLayoutState>,
  }),
  actions: {
    ensureLayout(primary: string): SplitLayoutState {
      let layout = this.layoutsByPrimary[primary];
      if (!layout || !isValidLayout(layout)) {
        const target = parsePrimary(primary);
        const colId = mintColumnId();
        layout = {
          columns: target
            ? [{ id: colId, target, widthFraction: 1, source: "manual" as const }]
            : [],
          focusedColumnId: target ? colId : "",
          dismissedSessionKeys: [],
        };
        this.layoutsByPrimary[primary] = layout;
        persistLayouts(this.layoutsByPrimary);
        return layout;
      }
      // Ensure column 0 exists when primary parses but layout is empty.
      if (layout.columns.length === 0) {
        const target = parsePrimary(primary);
        if (target) {
          const colId = mintColumnId();
          layout.columns = [{ id: colId, target, widthFraction: 1, source: "manual" as const }];
          layout.focusedColumnId = colId;
          persistLayouts(this.layoutsByPrimary);
        }
      }
      return layout;
    },
    layoutFor(primary: string): SplitLayoutState {
      return this.ensureLayout(primary);
    },
    addColumn(
      primary: string,
      target: SplitPaneTarget,
      source: "manual" | "bot-dispatch" = "manual",
    ): SplitColumn | null {
      const layout = this.ensureLayout(primary);
      if (layout.columns.length >= SPLIT_MAX_COLUMNS) return null;
      if (layout.columns.some((c) => targetsEqual(c.target, target))) return null;
      const col: SplitColumn = { id: mintColumnId(), target, widthFraction: 1, source };
      layout.columns.push(col);
      equalizeWidths(layout.columns);
      layout.focusedColumnId = col.id;
      persistLayouts(this.layoutsByPrimary);
      return col;
    },
    removeColumn(primary: string, columnId: string, opts?: { dismiss?: boolean }): void {
      const layout = this.layoutsByPrimary[primary];
      if (!layout) return;
      const idx = layout.columns.findIndex((c) => c.id === columnId);
      if (idx < 0) return;
      const [removed] = layout.columns.splice(idx, 1);
      if (opts?.dismiss && removed && removed.target.kind === "session") {
        const key = primaryKeyFor(removed.target);
        if (!layout.dismissedSessionKeys.includes(key)) layout.dismissedSessionKeys.push(key);
      }
      if (layout.focusedColumnId === columnId) {
        layout.focusedColumnId = layout.columns[0]?.id ?? "";
      }
      if (layout.columns.length > 0) equalizeWidths(layout.columns);
      persistLayouts(this.layoutsByPrimary);
    },
    focusColumn(primary: string, columnId: string): void {
      const layout = this.layoutsByPrimary[primary];
      if (!layout) return;
      if (!layout.columns.some((c) => c.id === columnId)) return;
      layout.focusedColumnId = columnId;
      persistLayouts(this.layoutsByPrimary);
    },
    resizeAdjacentColumns(primary: string, leftIndex: number, deltaFraction: number): void {
      const layout = this.layoutsByPrimary[primary];
      if (!layout) return;
      const left = layout.columns[leftIndex];
      const right = layout.columns[leftIndex + 1];
      if (!left || !right) return;
      const MIN = 0.05;
      const pairSum = left.widthFraction + right.widthFraction;
      let newLeft = left.widthFraction + deltaFraction;
      let newRight = right.widthFraction - deltaFraction;
      if (newLeft < MIN) {
        newLeft = MIN;
        newRight = pairSum - MIN;
      }
      if (newRight < MIN) {
        newRight = MIN;
        newLeft = pairSum - MIN;
      }
      // Guard against degenerate pair sums.
      if (newLeft < MIN || newRight < MIN) return;
      left.widthFraction = newLeft;
      right.widthFraction = newRight;
      renormalizeWidths(layout.columns);
      persistLayouts(this.layoutsByPrimary);
    },
    equalizeColumns(primary: string): void {
      const layout = this.layoutsByPrimary[primary];
      if (!layout) return;
      equalizeWidths(layout.columns);
      persistLayouts(this.layoutsByPrimary);
    },
    promoteToPrimary(primary: string, columnId: string): string {
      const layout = this.layoutsByPrimary[primary];
      if (!layout) return primary;
      const idx = layout.columns.findIndex((c) => c.id === columnId);
      if (idx < 0) return primary;
      const col = layout.columns[idx]!;
      const newPrimary = primaryKeyFor(col.target);
      if (newPrimary === primary) return primary;
      const reordered = [col, ...layout.columns.slice(0, idx), ...layout.columns.slice(idx + 1)];
      const moved: SplitLayoutState = {
        columns: reordered,
        focusedColumnId: col.id,
        dismissedSessionKeys: [...layout.dismissedSessionKeys],
      };
      renormalizeWidths(moved.columns);
      this.layoutsByPrimary[newPrimary] = moved;
      delete this.layoutsByPrimary[primary];
      persistLayouts(this.layoutsByPrimary);
      return newPrimary;
    },
    autoOpenDispatchedSession(
      primary: string,
      instanceId: string,
      sessionAlias: string,
    ): SplitColumn | null {
      const layout = this.ensureLayout(primary);
      const target: SplitPaneTarget = { kind: "session", instanceId, sessionAlias };
      const key = primaryKeyFor(target);
      if (layout.dismissedSessionKeys.includes(key)) return null;
      const existing = layout.columns.find((c) => targetsEqual(c.target, target));
      if (existing) {
        layout.focusedColumnId = existing.id;
        persistLayouts(this.layoutsByPrimary);
        return existing;
      }
      if (layout.columns.length >= SPLIT_MAX_COLUMNS) return null;
      return this.addColumn(primary, target, "bot-dispatch");
    },
    reopenDispatchedSession(
      primary: string,
      instanceId: string,
      sessionAlias: string,
    ): SplitColumn | null {
      const layout = this.ensureLayout(primary);
      const target: SplitPaneTarget = { kind: "session", instanceId, sessionAlias };
      const key = primaryKeyFor(target);
      layout.dismissedSessionKeys = layout.dismissedSessionKeys.filter((k) => k !== key);
      const existing = layout.columns.find((c) => targetsEqual(c.target, target));
      if (existing) {
        layout.focusedColumnId = existing.id;
        persistLayouts(this.layoutsByPrimary);
        return existing;
      }
      if (layout.columns.length >= SPLIT_MAX_COLUMNS) {
        persistLayouts(this.layoutsByPrimary);
        return null;
      }
      return this.addColumn(primary, target, "bot-dispatch");
    },
    saveScroll(paneKey: string, pos: { scrollTop: number; atBottom: boolean }): void {
      scrollMemory.set(paneKey, { scrollTop: pos.scrollTop, atBottom: pos.atBottom });
      persistScrollMemory();
    },
    getScroll(paneKey: string): { scrollTop: number; atBottom: boolean } | undefined {
      const mem = scrollMemory.get(paneKey);
      if (mem) return mem;
      const persisted = readPersistedScroll()[paneKey];
      if (
        persisted &&
        typeof persisted.scrollTop === "number" &&
        typeof persisted.atBottom === "boolean"
      ) {
        scrollMemory.set(paneKey, persisted);
        return persisted;
      }
      return undefined;
    },
    pruneMissingTargets(
      primary: string,
      exists: (t: SplitPaneTarget) => boolean,
      listsLoaded: boolean,
    ): void {
      if (!listsLoaded) return;
      const layout = this.layoutsByPrimary[primary];
      if (!layout) return;
      const kept = layout.columns.filter((c) => {
        try {
          return exists(c.target);
        } catch {
          return true;
        }
      });
      if (kept.length === layout.columns.length) return;
      if (kept.length === 0) return;
      layout.columns = kept;
      if (!kept.some((c) => c.id === layout.focusedColumnId)) {
        layout.focusedColumnId = kept[0]!.id;
      }
      equalizeWidths(layout.columns);
      persistLayouts(this.layoutsByPrimary);
    },
  },
});
