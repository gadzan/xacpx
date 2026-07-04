<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { ArrowLeft, FileText, FileDiff, X, Search, ChevronUp, ChevronDown } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
import { findInLines } from "../lib/find-in-lines";
import { applyMarks, clearMarks, setCurrent, scrollToLine } from "../lib/dom-line-highlight";
import type { FsDiffResult, FsReadResult } from "@ganglion/xacpx-relay-protocol";
// NOTE: ../lib/shiki is imported DYNAMICALLY inside the highlight callback below — never
// statically — so the Shiki core + JS engine stay out of FileViewer's (eagerly-loaded)
// chunk and the entry bundle, per the lazy-load size constraint. parseUnifiedDiff is a
// tiny pure module, so a static import is fine.
import { parseUnifiedDiff } from "../lib/unified-diff";
import CopyButton from "./CopyButton.vue";

// Roomy file/diff viewer that takes over the center column (the chat area) so file
// content isn't squeezed into the narrow right rail. The rail keeps navigation; this
// shows the selected file or single-file diff full-width, with a Back affordance.
//
// Content is instance-owned, not global: the caller passes instance/workspace/path (or
// diffPath) via props and this component loads (and owns) its own copy via the store's
// return-based readFile/readDiff — so multiple open tabs (e.g. two files, or a file and a
// terminal, across sessions) never clobber each other's content the way the old single
// `files.file`/`files.diff` slot did.
// line/lineRev: a scroll-to-line request (e.g. from a content-search hit). lineRev is bumped
// on each request so re-opening the same file+line still re-scrolls (see center-tabs store).
const props = defineProps<{
  instanceId: string;
  workspace: string;
  path?: string;
  diffPath?: string;
  line?: number;
  lineRev?: number;
}>();
const emit = defineEmits<{ back: []; close: [] }>();
const files = useFilesStore();

const rootEl = ref<HTMLElement | null>(null);
const scrollBody = ref<HTMLElement | null>(null);

const file = ref<FsReadResult | null>(null);
const diff = ref<FsDiffResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// Load this pane's own content whenever what it should show changes (mount included, via
// `immediate: true`). Race-guard: a fast tab/prop switch can start a second load before the
// first settles — each call stamps a token and bails on apply if a newer call has since
// started, so a stale response can never overwrite fresher content.
let loadToken = 0;
async function load(): Promise<void> {
  const token = ++loadToken;
  const { instanceId, workspace, path, diffPath } = props;
  loading.value = true;
  error.value = null;
  try {
    if (path) {
      const result = await files.readFile(instanceId, workspace, path);
      if (token !== loadToken) return; // props changed while awaiting — discard
      file.value = result;
      diff.value = null;
    } else if (diffPath) {
      const result = await files.readDiff(instanceId, workspace, diffPath);
      if (token !== loadToken) return;
      diff.value = result;
      file.value = null;
    } else {
      file.value = null;
      diff.value = null;
    }
  } catch (e) {
    if (token !== loadToken) return;
    // Clear stale content on a real failure — otherwise the pane would keep showing the
    // previous selection's file/diff as if it were the (failed) new one.
    file.value = null;
    diff.value = null;
    error.value = e instanceof Error ? e.message : "read-failed";
  } finally {
    if (token === loadToken) loading.value = false;
  }
}
watch(() => [props.instanceId, props.workspace, props.path, props.diffPath] as const, load, { immediate: true });

// Above this many lines we skip Shiki and render a plain <pre> so a huge file doesn't
// stall the highlighter or emit an enormous DOM.
const LINE_GUTTER_LIMIT = 5000;
const fileLines = computed(() => {
  const f = file.value;
  if (!f || f.binary) return [];
  return f.content.split("\n");
});

// Highlighted file HTML (Shiki). Empty until the first highlight resolves; while empty we
// render a plain <pre> fallback. Debounced 150ms (cheap protection against rapid refreshes).
const fileHtml = ref("");
let hlTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => [file.value?.path, file.value?.content, file.value?.binary] as const,
  ([path, content, binary]) => {
    if (hlTimer) clearTimeout(hlTimer);
    fileHtml.value = "";
    if (!file.value || binary || content === undefined) return;
    if (fileLines.value.length > LINE_GUTTER_LIMIT) return; // plain fallback for huge files
    const code = content;
    hlTimer = setTimeout(() => {
      // Dynamic import keeps Shiki out of this component's chunk; loaded only when a
      // highlight actually runs. vi.mock("../lib/shiki") in tests intercepts this too.
      void (async () => {
        const { resolveLang, highlightToHtml } = await import("../lib/shiki");
        const html = await highlightToHtml(code, resolveLang(path));
        // ignore a stale result if the file changed while we were highlighting
        if (file.value?.content === code) fileHtml.value = html;
      })();
    }, 150);
  },
  { immediate: true },
);

