import { setActivePinia, createPinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SPLIT_MAX_COLUMNS,
  paneKeyFor,
  primaryKeyFor,
  useSplitLayoutStore,
  type SplitPaneTarget,
} from "../stores/split-layout";

const sessionTarget = (alias: string): SplitPaneTarget => ({
  kind: "session",
  instanceId: "i1",
  sessionAlias: alias,
});
const botTarget = (botId: string, topicId?: string): SplitPaneTarget => ({
  kind: "bot",
  instanceId: "i1",
  botId,
  ...(topicId ? { topicId } : {}),
});

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
});

describe("split-layout store", () => {
  it("creates a single-column primary layout and keys helpers format correctly", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("backend"));
    expect(primary).toBe("session::i1::backend");
    expect(primaryKeyFor(botTarget("b1"))).toBe("bot::i1::b1");
    expect(paneKeyFor(botTarget("b1", "t1"))).toBe("bot::i1::b1#t1");
    expect(paneKeyFor(sessionTarget("backend"))).toBe("session::i1::backend");
    expect(SPLIT_MAX_COLUMNS).toBe(4);

    const layout = store.ensureLayout(primary);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.target).toEqual(sessionTarget("backend"));
    expect(layout.focusedColumnId).toBe(layout.columns[0]!.id);
    expect(layout.columns[0]!.widthFraction).toBeCloseTo(1);
  });

  it("addColumn appends right, renormalizes to sum 1, rejects duplicates and caps at 4", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a"));
    store.ensureLayout(primary);
    const b = store.addColumn(primary, sessionTarget("b"));
    expect(b).not.toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(2);
    const sum2 = store.layoutFor(primary).columns.reduce((s, c) => s + c.widthFraction, 0);
    expect(sum2).toBeCloseTo(1);
    expect(store.layoutFor(primary).focusedColumnId).toBe(b!.id);

    // Exact duplicate rejected.
    expect(store.addColumn(primary, sessionTarget("b"))).toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(2);

    expect(store.addColumn(primary, sessionTarget("c"))).not.toBeNull();
    expect(store.addColumn(primary, sessionTarget("d"))).not.toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(4);
    // 5th hits the cap.
    expect(store.addColumn(primary, sessionTarget("e"))).toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(4);
  });

  it("removeColumn drops the column, refocuses to column 0 and equalizes widths", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a"));
    store.ensureLayout(primary);
    const b = store.addColumn(primary, sessionTarget("b"))!;
    store.resizeAdjacentColumns(primary, 0, 0.2);
    const before = store.layoutFor(primary).columns.map((c) => c.widthFraction);
    expect(before[0]).toBeCloseTo(0.7);
    // Remove the focused (newest) column; focus falls back to column 0.
    store.removeColumn(primary, b.id);
    const layout = store.layoutFor(primary);
    expect(layout.columns).toHaveLength(1);
    expect(layout.focusedColumnId).toBe(layout.columns[0]!.id);
    expect(layout.columns[0]!.widthFraction).toBeCloseTo(1);
  });

  it("resizeAdjacentColumns shifts the pair, clamps >=0.05 and keeps sum 1", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("b"));
    store.resizeAdjacentColumns(primary, 0, 0.2);
    let cols = store.layoutFor(primary).columns;
    expect(cols[0]!.widthFraction).toBeCloseTo(0.7);
    expect(cols[1]!.widthFraction).toBeCloseTo(0.3);

    // Clamp: huge negative delta pins left at 0.05.
    store.resizeAdjacentColumns(primary, 0, -10);
    cols = store.layoutFor(primary).columns;
    expect(cols[0]!.widthFraction).toBeCloseTo(0.05);
    expect(cols[1]!.widthFraction).toBeCloseTo(0.95);
    const sum = cols.reduce((s, c) => s + c.widthFraction, 0);
    expect(sum).toBeCloseTo(1);

    store.equalizeColumns(primary);
    cols = store.layoutFor(primary).columns;
    expect(cols[0]!.widthFraction).toBeCloseTo(0.5);
    expect(cols[1]!.widthFraction).toBeCloseTo(0.5);
  });

  it("autoOpen respects dismissed keys and reopen un-dismisses", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("primary"));
    store.ensureLayout(primary);

    const opened = store.autoOpenDispatchedSession(primary, "i1", "dispatched");
    expect(opened).not.toBeNull();
    expect(opened!.source).toBe("bot-dispatch");
    expect(store.layoutFor(primary).columns).toHaveLength(2);

    // Already open → focus existing.
    const again = store.autoOpenDispatchedSession(primary, "i1", "dispatched");
    expect(again?.id).toBe(opened!.id);
    expect(store.layoutFor(primary).focusedColumnId).toBe(opened!.id);

    // Dismiss records the session key and blocks auto-open.
    store.removeColumn(primary, opened!.id, { dismiss: true });
    expect(store.layoutFor(primary).dismissedSessionKeys).toContain("session::i1::dispatched");
    expect(store.autoOpenDispatchedSession(primary, "i1", "dispatched")).toBeNull();
    expect(store.layoutFor(primary).columns).toHaveLength(1);

    // Manual reopen un-dismisses and opens.
    const reopened = store.reopenDispatchedSession(primary, "i1", "dispatched");
    expect(reopened).not.toBeNull();
    expect(store.layoutFor(primary).dismissedSessionKeys).not.toContain("session::i1::dispatched");
    expect(store.layoutFor(primary).columns).toHaveLength(2);
  });

  it("persists layouts to localStorage and resets corrupt primaries", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("b"));
    const raw = localStorage.getItem("xacpx.splitLayouts.v1");
    expect(raw).toContain("session::i1::a");

    // New store instance rehydrates the persisted layout.
    setActivePinia(createPinia());
    const rehydrated = useSplitLayoutStore();
    expect(rehydrated.layoutFor(primary).columns).toHaveLength(2);

    // Corrupt entry for another primary resets to a fresh single-column layout.
    const badPrimary = primaryKeyFor(sessionTarget("bad"));
    const blob = JSON.parse(localStorage.getItem("xacpx.splitLayouts.v1")!);
    blob[badPrimary] = { columns: "nope" };
    localStorage.setItem("xacpx.splitLayouts.v1", JSON.stringify(blob));
    setActivePinia(createPinia());
    const fresh = useSplitLayoutStore();
    const layout = fresh.ensureLayout(badPrimary);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.target).toEqual(sessionTarget("bad"));
  });

  it("saveScroll/getScroll round-trips via sessionStorage", () => {
    const store = useSplitLayoutStore();
    const paneKey = paneKeyFor(sessionTarget("a"));
    expect(store.getScroll(paneKey)).toBeUndefined();
    store.saveScroll(paneKey, { scrollTop: 123, atBottom: false });
    expect(store.getScroll(paneKey)).toEqual({ scrollTop: 123, atBottom: false });
    const raw = sessionStorage.getItem("xacpx.splitScroll.v1");
    expect(raw).toContain(paneKey);

    // A new store instance still reads the persisted scroll (best-effort).
    setActivePinia(createPinia());
    const rehydrated = useSplitLayoutStore();
    expect(rehydrated.getScroll(paneKey)).toEqual({ scrollTop: 123, atBottom: false });
  });

  it("pruneMissingTargets only prunes when lists are loaded", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a"));
    store.ensureLayout(primary);
    store.addColumn(primary, sessionTarget("gone"));
    expect(store.layoutFor(primary).columns).toHaveLength(2);

    store.pruneMissingTargets(primary, (t) => t.kind === "session" && t.sessionAlias !== "gone", false);
    expect(store.layoutFor(primary).columns).toHaveLength(2);

    store.pruneMissingTargets(primary, (t) => t.kind === "session" && t.sessionAlias !== "gone", true);
    const layout = store.layoutFor(primary);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.target).toEqual(sessionTarget("a"));
  });

  it("promoteToPrimary rebuilds the key and moves the layout entry", () => {
    const store = useSplitLayoutStore();
    const primary = primaryKeyFor(sessionTarget("a"));
    store.ensureLayout(primary);
    const b = store.addColumn(primary, sessionTarget("b"))!;
    const next = store.promoteToPrimary(primary, b.id);
    expect(next).toBe("session::i1::b");
    // Old entry moved; new entry leads with the promoted column.
    expect(store.layoutsByPrimary[primary]).toBeUndefined();
    const moved = store.layoutFor(next);
    expect(moved.columns[0]!.id).toBe(b.id);
    expect(moved.focusedColumnId).toBe(b.id);
  });
});
