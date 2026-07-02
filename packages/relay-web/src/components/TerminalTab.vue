<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { ArrowLeft, Keyboard, ClipboardPaste, Copy, ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-vue-next";
import { createTerminalAdapter, type TerminalAdapter, type TerminalTheme } from "../lib/terminal-adapter";
import { useTerminalStore } from "../stores/terminal";
import { useThemeStore } from "../stores/theme";

const props = defineProps<{ instanceId: string; sessionAlias: string }>();
const emit = defineEmits<{ close: [] }>();
const terminals = useTerminalStore();
const theme = useThemeStore();
const host = ref<HTMLDivElement | null>(null);
const status = ref<"idle" | "connecting" | "open" | "exited" | "error">("idle");
const errorKey = ref<string>("");
// Sticky modifiers — click to arm, applied to the next key, then auto-disarm (one-shot).
const ctrlArmed = ref(false);
const altArmed = ref(false);
const shiftArmed = ref(false);

// Read a `--c-*` design token ("R G B" triplet) as a hex color ghostty's theme parses.
// Falls back to a dark default when the var is unreadable (e.g. jsdom, or pre-mount).
function tokenHex(varName: string, fallback: string): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return fallback;
  return "#" + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
}
// Keep the terminal background identical to the host so the integer-cell fit remainder
// (the < 1-cell strip on the right/bottom) is invisible instead of a black seam.
function currentTheme(): TerminalTheme {
  return { background: tokenHex("--c-bg", "#0e1116"), foreground: tokenHex("--c-fg", "#e8ecf1") };
}

// Mobile has no physical Esc/Ctrl/arrows, so the shortcut bar defaults visible there and
// hidden on desktop (which has a real keyboard). A saved preference overrides the default.
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
let terminalId = "";
let offOutput: (() => void) | null = null;
let offExit: (() => void) | null = null;
let resizeObs: ResizeObserver | null = null;
let epoch = 0;

// ESC built from a char code — a literal escape byte in this .vue gets mangled on save.
const ESC = String.fromCharCode(0x1b);
// Named CSI sequences for the shortcut bar (arrows stay inline in the template).
const KEYS = {
  home: ESC + "[H",
  end: ESC + "[F",
  pageUp: ESC + "[5~",
  pageDown: ESC + "[6~",
  insert: ESC + "[2~",
  enter: "\r",
};
function anyModArmed(): boolean {
  return ctrlArmed.value || altArmed.value || shiftArmed.value;
}
function disarmMods() {
  ctrlArmed.value = false; altArmed.value = false; shiftArmed.value = false;
}
// xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). 1 means "no modifiers".
function modParam(): number {
  return 1 + (shiftArmed.value ? 1 : 0) + (altArmed.value ? 2 : 0) + (ctrlArmed.value ? 4 : 0);
}

// Apply armed modifiers to typed soft-keyboard input (a single char): Shift upcases,
// Ctrl maps a letter to its control code (c→\x03), Alt/Meta prefixes ESC. Then disarm.
function handleData(d: string) {
  if (!terminalId) return;
  let out = d;
  if (d.length === 1 && anyModArmed()) {
    if (shiftArmed.value) out = out.toUpperCase();
    if (ctrlArmed.value) {
      const lc = out.toLowerCase().charCodeAt(0);
      if (lc >= 97 && lc <= 122) out = String.fromCharCode(lc - 96);
    }
    if (altArmed.value) out = "" + out;
    disarmMods();
  }
  terminals.input(props.instanceId, terminalId, out);
}