// Structured rows for the single-file diff (HAPI-style tinted rows; not syntax-highlighted).
const parsedDiff = computed(() => (diff.value?.diff ? parseUnifiedDiff(diff.value.diff) : null));

function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── In-file find ─────────────────────────────────────────────────────────────────────
// Search highlights are layered onto the ALREADY-rendered code DOM (so Shiki syntax colors
// survive) via dom-line-highlight, anchored to the `.line` elements Shiki emits. `anchors`
// is the ordered list of per-match <mark>s; it's plain (non-reactive) DOM state, while the
// count/current index drive the UI.
const findOpen = ref(false);
const findQuery = ref("");
const findInput = ref<HTMLInputElement | null>(null);
const matchCount = ref(0);
const currentIdx = ref(-1);
let anchors: HTMLElement[] = [];

// Only text files that are actually highlighted have the `.line` anchors search needs;
// gate out binary and huge (> LINE_GUTTER_LIMIT, plain-<pre>) files so we never offer a
// find bar that would always report "No results".
const canFind = computed(
  () => !!file.value && !file.value.binary && fileLines.value.length <= LINE_GUTTER_LIMIT,
);

function recomputeSearch() {
  const el = scrollBody.value;
  if (!el) return;
  clearMarks(el);
  anchors = [];
  matchCount.value = 0;
  currentIdx.value = -1;
  if (!findOpen.value || !findQuery.value.trim()) return;
  anchors = applyMarks(el, findInLines(fileLines.value, findQuery.value));
  matchCount.value = anchors.length;
  if (anchors.length) {
    currentIdx.value = 0;
    setCurrent(anchors, 0);
  }
}
// flush:'post' so the v-html DOM (and any content swap) is in place before we mark it.
watch([() => fileHtml.value, findQuery, findOpen], recomputeSearch, { flush: "post" });

function nextMatch() {
  if (!anchors.length) return;
  currentIdx.value = (currentIdx.value + 1) % anchors.length;
  setCurrent(anchors, currentIdx.value);
}
function prevMatch() {
  if (!anchors.length) return;
  currentIdx.value = (currentIdx.value - 1 + anchors.length) % anchors.length;
  setCurrent(anchors, currentIdx.value);
}
function openFind() {
  if (!canFind.value) return;
  findOpen.value = true;
  void nextTick(() => findInput.value?.focus());
}
function closeFind() {
  findOpen.value = false;
  findQuery.value = "";
}

// Cmd/Ctrl-F opens the find bar, but only in the VISIBLE pane — every open file tab has a
// mounted (v-show-hidden) FileViewer, and offsetParent is null while display:none, so the
// hidden ones ignore the shortcut.
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
    if (!rootEl.value || rootEl.value.offsetParent === null || !canFind.value) return;
    // Don't steal Cmd/Ctrl-F from another focused field (e.g. the right-rail file search).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") && t !== findInput.value) return;
    e.preventDefault();
    openFind();
  }
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  if (hlTimer) clearTimeout(hlTimer); // don't run the highlight debounce after unmount
});

