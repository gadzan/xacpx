<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowLeft, FileText, FileDiff, X } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
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
const props = defineProps<{ instanceId: string; workspace: string; path?: string; diffPath?: string }>();
const emit = defineEmits<{ back: []; close: [] }>();
const files = useFilesStore();

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
</script>

<template>
  <div class="flex h-full flex-1 flex-col bg-bg" data-test="file-viewer-center">
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
        <CopyButton v-if="file && !file.binary" :text="file.content" />
        <button data-test="fv-close" :aria-label="$t('files.closeFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:hidden"
                @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- body -->
    <div class="min-h-0 flex-1 overflow-auto thin-scroll">
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