// Apply armed modifiers to a keybar escape sequence. CSI keys (arrows, Home/End as
// `\x1b[<L>` and PgUp/Ins etc. as `\x1b[<n>~`) take an xterm `1;<mod>` parameter;
// Shift+Tab is the special reverse-tab `\x1b[Z`. Non-CSI keys (Enter/Esc) pass through.
function applyMods(seq: string): string {
  const mod = modParam();
  if (mod === 1) return seq;
  if (seq === "\t") return shiftArmed.value ? "[Z" : seq;
  const letter = /^\[([A-Z])$/.exec(seq);
  if (letter) return `[1;${mod}${letter[1]}`;
  const tilde = /^\[(\d+)~$/.exec(seq);
  if (tilde) return `[${tilde[1]};${mod}~`;
  return seq;
}

function sendKey(seq: string) {
  if (!terminalId) return;
  const out = applyMods(seq);
  if (anyModArmed()) disarmMods();
  terminals.input(props.instanceId, terminalId, out);
  adapter?.focus();
}

async function pasteClipboard() {
  try {
    const text = await navigator.clipboard?.readText();
    if (text) sendKey(text);
  } catch { /* clipboard blocked/unavailable — ignore */ }
}

// Copy the current terminal selection to the clipboard (no-op when nothing is selected).
async function copySelection() {
  const sel = adapter?.getSelection() ?? "";
  if (!sel) return;
  try { await navigator.clipboard?.writeText(sel); } catch { /* clipboard blocked — ignore */ }
  adapter?.focus();
}

// Fit the ghostty grid to the host using the adapter's canvas-derived cell size, then tell
// the PTY. Retries via rAF until the canvas has a measurable size. Epoch-guarded so a
// teardown/supersede stops the retry loop.
function applyFit(myEpoch = epoch) {
  if (myEpoch !== epoch || !terminalId || !adapter) return;
  const dim = adapter.fit();
  if (!dim) { requestAnimationFrame(() => applyFit(myEpoch)); return; }
  adapter.resize(dim.cols, dim.rows);
  terminals.resize(props.instanceId, terminalId, dim.cols, dim.rows);
}

function teardown() {
  epoch++;
  offOutput?.(); offOutput = null;
  offExit?.(); offExit = null;
  resizeObs?.disconnect(); resizeObs = null;
  if (terminalId) terminals.close(props.instanceId, terminalId);
  adapter?.dispose(); adapter = null; terminalId = "";
  disarmMods();
}

async function start() {
  teardown();
  const myEpoch = epoch;
  if (!props.sessionAlias || !host.value) { status.value = "idle"; return; }
  status.value = "connecting";
  const currentAdapter = createTerminalAdapter(host.value, {
    cols: 80, rows: 24,
    onData: handleData,
    theme: currentTheme(),
  });
  adapter = currentAdapter;
  offOutput = terminals.onOutput((id, data) => { if (id === terminalId) adapter?.write(data); });
  offExit = terminals.onExit((id, code) => { if (id === terminalId) { status.value = "exited"; errorKey.value = String(code); } });
  try {
    const newId = await terminals.create(props.instanceId, props.sessionAlias, currentAdapter.cols(), currentAdapter.rows());
    if (myEpoch !== epoch) {
      // Superseded by a later start()/teardown: close the just-created orphan PTY. The superseding
      // teardown already disposed this adapter when `adapter` still pointed at it, so only dispose
      // if it wasn't (guard against double-dispose).
      terminals.close(props.instanceId, newId);
      if (adapter === currentAdapter) currentAdapter.dispose();
      return;
    }
    terminalId = newId;
    status.value = "open";
    resizeObs = new ResizeObserver(() => applyFit());
    if (host.value) resizeObs.observe(host.value);
    applyFit(myEpoch);
  } catch (e) {
    if (myEpoch !== epoch) return;
    status.value = "error";
    const msg = e instanceof Error ? e.message : "";
    errorKey.value = msg === "terminal-disabled" ? "terminal.disabled"
      : msg === "terminal-unsupported-platform" ? "terminal.unsupported"
      : msg === "instance-offline" ? "terminal.offline"
      : "terminal.error";
  }
}

onMounted(() => void start());
watch(() => [props.instanceId, props.sessionAlias], () => void start());
// Recolor the live terminal when the app toggles light/dark so it never leaves a
// mismatched background band around the grid.
watch(() => theme.mode, () => adapter?.setTheme(currentTheme()));
onBeforeUnmount(teardown);
</script>

<template>
  <div class="flex h-full flex-col bg-bg" data-test="terminal-center">
    <!-- header -->
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <button data-test="term-close" :aria-label="$t('terminal.close')"
              class="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('close')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("terminal.title") }}</button>
      <span class="h-4 w-px bg-border" aria-hidden="true" />
      <span class="min-w-0 truncate font-mono text-[12.5px] text-fg">{{ props.sessionAlias }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button data-test="toggle-keybar"
                :aria-label="keybarVisible ? $t('terminal.keybar.hide') : $t('terminal.keybar.show')"
                :title="keybarVisible ? $t('terminal.keybar.hide') : $t('terminal.keybar.show')"
                class="grid h-7 w-7 place-items-center rounded transition-colors"
                :class="keybarVisible ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-raised hover:text-fg'"
                @click="toggleKeybar"><Keyboard :size="16" /></button>
      </div>
    </div>

    <!-- body -->
    <div v-if="!props.sessionAlias" class="p-4 text-sm text-fg-muted">{{ $t("terminal.noSession") }}</div>
    <div v-else-if="status === 'error'" class="p-4 text-sm text-fg-muted">{{ $t(errorKey) }}</div>
    <div v-else-if="status === 'exited'" class="p-4 text-sm text-fg-muted">{{ $t("terminal.exited", { code: errorKey }) }}</div>
    <div ref="host" class="term-host flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-bg" data-test="terminal-host"></div>

    <!-- shortcut bar -->
    <div v-if="keybarVisible" data-test="keybar"
         class="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-surface px-2 py-1.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))] thin-scroll">
      <button data-test="key-esc" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b')">Esc</button>
      <button data-test="key-tab" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\t')">Tab</button>
      <button data-test="key-ctrl" :aria-pressed="ctrlArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors"
              :class="ctrlArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="ctrlArmed = !ctrlArmed">Ctrl</button>
      <button data-test="key-alt" :aria-pressed="altArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors"
              :class="altArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="altArmed = !altArmed">Alt</button>
      <button data-test="key-shift" :aria-pressed="shiftArmed"
              class="shrink-0 rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors"
              :class="shiftArmed ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-bg text-fg-muted hover:bg-raised hover:text-fg'"
              @click="shiftArmed = !shiftArmed">Shift</button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-left" :aria-label="$t('terminal.keybar.left')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[D')"><ChevronLeft :size="15" /></button>
      <button data-test="key-up" :aria-label="$t('terminal.keybar.up')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[A')"><ChevronUp :size="15" /></button>
      <button data-test="key-down" :aria-label="$t('terminal.keybar.down')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[B')"><ChevronDown :size="15" /></button>
      <button data-test="key-right" :aria-label="$t('terminal.keybar.right')" class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-bg text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey('\u001b[C')"><ChevronRight :size="15" /></button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-home" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey(KEYS.home)">Home</button>
      <button data-test="key-end" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey(KEYS.end)">End</button>
      <button data-test="key-pageup" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey(KEYS.pageUp)">PgUp</button>
      <button data-test="key-pagedown" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey(KEYS.pageDown)">PgDn</button>
      <button data-test="key-insert" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey(KEYS.insert)">Ins</button>
      <button data-test="key-enter" class="shrink-0 rounded-md border border-border bg-bg px-2.5 py-1 font-mono text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="sendKey(KEYS.enter)">Enter</button>
      <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <button data-test="key-copy" class="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="copySelection">
        <Copy :size="14" />{{ $t("terminal.keybar.copy") }}
      </button>
      <button data-test="key-paste" class="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-bg px-2.5 py-1 text-[12px] text-fg-muted transition-colors hover:bg-raised hover:text-fg" @click="pasteClipboard">
        <ClipboardPaste :size="14" />{{ $t("terminal.keybar.paste") }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ghostty renders into a focusable canvas; the browser's default focus ring draws a blue
 * box around the whole terminal. The cursor already signals focus, so suppress it. */
.term-host :deep(canvas),
.term-host :deep(*:focus),
.term-host :deep(*:focus-visible) {
  outline: none;
}
</style>
