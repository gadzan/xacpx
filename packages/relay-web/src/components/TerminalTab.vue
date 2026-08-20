<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { Keyboard, ClipboardPaste, Copy, ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { createTerminalAdapter, type TerminalAdapter, type TerminalTheme } from "../lib/terminal-adapter";
import {
  createTerminalViewportController,
  type TerminalViewportController,
} from "../lib/terminal-viewport";
import { bindTerminalKeyboardInset } from "../lib/terminal-viewport-insets";
import { bindTerminalTouchScroll } from "../lib/terminal-touch";
import { useTerminalStore, terminalLocalKey, isFatalTerminalRecoveryCode, type TerminalAttachmentView } from "../stores/terminal";
import { useThemeStore } from "../stores/theme";
import { useConnectionStore } from "../stores/connection";
import { useInstancesStore } from "../stores/instances";
import { TerminalRequestError, isRetryableTerminalError } from "../api/events";

const props = defineProps<{ instanceId: string; sessionAlias: string }>();
// Close is owned by the center tab strip → Dashboard requestCloseTerminal (global terminate).
defineEmits<{ close: [] }>();

const terminals = useTerminalStore();
const theme = useThemeStore();
const conn = useConnectionStore();
const instances = useInstancesStore();
const localKey = computed(() => terminalLocalKey(props.instanceId, props.sessionAlias));
const host = ref<HTMLDivElement | null>(null);
const status = ref<"idle" | "connecting" | "open" | "exited" | "error">("idle");
const errorKey = ref<string>("");
const role = ref<"controller" | "spectator" | "">("");
const viewerCount = ref(0);
const takingControl = ref(false);
const attached = ref(false);

const ctrlArmed = ref(false);
const altArmed = ref(false);
const shiftArmed = ref(false);

function tokenHex(varName: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  return "#" + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}
function currentTheme(): TerminalTheme {
  return { background: tokenHex("--c-bg", "#0e1116"), foreground: tokenHex("--c-fg", "#e8ecf1") };
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(min-width: 1024px)").matches;
}
const keybarVisible = ref((() => {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem("xacpx.terminalKeybar") : null;
  if (saved === "1") return true;
  if (saved === "0") return false;
  return !isDesktop();
})());
function toggleKeybar() {
  keybarVisible.value = !keybarVisible.value;
  try { localStorage.setItem("xacpx.terminalKeybar", keybarVisible.value ? "1" : "0"); } catch { /* ignore */ }
}

let adapter: TerminalAdapter | null = null;
let viewport: TerminalViewportController | null = null;
let offRebase: (() => void) | null = null;
let offBytes: (() => void) | null = null;
let offMeta: (() => void) | null = null;
let offExit: (() => void) | null = null;
let epoch = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let autoRetried = false;

const ESC = String.fromCharCode(0x1b);
const KEYS = {
  home: String.fromCharCode(1),
  end: String.fromCharCode(5),
  insert: ESC + "[2~",
  enter: "\r",
};
function anyModArmed(): boolean {
  return ctrlArmed.value || altArmed.value || shiftArmed.value;
}
function disarmMods() {
  ctrlArmed.value = false; altArmed.value = false; shiftArmed.value = false;
}
function modParam(): number {
  return 1 + (shiftArmed.value ? 1 : 0) + (altArmed.value ? 2 : 0) + (ctrlArmed.value ? 4 : 0);
}

function isController(): boolean {
  return role.value === "controller";
}

const canType = computed(
  () => status.value === "open" && attached.value && role.value === "controller",
);
const canTakeControl = computed(() => status.value === "open" && role.value === "spectator");
const otherViewerCount = computed(() =>
  attached.value && role.value ? Math.max(0, viewerCount.value - 1) : 0,
);

function handleData(d: string) {
  if (!canType.value) return;
  let out = d;
  if (d.length === 1 && anyModArmed()) {
    if (shiftArmed.value) out = out.toUpperCase();
    if (ctrlArmed.value) {
      const lc = out.toLowerCase().charCodeAt(0);
      if (lc >= 97 && lc <= 122) out = String.fromCharCode(lc - 96);
    }
    if (altArmed.value) out = ESC + out;
    disarmMods();
  } else if (anyModArmed()) {
    disarmMods();
  }
  terminals.sendInput(localKey.value, out);
}

/** xterm onBinary: legacy mouse reports whose bytes cannot go through UTF-8.
 *  Adapter already converted charCodes to raw bytes - forward as-is. */
function handleBinary(bytes: Uint8Array) {
  if (!canType.value) return;
  terminals.sendInputBytes(localKey.value, bytes);
}

function applyMods(seq: string): string {
  const mod = modParam();
  if (mod === 1) return seq;
  if (seq === "\t") return shiftArmed.value ? ESC + "[Z" : seq;
  const letter = new RegExp("^" + ESC + "\\[([A-Z])$").exec(seq);
  if (letter) return ESC + "[1;" + mod + letter[1];
  const tilde = new RegExp("^" + ESC + "\\[(\\d+)~$").exec(seq);
  if (tilde) return ESC + "[" + tilde[1] + ";" + mod + "~";
  return seq;
}

function sendKey(seq: string, opts?: { refocus?: boolean }) {
  if (!canType.value) return;
  const out = applyMods(seq);
  if (anyModArmed()) disarmMods();
  terminals.sendInput(localKey.value, out);
  // Toolbar keys must not pop the soft keyboard on touch devices - only
  // keyboard-requiring actions (Paste, Enter) and the terminal surface tap
  // re-focus the IME anchor there. Desktop always keeps focus after the keybar.
  if (opts?.refocus || !isCoarsePointer()) adapter?.focus();
}

async function pasteClipboard() {
  if (!canType.value) return;
  try {
    const text = await navigator.clipboard?.readText();
    // Clipboard failures are browser-policy dependent: ignore this action
    // only - never detach the terminal or trip recovery.
    if (text) sendKey(text, { refocus: true });
  } catch { /* clipboard blocked/unavailable — ignore */ }
}

async function copySelection() {
  // Prefer a native long-press selection (mobile) over the renderer's own.
  const sel = window.getSelection()?.toString() || adapter?.getSelection() || "";
  if (!sel) return;
  try { await navigator.clipboard?.writeText(sel); } catch { /* clipboard blocked — ignore */ }
  if (!isCoarsePointer()) adapter?.focus();
}

function pageLines(): number {
  return Math.max(1, (adapter?.rows() ?? 24) - 1);
}
function pageUp() { adapter?.scrollLines(-pageLines()); }
function pageDown() { adapter?.scrollLines(pageLines()); }

function isCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
}
// Soft-keyboard occlusion px (mobile). Local-only: it lifts the visible
// surface via paddingBottom AND is added back to the fit height through the
// viewport controller, so the remote grid never churns as the keyboard
// opens/closes. Fed by bindTerminalKeyboardInset (debounced measurement).
const keyboardInset = ref(0);

