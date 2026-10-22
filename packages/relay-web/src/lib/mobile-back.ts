import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useRouter, type Router } from "vue-router";

/**
 * Mobile back navigation. The browser history stack IS the layer stack: the top bar's
 * ←, the iOS Safari left-edge swipe and the Android back key all pop one entry, and
 * the resulting popstate closes exactly one layer. Closing a layer from the UI (X,
 * mask, Escape, picking a sheet item) pops the same entry instead of mutating state
 * directly, so there is one close path and no double handling.
 *
 * Only below lg. On desktop a pane switch is not navigation and dialogs are closed
 * with Escape, so no entry is ever created there.
 *
 * Every entry we write keeps vue-router's own state fields (`back` / `current` /
 * `forward` / `position`) and adds `xacpx = { layer, id, depth }`. `depth` is the
 * 1-based position among our own entries: the pane entry is 1, so a pane entry at
 * depth >= 1 means our home entry sits below it.
 */

export type BackLayerKind = "pane" | "full" | "modal";

export interface BackLayer {
  kind: BackLayerKind;
  /** Recorded on the entry as `history.state.xacpx.id`. */
  id: string;
  /** Close the layer. Idempotent: the popstate handler calls it after the UI may
   *  already have closed itself. */
  close: () => void;
  /** Rendered only below lg. Crossing to ≥lg closes the layer instead of leaving it
   *  mounted and invisible, still holding the Escape stack and the focus trap. */
  mobileOnly?: boolean;
}

/** The state-derived layers, provided by the dashboard (the only surface that has
 *  a pane and full-screen layers). */
export interface BackSources {
  /** The conversation pane (session / bot / group), or null on the home list. */
  pane: () => BackLayer | null;
  /** Full-screen layers, bottom-up. */
  full: () => BackLayer[];
}

interface BackTag {
  layer: BackLayerKind;
  id: string;
  depth: number;
}

/** The Tailwind `lg` boundary as JS (matches useIsMobile in use-dropdown). */
const DESKTOP_QUERY = "(min-width: 1024px)";
/** A cancelled iOS swipe never produces a popstate: release the in-flight flag so a
 *  later ← is not dead. */
const BACK_SETTLE_MS = 1500;

/** Every open modal in mount order. Shared with useModalA11y: the Escape stack and
 *  the modal half of this stack are the same stack, both "top-most layer acts". */
export const modalLayers = shallowRef<BackLayer[]>([]);

/** True while a programmatic back waits for its popstate. ← is disabled so a double
 *  tap cannot skip two layers and leave the site. */
export const backInFlight = ref(false);

let sources: BackSources | null = null;
/** The layers that own the entries we wrote, bottom-up. */
let entryStack: BackLayer[] = [];
let desktop = false;
let desktopMql: MediaQueryList | null = null;
/** Set once a history write was provably ignored (Chrome's history-manipulation
 *  intervention): stop adding entries and close layers in place instead. */
let degraded = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let syncQueued = false;
let router: Router | undefined;
let writing = false;

function readTag(): BackTag | null {
  const tag = (window.history.state as { xacpx?: BackTag } | null)?.xacpx;
  return tag && typeof tag.layer === "string" && typeof tag.depth === "number" ? tag : null;
}

function historyDepth(): number {
  return readTag()?.depth ?? 0;
}

/** Write our tag with the router (vue-router merges its own state fields). The result
 *  reads back the entry, so a browser that ignored the write fails the check. */
async function writeEntry(replace: boolean, tag: BackTag | null): Promise<boolean> {
  if (!router) return false;
  await router[replace ? "replace" : "push"]({ path: "/", force: true, state: { xacpx: tag ? { ...tag } : null } });
  const after = readTag();
  if (tag) return !!after && after.layer === tag.layer && after.depth === tag.depth;
  return after === null;
}

function liveLayers(): BackLayer[] {
  const out: BackLayer[] = [];
  if (!sources) {
    out.push(...modalLayers.value);
    return out;
  }
  const pane = sources.pane();
  if (pane) out.push(pane);
  out.push(...sources.full(), ...modalLayers.value);
  return out;
}

/** Mark a programmatic traversal as in flight. A cancelled iOS swipe never produces a
 *  popstate, so a timer releases the flag and ← stays usable. */
function beginTraversal(): void {
  backInFlight.value = true;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    backInFlight.value = false;
  }, BACK_SETTLE_MS);
}

function back(): void {
  if (backInFlight.value) return;
  beginTraversal();
  window.history.back();
}

function onPopState(): void {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  backInFlight.value = false;
  const depth = historyDepth();
  // Close the layers whose entries we just popped, top first. Their close() may
  // already have run (the UI closed first), which is why it must be idempotent.
  while (entryStack.length > depth) entryStack.pop()!.close();
  scheduleSync();
}

/** Reconcile history with the live layer stack. Runs after the flush so mount and
 *  unmount hooks have settled and the modal stack is current. */