// ── Scroll-to-line (from a content-search hit) ───────────────────────────────────────
let lastScrolledRev = 0;
watch(
  [() => props.lineRev, () => file.value, () => fileHtml.value],
  () => {
    if (!props.line || props.lineRev == null || props.lineRev === lastScrolledRev) return;
    if (!file.value) return; // content not on screen yet — this refires when it loads
    const el = scrollBody.value;
    if (!el) return;
    // Prefer scrolling once the highlighted `.line` rows exist (precise + line flash). If the
    // file WILL be highlighted but isn't yet, wait — this refires when fileHtml lands. Only a
    // never-highlighted (huge) file takes the line-height fallback immediately.
    const willHighlight = !file.value.binary && fileLines.value.length <= LINE_GUTTER_LIMIT;
    if (!el.querySelector(".line") && willHighlight) return;
    scrollToLine(el, props.line);
    lastScrolledRev = props.lineRev;
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="rootEl" class="flex h-full flex-1 flex-col bg-bg" data-test="file-viewer-center">
    <!-- header: back + path + meta -->
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <button data-test="fv-back-list" :aria-label="$t('files.backToList')"
              class="flex lg:hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('back')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("files.title") }}</button>
      <button data-test="fv-back" :aria-label="$t('files.back')"
              class="hidden lg:flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('close')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("files.back") }}</button>
      <span class="h-4 w-px bg-border" aria-hidden="true" />
      <template v-if="file">
        <FileText :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ file.path }}</span>
        <span class="shrink-0 text-[11px] text-fg-muted">{{ fmtSize(file.size) }}</span>
        <span v-if="file.truncated" class="shrink-0 rounded bg-warn/10 px-1 text-[10.5px] text-warn">{{ $t("files.truncated") }}</span>
        <span v-if="file.binary" class="shrink-0 rounded bg-fg/5 px-1 text-[10.5px] text-fg-muted">{{ $t("files.binary") }}</span>
      </template>
      <template v-else-if="props.diffPath">
        <FileDiff :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ props.diffPath }}</span>
      </template>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button v-if="canFind" data-test="fv-find-toggle" :aria-label="$t('files.find')" :title="$t('files.find')"
                class="grid h-7 w-7 place-items-center rounded transition-colors hover:bg-raised hover:text-fg"
                :class="findOpen ? 'bg-accent/10 text-accent' : 'text-fg-muted'"
                @click="findOpen ? closeFind() : openFind()"><Search :size="15" /></button>
        <CopyButton v-if="file && !file.binary" :text="file.content" />
        <button data-test="fv-close" :aria-label="$t('files.closeFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:hidden"
                @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- in-file find bar -->
    <div v-if="findOpen" data-test="fv-find-bar" class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <Search :size="13" class="shrink-0 text-fg-muted" />
      <input ref="findInput" data-test="fv-find-input" v-model="findQuery" :placeholder="$t('files.findPlaceholder')"
             class="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-fg-muted/60"
             @keydown.enter.prevent="nextMatch()" @keydown.enter.shift.prevent="prevMatch()" @keydown.esc.prevent="closeFind()" />
      <span data-test="fv-find-count" class="shrink-0 tabular-nums text-[11px] text-fg-muted">{{ matchCount ? `${currentIdx + 1}/${matchCount}` : $t("files.findNone") }}</span>
      <button data-test="fv-find-prev" :aria-label="$t('files.findPrev')" :disabled="!matchCount"
              class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
              @click="prevMatch()"><ChevronUp :size="14" /></button>
      <button data-test="fv-find-next" :aria-label="$t('files.findNext')" :disabled="!matchCount"
              class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
              @click="nextMatch()"><ChevronDown :size="14" /></button>
      <button data-test="fv-find-close" :aria-label="$t('files.findClose')"
              class="grid h-6 w-6 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="closeFind()"><X :size="14" /></button>
    </div>

    <!-- body -->
    <div ref="scrollBody" class="min-h-0 flex-1 overflow-auto thin-scroll">
      <!-- load failed: a rejected load clears file/diff (see `load()`'s catch), so this only
           shows in place of — never on top of — stale content from a previous selection. -->
      <div v-if="error" data-test="fv-error" class="m-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</div>
      <!-- loading affordance: only while nothing is on screen yet (first load, or after an
           error-cleared retry) — a load-in-progress for an already-shown file keeps that
           file visible instead of flashing this. -->
      <div v-else-if="loading && !file && !diff" data-test="fv-loading" class="p-6 text-sm text-fg-muted">{{ $t("files.loading") }}</div>
      <!-- file content -->
      <template v-if="file">
        <div v-if="!file.binary && fileLines.length <= LINE_GUTTER_LIMIT" data-test="fv-file-body">
          <div v-if="fileHtml" v-html="fileHtml"></div>
          <pre v-else class="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg whitespace-pre">{{ file.content }}</pre>
        </div>
        <pre v-else-if="!file.binary" data-test="fv-file-body" class="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg whitespace-pre">{{ file.content }}</pre>
        <div v-else class="p-6 text-sm text-fg-muted">{{ $t("files.binaryNotShown") }}</div>
      </template>
      <!-- single-file diff: structured tinted rows with dual line numbers (no syntax highlight) -->
      <template v-else-if="props.diffPath && diff">
        <div v-if="parsedDiff && parsedDiff.rows.length" data-test="fv-diff-body" class="font-mono text-[12.5px] leading-relaxed">
          <div v-for="(r, i) in parsedDiff.rows" :key="i" data-test="fv-diff-row" class="flex"
               :class="r.type === 'add' ? 'bg-run/10' : r.type === 'del' ? 'bg-danger/10' : r.type === 'hunk' ? 'bg-info/5' : ''">
            <span class="sticky left-0 w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.oldNo ?? "" }}</span>
            <span class="w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.newNo ?? "" }}</span>
            <span class="w-4 shrink-0 select-none text-center" :class="r.type === 'add' ? 'text-run' : r.type === 'del' ? 'text-danger' : 'text-fg-muted/40'">{{ r.type === 'add' ? '+' : r.type === 'del' ? '-' : '' }}</span>
            <span class="whitespace-pre px-2" :class="r.type === 'hunk' ? 'text-info' : 'text-fg'">{{ r.text }}</span>
          </div>
        </div>
        <div v-else class="p-6 text-sm text-fg-muted">{{ $t("files.noDiffContent") }}</div>
        <div v-if="diff.truncated" class="px-4 py-1 text-xs text-warn">{{ $t("files.diffTruncated") }}</div>
      </template>
    </div>
  </div>
</template>
