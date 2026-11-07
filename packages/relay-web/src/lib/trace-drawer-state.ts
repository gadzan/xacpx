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

export interface TraceDrawerStateOptions {
  /** `${memberTurnId}:${attempt}` — a change resets expansion, follow, unread. */
  scopeKey: () => string;
  /** The one scroller that owns the full process (drawer body / sheet body). */
  scroller: () => HTMLElement | null | undefined;
  /** Root of the drawer content, used to resolve a node row for reveal. */
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

  function onScroll(): void {
    if (!bound) return;
    store.following = nearBottom(bound);
    if (store.following) store.unread = 0;
  }

  function bind(): void {
    const el = options.scroller() ?? null;
    if (el === bound) return;
    bound?.removeEventListener("scroll", onScroll);
    bound = el;
    if (!bound) return;
    bound.addEventListener("scroll", onScroll, { passive: true });
    // The remembered offset is restored after mount, so the first check only
    // answers "can this content even scroll yet"; later appends re-check.
    store.following = nearBottom(bound);
  }

  function toggle(key: string): void {
    if (store.expanded.has(key)) store.expanded.delete(key);
    else store.expanded.add(key);
  }

  function jumpToLatest(): void {
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
      // A post-flush watcher runs after Vue patched the rows, so the new tail
      // is already measured when this lands.
      scrollToBottom(el);
      void nextTick(() => { if (store.following) scrollToBottom(el); });
      return;
    }
    store.following = false;
    store.unread += appended;
  }, { flush: "post" });

  onMounted(bind);
  onBeforeUnmount(() => {
    bound?.removeEventListener("scroll", onScroll);
    bound = null;
  });

  return { state: store, toggle, reveal, jumpToLatest };
}
