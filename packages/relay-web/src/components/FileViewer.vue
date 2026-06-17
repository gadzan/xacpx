<script setup lang="ts">
import { computed } from "vue";
import { ArrowLeft, FileText, FileDiff, X } from "lucide-vue-next";
import { useFilesStore } from "../stores/files";
import CopyButton from "./CopyButton.vue";

// Roomy file/diff viewer that takes over the center column (the chat area) so file
// content isn't squeezed into the narrow right rail. The rail keeps navigation; this
// shows the selected file or single-file diff full-width, with a Back affordance.
const emit = defineEmits<{ back: []; close: [] }>();
const files = useFilesStore();

// Above this many lines we drop the per-line gutter and render a plain <pre> so a huge
// file doesn't emit tens of thousands of DOM nodes.
const LINE_GUTTER_LIMIT = 5000;
const fileLines = computed(() => {
  const f = files.file;
  if (!f || f.binary) return [];
  return f.content.split("\n");
});

function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-run";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-danger";
  if (line.startsWith("@@")) return "text-info";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "text-fg-muted";
  return "text-fg-muted";
}
</script>

<template>
  <div class="flex h-full flex-1 flex-col bg-bg" data-test="file-viewer-center">
    <!-- header: back + path + meta -->
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <button data-test="fv-back-list" aria-label="Back to file list"
              class="flex lg:hidden items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('back')"><ArrowLeft :size="14" />Files</button>
      <button data-test="fv-back" aria-label="Back"
              class="hidden lg:flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('close')"><ArrowLeft :size="14" />Back</button>
      <span class="h-4 w-px bg-border" aria-hidden="true" />
      <template v-if="files.file">
        <FileText :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ files.file.path }}</span>
        <span class="shrink-0 text-[11px] text-fg-muted">{{ fmtSize(files.file.size) }}</span>
        <span v-if="files.file.truncated" class="shrink-0 rounded bg-warn/10 px-1 text-[10.5px] text-warn">truncated</span>
        <span v-if="files.file.binary" class="shrink-0 rounded bg-fg/5 px-1 text-[10.5px] text-fg-muted">binary</span>
      </template>
      <template v-else-if="files.diffPath">
        <FileDiff :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ files.diffPath }}</span>
      </template>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <CopyButton v-if="files.file && !files.file.binary" :text="files.file.content" />
        <button data-test="fv-close" aria-label="Close file"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:hidden"
                @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- body -->
    <div class="min-h-0 flex-1 overflow-auto thin-scroll">
      <!-- file content -->
      <template v-if="files.file">
        <div v-if="!files.file.binary && fileLines.length <= LINE_GUTTER_LIMIT" data-test="fv-file-body" class="font-mono text-[12.5px] leading-relaxed">
          <div v-for="(l, i) in fileLines" :key="i" data-test="fv-line" class="flex">
            <span class="sticky left-0 w-14 shrink-0 select-none border-r border-border bg-surface px-3 text-right text-fg-muted tabular-nums">{{ i + 1 }}</span>
            <span class="whitespace-pre px-4 text-fg">{{ l || " " }}</span>
          </div>
        </div>
        <pre v-else-if="!files.file.binary" class="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg whitespace-pre">{{ files.file.content }}</pre>
        <div v-else class="p-6 text-sm text-fg-muted">Binary file not shown.</div>
      </template>
      <!-- single-file diff -->
      <template v-else-if="files.diffPath && files.diff">
        <pre v-if="files.diff.diff" data-test="fv-diff-body" class="p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre"><span v-for="(l, i) in files.diff.diff.split('\n')" :key="i" class="block" :class="diffLineClass(l)">{{ l }}</span></pre>
        <div v-else class="p-6 text-sm text-fg-muted">No diff content.</div>
        <div v-if="files.diff.truncated" class="px-4 py-1 text-xs text-warn">diff truncated</div>
      </template>
    </div>
  </div>
</template>