async function nextLayoutFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * terminal-open creates (or resumes) the backend PTY at the supplied geometry.
 * Do not send the adapter's 80x24 construction bootstrap: xterm.js loads its
 * CSS/font asynchronously, so first wait until it is open, then derive the
 * actual host-fit grid. A few layout-frame retries cover the rare case where
 * the xterm screen is mounted but has not received measurable layout yet.
 */
async function fitBeforeTerminalOpen(
  currentAdapter: TerminalAdapter,
  myEpoch: number,
): Promise<{ cols: number; rows: number }> {
  await currentAdapter.ready();
  for (let attempt = 0; attempt < 8; attempt++) {
    if (myEpoch !== epoch || adapter !== currentAdapter) {
      throw new Error("terminal adapter superseded");
    }
    const dim = currentAdapter.fit(keyboardInset.value);
    if (dim) {
      if (dim.cols !== currentAdapter.cols() || dim.rows !== currentAdapter.rows()) {
        currentAdapter.resize(dim.cols, dim.rows);
      }
      return dim;
    }
    await nextLayoutFrame();
  }
  // Extremely defensive fallback for a renderer that remains unmeasurable.
  // Normal browser opens never take this path; the settling viewport controller
  // still converges locally afterward.
  return { cols: currentAdapter.cols(), rows: currentAdapter.rows() };
}

function mapErrorCode(code: string): string {
  switch (code) {
    case "terminal-disabled": return "terminal.disabled";
    case "terminal-rmux-unavailable": return "terminal.unsupported";
    case "terminal-unsupported-platform": return "terminal.unsupported";
    case "instance-offline": return "terminal.offline";
    case "events-offline": return "terminal.eventsOffline";
    case "instance-reconnected": return "terminal.reconnecting";
    case "terminal-session-not-found": return "terminal.sessionNotFound";
    case "terminal-session-archived": return "terminal.sessionArchived";
    case "terminal-capacity-exceeded": return "terminal.capacityExceeded";
    case "terminal-viewer-capacity-exceeded": return "terminal.viewerCapacityExceeded";
    default: return "terminal.error";
  }
}

