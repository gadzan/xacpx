import { nextTick, onBeforeUnmount, onMounted, reactive, watch } from "vue";

/**
 * Drawer-layer state for the execution-process surface: which nodes the reader
 * expanded, whether the list is following the tail, and how many events arrived
 * while they were reading above the fold.
 *
 * It lives outside `GroupTraceTimeline` on purpose. The timeline is re-rendered
 * on every streamed part, and the desktop drawer / mobile sheet branches remount
 * their own scroller; component-local state would silently reset mid-read. The
 * store is keyed by `${memberTurnId}:${attempt}` and resets when that key
 * changes, so a retry never inherits the previous attempt's expansion.
 *
 * Session-scoped like `trace-expansion.ts`: entries are small strings, one
 * drawer is open at a time, and the state dies with the page.
 */
export interface TraceDrawerStore {
  scopeKey: string;
  expanded: Set<string>;
  following: boolean;
  unread: number;
  highlight: string | null;
}

const store = reactive<TraceDrawerStore>({
  scopeKey: "",
  expanded: new Set<string>(),
  following: true,
  unread: 0,
  highlight: null,
});

const NEAR_BOTTOM_PX = 32;
const HIGHLIGHT_MS = 1200;
/** Re-check times after an append. `content-visibility` can trade estimates for
 *  real heights long after the patch (and rows above/below can swap heights
 *  without changing the list's total), so a resize observer alone is not
 *  enough under a loaded main thread. Bounded, so nothing runs forever. */
const SETTLE_CHECKS_MS = [0, 200, 600, 1_200, 2_000, 3_200, 5_000, 7_000];

let highlightTimer: ReturnType<typeof setTimeout> | undefined;

/** Test hook: module state outlives one mount, so suites start clean. */
export function resetTraceDrawerState(): void {
  store.scopeKey = "";
  store.expanded.clear();
  store.following = true;
  store.unread = 0;
  store.highlight = null;
  clearTimeout(highlightTimer);
  highlightTimer = undefined;
}

export function traceDrawerScopeKey(memberTurnId: string | undefined, attempt: number | undefined): string {
  return `${memberTurnId ?? ""}:${attempt ?? ""}`;
}

/** The first rendered full-list row the reader can see, by its bottom edge. */
export interface TraceFreezeAnchor {
  key: string;
  offset: number;
}

export interface TraceDrawerStateOptions {
  /** `${memberTurnId}:${attempt}` — a change resets expansion, follow, unread. */
  scopeKey: () => string;
  /** The one scroller that owns the full process (drawer body / sheet body). */
  scroller: () => HTMLElement | null | undefined;
  /** Root of the drawer content, used to resolve rows for reveal and freeze. */
  root: () => HTMLElement | null | undefined;
  /** Stable node identities in list order, used to detect appended events. */
  nodeIds: () => readonly string[];
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
}

function scrollToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}

export function appendedTraceNodes(previous: readonly string[], next: readonly string[]): number {
  if (previous.length === 0 || next.length === 0) return 0;
  const last = previous[previous.length - 1]!;
  const index = next.indexOf(last);
  if (index < 0) return 0;
  return next.length - index - 1;
}

