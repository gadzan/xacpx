<script setup lang="ts">
import { computed } from "vue";
import type { ToolDetailDto } from "@ganglion/xacpx-relay-protocol";
import ExpandableBlock from "./ExpandableBlock.vue";
import { diffLines } from "../lib/line-diff";

const props = defineProps<{ detail: ToolDetailDto }>();

// Line-level diff of the two blobs, with old/new line numbers and true +/− counts.
const parsedDiff = computed(() =>
  props.detail.type === "diff" ? diffLines(props.detail.oldText, props.detail.newText) : null,
);
// Result-line count for the search badge (non-empty output lines).
const searchCount = computed(() =>
  props.detail.type === "search" && props.detail.output
    ? props.detail.output.split("\n").filter((l) => l.length > 0).length
    : 0,
);
const showSearchCount = computed(() => {
  if (props.detail.type !== "search" || !props.detail.output) return false;
  // Count-shaped outputs ("4 matches") already carry their own total —
  // a line count beside them would contradict it (1 line vs 4 matches).
  return !/^\d+ (matches|files)/.test(props.detail.output.trim());
});
</script>

<template>
  <div class="mt-1 space-y-1 text-xs">
    <template v-if="detail.type === 'diff'">
      <p
        v-if="detail.instruction"
        data-test="diff-instruction"
        class="line-clamp-2 text-fg-muted"
        :title="detail.instruction"
      >{{ detail.instruction }}</p>
      <ExpandableBlock v-if="parsedDiff && parsedDiff.rows.length">
        <div class="overflow-x-auto rounded bg-bg font-mono leading-relaxed">
          <div
            v-for="(r, i) in parsedDiff.rows"
            :key="i"
            :data-test="r.type === 'add' ? 'diff-add' : r.type === 'del' ? 'diff-del' : 'diff-context'"
            class="flex"
            :class="r.type === 'add' ? 'bg-run/10' : r.type === 'del' ? 'bg-danger/10' : ''"
          >
            <span class="w-8 shrink-0 select-none border-r border-border px-1 text-right tabular-nums text-fg-muted/60">{{ r.oldNo ?? "" }}</span>
            <span class="w-8 shrink-0 select-none border-r border-border px-1 text-right tabular-nums text-fg-muted/60">{{ r.newNo ?? "" }}</span>
            <span class="w-3 shrink-0 select-none text-center" :class="r.type === 'add' ? 'text-run' : r.type === 'del' ? 'text-danger' : 'text-fg-muted/40'">{{ r.type === 'add' ? '+' : r.type === 'del' ? '-' : '' }}</span>
            <span class="whitespace-pre px-1" :class="r.type === 'add' ? 'text-run' : r.type === 'del' ? 'text-danger' : 'text-fg'">{{ r.text }}</span>
          </div>
        </div>
      </ExpandableBlock>
    </template>

    <template v-else-if="detail.type === 'command'">
      <ExpandableBlock v-if="detail.output">
        <pre data-test="cmd-output" class="overflow-x-auto rounded bg-raised p-2 font-mono text-fg whitespace-pre-wrap">{{ detail.output }}</pre>
      </ExpandableBlock>
      <div v-if="detail.exitCode !== undefined" :class="detail.exitCode !== 0 ? 'text-danger' : 'text-fg-muted'">exit {{ detail.exitCode }}</div>
    </template>

    <template v-else-if="detail.type === 'read'">
      <div v-if="detail.lines" data-test="read-lines" class="font-mono text-[11px] text-fg-muted">{{ detail.lines }}</div>
      <ExpandableBlock v-if="detail.preview">
        <pre data-test="read-preview" class="overflow-x-auto rounded bg-bg p-2 font-mono text-fg-muted whitespace-pre-wrap">{{ detail.preview }}</pre>
      </ExpandableBlock>
    </template>

    <template v-else-if="detail.type === 'search'">
      <div v-if="showSearchCount" data-test="search-count" class="font-mono text-[11px] text-fg-muted">{{ searchCount }} lines</div>
      <ExpandableBlock v-if="detail.output">
        <pre data-test="search-output" class="overflow-x-auto rounded bg-bg p-2 font-mono text-fg-muted whitespace-pre-wrap">{{ detail.output }}</pre>
      </ExpandableBlock>
    </template>

    <template v-else-if="detail.type === 'fields'">
      <dl class="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
        <template v-for="f in detail.fields" :key="f.label">
          <dt class="text-fg-muted">{{ f.label }}</dt>
          <dd :data-test="'field-' + f.label" class="font-mono text-fg break-all">{{ f.value }}</dd>
        </template>
      </dl>
      <ExpandableBlock v-if="detail.output">
        <pre class="overflow-x-auto rounded bg-bg p-2 font-mono text-fg-muted whitespace-pre-wrap">{{ detail.output }}</pre>
      </ExpandableBlock>
    </template>

    <template v-else-if="detail.type === 'text'">
      <ExpandableBlock>
        <p data-test="tool-text" class="whitespace-pre-wrap text-fg-muted">{{ detail.text }}</p>
      </ExpandableBlock>
    </template>
  </div>
</template>