function applyMeta(view: TerminalAttachmentView): void {
  if (view.localKey !== localKey.value) return;
  role.value = view.role ?? "";
  viewerCount.value = view.viewerCount ?? 0;
  if (view.lastErrorCode && isFatalTerminalRecoveryCode(view.lastErrorCode)) {
    status.value = "error";
    errorKey.value = mapErrorCode(view.lastErrorCode);
    return;
  }
  if (!takingControl.value && view.role === "spectator" && (view.viewerCount ?? 0) <= 1) {
    void takeControl();
  }
}

function releaseFrontend(detachBackend: boolean): void {
  epoch++;
  offRebase?.(); offRebase = null;
  offBytes?.(); offBytes = null;
  offMeta?.(); offMeta = null;
  offExit?.(); offExit = null;
  viewport?.dispose(); viewport = null;
  adapter?.dispose(); adapter = null;
  if (detachBackend && attached.value) {
    terminals.detach(localKey.value);
  }
  attached.value = false;
  disarmMods();
}

async function openAttachment(): Promise<void> {
  releaseFrontend(true);
  const myEpoch = epoch;
  if (!props.sessionAlias || !host.value) { status.value = "idle"; return; }
  status.value = "connecting";
  errorKey.value = "";

  const currentAdapter = createTerminalAdapter(host.value, {
    cols: 80,
    rows: 24,
    onData: handleData,
    onBinary: handleBinary,
    theme: currentTheme(),
  });

  adapter = currentAdapter;

  offRebase = terminals.onRebase(async (key, keyframe, cols, rows) => {
    if (key !== localKey.value || myEpoch !== epoch) return;
    await currentAdapter.resetAndReplay(keyframe, cols, rows);
    // Rebase resizes to the recovery geometry; the host size did not change,
    // so ResizeObserver never re-fires — re-fit or the canvas stays shrunk.
    if (myEpoch !== epoch || adapter !== currentAdapter) return;
    viewport?.forceSync("rebase");
  });
  offBytes = terminals.onBytes(async (key, data) => {
    if (key !== localKey.value || myEpoch !== epoch) return;
    await currentAdapter.write(data);
    // Live output moves the cursor without a geometry change; keep the prompt
    // visible under the open keyboard (no fit / no remote push).
    viewport?.revealCursor();
  });
  offMeta = terminals.onMeta((key, view) => {
    if (key !== localKey.value || myEpoch !== epoch) return;
    applyMeta(view);
  });
  offExit = terminals.onAttachmentExit((key, reason, code) => {
    if (key !== localKey.value || myEpoch !== epoch) return;
    attached.value = false;
    status.value = "exited";
    errorKey.value = reason === "cleanup-pending" ? "cleanup-pending" : String(code ?? reason);
  });

  try {
    const { cols, rows } = await fitBeforeTerminalOpen(currentAdapter, myEpoch);
    const view = await terminals.openOrResume(localKey.value, {
      instanceId: props.instanceId,
      sessionAlias: props.sessionAlias,
      cols,
      rows,
    });
    if (myEpoch !== epoch) {
      if (adapter === currentAdapter) currentAdapter.dispose();
      terminals.detach(localKey.value);
      return;
    }
    attached.value = true;
    autoRetried = false;
    status.value = "open";
    applyMeta(view);
    viewport = createTerminalViewportController({
      host: host.value!,
      adapter: currentAdapter,
      canResizeRemote: () => canType.value,
      sendRemoteResize: (cols, rows) => terminals.sendResize(localKey.value, cols, rows),
      onLocalFit: (dim) => {
        const el = host.value;
        if (!el) return;
        el.dataset.cols = String(dim.cols);
        el.dataset.rows = String(dim.rows);
      },
    });
    // Set the inset BEFORE start(): start() force-syncs immediately, and it
    // must carry the keyboard height on the very first fit. Ordering this the
    // other way (start, then setKeyboardInset) fits the shrunken host once —
    // e.g. 40→25 rows — then re-fits back to 40, a spurious remote reflow on
    // every re-attach while the keyboard is open.
    if (keyboardInset.value > 0) viewport.setKeyboardInset(keyboardInset.value);
    viewport.start();
    currentAdapter.focus();
  } catch (e) {
    if (myEpoch !== epoch) return;
    attached.value = false;
    status.value = "error";
    const code = e instanceof TerminalRequestError ? e.code
      : e instanceof Error ? e.message
      : "";
    errorKey.value = mapErrorCode(code);
    if (adapter === currentAdapter) {
      currentAdapter.dispose();
      adapter = null;
    }
    if (isRetryableTerminalError(code) && !autoRetried) {
      autoRetried = true;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (status.value === "error") void openAttachment();
      }, 1500);
    }
  }
}