async function sync(): Promise<void> {
  if (!sources || writing) return;
  const desired = desktop ? [] : liveLayers();
  const depth = historyDepth();
  const top = desired[desired.length - 1];
  const tag = readTag();
  // Desktop owns no entries. Stale ones (a reload after the viewport grew, say) are
  // reclaimed in a single traversal that closes nothing.
  if (desktop && depth > 0) {
    reclaimEntries();
    return;
  }
  if (
    desired.length === depth
    && entryStack.length === desired.length
    && (!top || (!!tag && tag.layer === top.kind && tag.id === top.id))
  ) {
    return;
  }
  if (desired.length < depth) {
    // A layer closed on its own: pop its entry. The popstate pops the entry stack
    // and closes whatever still sits above the entry we land on.
    back();
    return;
  }
  if (desired.length > depth) {
    if (degraded) {
      entryStack = desired.slice(0, depth);
      return;
    }
    writing = true;
    try {
      for (let i = depth; i < desired.length; i++) {
        const layer = desired[i]!;
        if (!await writeEntry(false, { layer: layer.kind, id: layer.id, depth: i + 1 })) {
          failWrites();
          return;
        }
        entryStack = desired.slice(0, i + 1);
      }
    } finally {
      writing = false;
      scheduleSync();
    }
    return;
  }
  // Same depth, different top: reuse the entry (switching target, sheet → dialog).
  if (top && tag && (tag.layer !== top.kind || tag.id !== top.id)) {
    if (degraded) {
      entryStack = desired;
      return;
    }
    writing = true;
    try {
      if (await writeEntry(true, { layer: top.kind, id: top.id, depth: desired.length })) entryStack = desired;
      else failWrites();
    } finally {
      writing = false;
      scheduleSync();
    }
    return;
  }
  entryStack = desired;
}

function failWrites(): void {
  degraded = true;
  entryStack = [];
}

/** Drop all stack state. Called when the dashboard unmounts (route change) so the next
 *  mount starts from a clean stack. */
function resetStack(): void {
  entryStack = [];
  degraded = false;
  backInFlight.value = false;
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

function scheduleSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  void nextTick(() => {
    syncQueued = false;
    sync();
  });
}

/** Pop our whole entry stack in one traversal, closing nothing. Used when the object
 *  being viewed disappears and the caller has already reset the layers. */
function reclaimEntries(): void {
  const n = historyDepth();
  entryStack = [];
  if (n <= 0) return;
  beginTraversal();
  window.history.go(-n);
}

function onBreakpoint(): void {
  const next = desktopMql?.matches ?? false;
  if (next === desktop) return;
  desktop = next;
  if (!next) {
    scheduleSync();
    return;
  }
  for (const layer of liveLayers()) if (layer.mobileOnly) layer.close();
  reclaimEntries();
}

/** Cold start straight into a pane (notification deep link, new tab, PWA restore):
 *  claim the current entry as our home entry so the pane entry pushed on top of it
 *  makes ← and the Android back key return home instead of leaving the site. */
export async function adoptHomeEntry(stripQuery: boolean): Promise<void> {
  if (readTag() || !router || !stripQuery) return;
  await router.replace({ path: "/", force: true, state: { xacpx: null } });
}

/** Register a modal layer. Returns the remover; pair it with the overlay's lifetime. */
export function pushModal(layer: Omit<BackLayer, "kind">): () => void {
  const entry: BackLayer = { kind: "modal", ...layer };
  modalLayers.value = [...modalLayers.value, entry];
  scheduleSync();
  return () => {
    modalLayers.value = modalLayers.value.filter((l) => l !== entry);
    scheduleSync();
  };
}

/**
 * The one back entry point: the top bar's ← and every overlay's close affordance.
 * Pops the top layer's history entry and lets the popstate perform the close. With
 * no entry of ours to pop (a cold start whose entries the browser skipped), the top
 * layer is closed in place — never leave the site.
 */
export function navigateBack(): void {
  if (backInFlight.value) return;
  if (entryStack.length > 0) {
    back();
    return;
  }
  const live = liveLayers();
  const top = live[live.length - 1];
  top?.close();
  if (top?.kind === "pane") void router?.replace({ path: "/", force: true, state: { xacpx: null } });
}

/** Collapse our entries and go home without leaving a dead entry behind. Used when
 *  the viewed session/bot/group is deleted elsewhere. */
export function goHomeReclaiming(): void {
  for (const layer of liveLayers()) layer.close();
  reclaimEntries();
}

export function useMobileBack(next: BackSources): void {
  router = useRouter();
  sources = next;
  let stops: Array<() => void> = [];
  onMounted(() => {
    window.addEventListener("popstate", onPopState);
    desktopMql = typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : null;
    desktop = desktopMql?.matches ?? false;
    desktopMql?.addEventListener("change", onBreakpoint);
    stops = [
      watch(next.pane, scheduleSync, { flush: "post" }),
      watch(next.full, scheduleSync, { flush: "post" }),
      watch(modalLayers, scheduleSync, { flush: "post" }),
    ];
    scheduleSync();
  });
  onBeforeUnmount(() => {
    window.removeEventListener("popstate", onPopState);
    desktopMql?.removeEventListener("change", onBreakpoint);
    for (const stop of stops) stop();
    sources = null;
    stops = [];
    resetStack();
  });
}