export function useTraceDrawerState(options: TraceDrawerStateOptions) {
  let previousIds: readonly string[] = options.nodeIds();
  let bound: HTMLElement | null = null;
  let settleObserver: ResizeObserver | undefined;
  let settleTimers: Array<ReturnType<typeof setTimeout>> = [];
  let settling = false;
  /** ScrollTop our own correction last wrote; anything else is external. */
  let settleTop: number | null = null;
  /** ScrollTop when the correction started; a late echo of it is not a move. */
  let settleBaseTop: number | null = null;

  function enterScope(key: string): void {
    previousIds = options.nodeIds();
    if (store.scopeKey === key) return;
    store.scopeKey = key;
    store.expanded.clear();
    store.following = true;
    store.unread = 0;
    store.highlight = null;
  }
  enterScope(options.scopeKey());

  function stopSettle(): void {
    settling = false;
    settleObserver?.disconnect();
    settleObserver = undefined;
    for (const timer of settleTimers) clearTimeout(timer);
    settleTimers = [];
    settleTop = null;
    settleBaseTop = null;
  }

  function onScroll(): void {
    if (!bound) return;
    // While a correction is pending, a scroll is external (the reader, reveal,
    // scroll restore) unless it is our own write or a late echo of the position
    // the correction started from — both common under a loaded main thread.
    if (settling) {
      const top = bound.scrollTop;
      const ours = settleTop !== null && Math.abs(top - settleTop) <= 1;
      const echo = settleBaseTop !== null && Math.abs(top - settleBaseTop) <= 1;
      if (!ours && !echo) stopSettle();
    }
    store.following = nearBottom(bound);
    if (store.following) store.unread = 0;
  }

  /** A deliberate scroll cancels a pending freeze/follow correction. */
  function onUserIntent(): void {
    stopSettle();
  }

  function bind(): void {
    const el = options.scroller() ?? null;
    if (el === bound) return;
    unbind();
    bound = el;
    if (!bound) return;
    bound.addEventListener("scroll", onScroll, { passive: true });
    bound.addEventListener("wheel", onUserIntent, { passive: true });
    bound.addEventListener("touchstart", onUserIntent, { passive: true });
    bound.addEventListener("pointerdown", onUserIntent, { passive: true });
    bound.addEventListener("keydown", onUserIntent);
    // The remembered offset is restored after mount, so the first check only
    // answers "can this content even scroll yet"; later appends re-check.
    store.following = nearBottom(bound);
  }

  function unbind(): void {
    if (!bound) return;
    bound.removeEventListener("scroll", onScroll);
    bound.removeEventListener("wheel", onUserIntent);
    bound.removeEventListener("touchstart", onUserIntent);
    bound.removeEventListener("pointerdown", onUserIntent);
    bound.removeEventListener("keydown", onUserIntent);
    bound = null;
  }

  function listEl(): HTMLElement | null {
    return options.root()?.querySelector<HTMLElement>('[data-test="group-trace-timeline"]') ?? null;
  }

  /** A skipped `content-visibility: auto` row reports its intrinsic estimate. */
  function isIntrinsicEstimate(row: HTMLElement): boolean {
    if (typeof window === "undefined") return false;
    const style = window.getComputedStyle(row);
    if (style.contentVisibility !== "auto" || !style.containIntrinsicSize) return false;
    const match = /([\d.]+)px\s*$/.exec(style.containIntrinsicSize);
    if (!match) return false;
    return Math.abs(row.getBoundingClientRect().height - Number.parseFloat(match[1]!)) < 0.5;
  }

  function firstVisibleRow(scrollerEl: HTMLElement): TraceFreezeAnchor | null {
    const ownerTop = scrollerEl.getBoundingClientRect().top;
    const rows = Array.from(listEl()?.querySelectorAll<HTMLElement>("[data-trace-key]") ?? []);
    const rendered = (candidate: HTMLElement): boolean => !isIntrinsicEstimate(candidate);
    const visible = rows.filter((candidate) => candidate.getBoundingClientRect().bottom > ownerTop);
    // A rect can be a 72px intrinsic estimate for a row the browser has not
    // painted yet (a programmatic jump under load). Pin a row that is actually
    // rendered; its real height is what the rows below it are laid out from.
    const row = visible.find(rendered) ?? visible[0];
    if (!row) return null;
    const key = row.getAttribute("data-trace-key") ?? "";
    if (!key) return null;
    // Bottom edge: if the anchor row itself re-measures (estimate -> real), the
    // rows below it must not move; its own top may.
    return { key, offset: row.getBoundingClientRect().bottom - ownerTop };
  }

  /** Put the captured row back where the reader last saw it. */
  function compensate(scrollerEl: HTMLElement, anchor: TraceFreezeAnchor): void {
    const row = listEl()?.querySelector<HTMLElement>(`[data-trace-key="${anchor.key}"]`);
    if (!row) return;
    const ownerTop = scrollerEl.getBoundingClientRect().top;
    const delta = row.getBoundingClientRect().bottom - ownerTop - anchor.offset;
    if (Math.abs(delta) <= 0.5) return;
    scrollerEl.scrollTop += delta;
    settleTop = scrollerEl.scrollTop;
  }

  /**
   * `content-visibility` rows measure asynchronously: a row can trade its 72px
   * intrinsic estimate for its real height long after the append, and rows can
   * swap heights without changing the list's total. Re-check on a bounded
   * schedule (plus a resize observer for the prompt case) instead of trusting
   * one frame.
   */
  function settleFreeze(scrollerEl: HTMLElement, anchor: TraceFreezeAnchor): void {
    stopSettle();
    settling = true;
    settleBaseTop = scrollerEl.scrollTop;
    const check = (): void => {
      if (!settling) return;
      if (store.following) {
        stopSettle();
        return;
      }
      compensate(scrollerEl, anchor);
    };
    if (typeof ResizeObserver !== "undefined") {
      const list = listEl();
      if (list) {
        settleObserver = new ResizeObserver(check);
        settleObserver.observe(list);
      }
    }
    const last = SETTLE_CHECKS_MS[SETTLE_CHECKS_MS.length - 1]!;
    settleTimers = SETTLE_CHECKS_MS.map((delay) => setTimeout(() => {
      check();
      if (delay === last) stopSettle();
    }, delay));
  }

  /** While following, stay pinned to the tail across the same async re-measure. */
  function settleFollow(scrollerEl: HTMLElement): void {
    stopSettle();
    settling = true;
    settleBaseTop = scrollerEl.scrollTop;
    const check = (): void => {
      if (!settling) return;
      if (!store.following) {
        stopSettle();
        return;
      }
      scrollToBottom(scrollerEl);
      settleTop = scrollerEl.scrollTop;
    };
    if (typeof ResizeObserver === "undefined") {
      scrollToBottom(scrollerEl);
      settleTop = scrollerEl.scrollTop;
    } else {
      const list = listEl();
      if (list) {
        settleObserver = new ResizeObserver(check);
        settleObserver.observe(list);
      }
    }
    const last = SETTLE_CHECKS_MS[SETTLE_CHECKS_MS.length - 1]!;
    settleTimers = SETTLE_CHECKS_MS.map((delay) => setTimeout(() => {
      check();
      if (delay === last) stopSettle();
    }, delay));
  }

  function toggle(key: string): void {
    if (store.expanded.has(key)) store.expanded.delete(key);
    else store.expanded.add(key);
  }

  function jumpToLatest(): void {
    stopSettle();
    const el = options.scroller();
    if (el) scrollToBottom(el);
    store.following = true;
    store.unread = 0;
  }

  function reveal(targetKey: string): void {
    const row = options.root()?.querySelector<HTMLElement>(`[data-trace-key="${targetKey}"]`);
    if (!row) return;
    store.highlight = targetKey;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => {
      highlightTimer = undefined;
      if (store.highlight === targetKey) store.highlight = null;
    }, HIGHLIGHT_MS);
    stopSettle();
    if (typeof row.scrollIntoView === "function") {
      const reduceMotion = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      row.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    }
  }

  watch(options.scopeKey, (key) => { enterScope(key); });
  watch(() => options.scroller() ?? null, bind, { flush: "post" });

  // Appended events only. A prepended page (load earlier) or a replaced trace
  // must not be counted as unread, and same-key streaming updates are not
  // events at all.
  //
  // This runs BEFORE the DOM patch: "was the reader at the tail" and the
  // freeze anchor must describe the pre-append layout. A post-patch check
  // would see the grown scrollHeight and call a tail reader "away", and a
  // post-patch anchor would already contain the shift it is meant to undo.
  watch(options.nodeIds, (next) => {
    const previous = previousIds;
    previousIds = next;
    const appended = appendedTraceNodes(previous, next);
    if (appended <= 0) return;
    const el = options.scroller();
    if (!el) {
      store.unread += appended;
      return;
    }
    if (nearBottom(el)) {
      store.following = true;
      store.unread = 0;
      void nextTick(() => {
        const current = options.scroller();
        if (!current || !store.following) return;
        scrollToBottom(current);
        settleFollow(current);
      });
      return;
    }
    const anchor = firstVisibleRow(el);
    store.following = false;
    store.unread += appended;
    if (!anchor) return;
    void nextTick(() => {
      if (store.following) return;
      const current = options.scroller();
      if (!current) return;
      compensate(current, anchor);
      settleFreeze(current, anchor);
    });
  });

  onMounted(bind);
  onBeforeUnmount(() => {
    stopSettle();
    unbind();
  });

  return { state: store, toggle, reveal, jumpToLatest };
}