async function takeControl(): Promise<void> {
  if (status.value !== "open" || takingControl.value || isController()) return;
  takingControl.value = true;
  try {
    const view = await terminals.takeControl(localKey.value);
    applyMeta(view);
    // New authority: force a sync so the store's syncedResize belief resets
    // and the backend converges on this browser's geometry.
    viewport?.forceSync("take-control");
  } catch {
    /* server remains the authority; role-changed will update if another path succeeds */
  } finally {
    takingControl.value = false;
  }
}

function onHostMouseDown() {
  if (canTakeControl.value) {
    void takeControl();
    return;
  }
  if (isController()) adapter?.focus();
}

let offTouchScroll: (() => void) | null = null;
let offKeyboardInset: (() => void) | null = null;
function attachInputLifecycles() {
  const el = host.value;
  if (!el) return;
  offTouchScroll = bindTerminalTouchScroll({
    host: el,
    // Real rendered cell height — the keyboard shrinks the host without
    // shrinking rows, so host.clientHeight/rows under-reports the cell height.
    lineHeight: () => adapter?.localGeometry()?.cellHeight ?? null,
    scrollLines: (n) => adapter?.scrollLines(n),
  });
  offKeyboardInset = bindTerminalKeyboardInset({
    host: el,
    isMobile: isCoarsePointer,
    isConnected: () => status.value === "open" && attached.value,
    onKeyboardInset: (px) => {
      keyboardInset.value = px;
      viewport?.setKeyboardInset(px);
    },
  });
}
function detachInputLifecycles() {
  offTouchScroll?.(); offTouchScroll = null;
  offKeyboardInset?.(); offKeyboardInset = null;
}

function onPageHide() {
  // Refresh / tab discard: detach only — durable resource stays for re-open.
  if (attached.value) terminals.detach(localKey.value);
}

onMounted(() => {
  void openAttachment();
  attachInputLifecycles();
  window.addEventListener("pagehide", onPageHide);
});
watch(() => [props.instanceId, props.sessionAlias], () => { void openAttachment(); });
watch(() => theme.mode, () => adapter?.setTheme(currentTheme()));
watch(() => conn.online, (online) => {
  if (online && status.value === "error") {
    autoRetried = false;
    void openAttachment();
  }
});
watch(() => instances.byId(props.instanceId)?.online, (online) => {
  if (online && status.value === "error") {
    autoRetried = false;
    void openAttachment();
  }
});
onBeforeUnmount(() => {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  detachInputLifecycles();
  window.removeEventListener("pagehide", onPageHide);
  releaseFrontend(true);
});
</script>

<template>
  <div class="flex h-full flex-col bg-bg" data-test="terminal-center"
       :style="keyboardInset ? { paddingBottom: `${keyboardInset}px` } : undefined">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <span class="min-w-0 truncate font-mono text-[12.5px] text-fg">{{ props.sessionAlias }}</span>
      <span v-if="role" data-test="terminal-role"
            class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
        {{ role === "controller" ? $t("terminal.role.controller") : $t("terminal.role.spectator") }}
      </span>
      <span v-if="otherViewerCount > 0" data-test="terminal-viewers"
            class="shrink-0 text-[11px] text-fg-muted">{{ $t("terminal.viewers", { count: otherViewerCount }) }}</span>
      <button v-if="canTakeControl" data-test="terminal-take-control"
              type="button"
              class="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
              :disabled="takingControl"
              @click="void takeControl()">{{ $t("terminal.takeControl") }}</button>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button data-test="toggle-keybar"
                :aria-label="keybarVisible ? $t('terminal.keybar.hide') : $t('terminal.keybar.show')"
                :title="keybarVisible ? $t('terminal.keybar.hide') : $t('terminal.keybar.show')"
                class="grid h-7 w-7 place-items-center rounded transition-colors"
                :class="keybarVisible ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-raised hover:text-fg'"
                @click="toggleKeybar"><Keyboard :size="16" /></button>
      </div>
    </div>

    <div v-if="!props.sessionAlias" class="p-4 text-sm text-fg-muted">{{ $t("terminal.noSession") }}</div>
    <div v-else-if="status === 'error'" class="p-4 text-sm text-fg-muted">{{ $t(errorKey) }}</div>
    <div v-else-if="status === 'exited'" class="p-4 text-sm text-fg-muted">{{ $t("terminal.exited", { code: errorKey }) }}</div>
    <div v-show="status === 'connecting' || status === 'open' || status === 'idle'"
         class="relative flex min-h-0 flex-1 flex-col">
      <div ref="host" class="term-host relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-bg"
           data-test="terminal-host"
           tabindex="0"
           :data-spectator="role === 'spectator' ? '1' : '0'"
           @mousedown="onHostMouseDown"></div>
      <div v-if="canTakeControl" data-test="terminal-spectator-overlay"
           class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-bg/75 px-4 text-center text-sm text-fg">
        <p>{{ $t("terminal.spectatorHint") }}</p>
        <button type="button"
                class="rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-40"
                :disabled="takingControl"
                @click="void takeControl()">{{ $t("terminal.takeControl") }}</button>
      </div>
    </div>

    <div v-if="keybarVisible" data-test="keybar"
         :style="keyboardInset ? { paddingBottom: '0.375rem' } : undefined"
         class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-surface px-2 py-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] thin-scroll">
      <button data-test="key-esc" :disabled="!canType" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey('\u001b')">Esc</button>
      <button data-test="key-tab" :disabled="!canType" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey('\t')">Tab</button>
      <button data-test="key-ctrl" :disabled="!canType" :aria-pressed="ctrlArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors disabled:opacity-40"
              :class="ctrlArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="ctrlArmed = !ctrlArmed">Ctrl</button>
      <button data-test="key-alt" :disabled="!canType" :aria-pressed="altArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors disabled:opacity-40"
              :class="altArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="altArmed = !altArmed">Alt</button>
      <button data-test="key-shift" :disabled="!canType" :aria-pressed="shiftArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors disabled:opacity-40"
              :class="shiftArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="shiftArmed = !shiftArmed">Shift</button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-left" :disabled="!canType" :aria-label="$t('terminal.keybar.left')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey('\u001b[D')"><ChevronLeft :size="15" /></button>
      <button data-test="key-up" :disabled="!canType" :aria-label="$t('terminal.keybar.up')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey('\u001b[A')"><ChevronUp :size="15" /></button>
      <button data-test="key-down" :disabled="!canType" :aria-label="$t('terminal.keybar.down')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey('\u001b[B')"><ChevronDown :size="15" /></button>
      <button data-test="key-right" :disabled="!canType" :aria-label="$t('terminal.keybar.right')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey('\u001b[C')"><ChevronRight :size="15" /></button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-home" :disabled="!canType" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey(KEYS.home)">Home</button>
      <button data-test="key-end" :disabled="!canType" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey(KEYS.end)">End</button>
      <button data-test="key-pageup" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="pageUp">PgUp</button>
      <button data-test="key-pagedown" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="pageDown">PgDn</button>
      <button data-test="key-insert" :disabled="!canType" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey(KEYS.insert)">Ins</button>
      <button data-test="key-enter" :disabled="!canType" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="sendKey(KEYS.enter, { refocus: true })">Enter</button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-copy" class="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="copySelection">
        <Copy :size="14" />{{ $t("terminal.keybar.copy") }}
      </button>
      <button data-test="key-paste" :disabled="!canType" class="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40" @click="pasteClipboard">
        <ClipboardPaste :size="14" />{{ $t("terminal.keybar.paste") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.term-host,
.term-host:focus,
.term-host:focus-visible,
.term-host:focus-within,
.term-host :deep(*:focus),
.term-host :deep(*:focus-visible) {
  outline: none !important;
  box-shadow: none !important;
}
/* No textarea overrides here: xterm.js keeps its own (invisible) helper textarea
   anchored at the cursor cell for IME - resizing or repositioning it from outside
   would defeat exactly where IMEs anchor their candidate UI. */
</style>