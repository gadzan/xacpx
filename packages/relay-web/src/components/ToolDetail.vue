<script setup lang="ts">
import { computed } from "vue";
import type { ToolDetailDto } from "@ganglion/xacpx-relay-protocol";
import { File, Search } from "lucide-vue-next";

const props = defineProps<{ detail: ToolDetailDto }>();

// Split a diff body into rendered +/- lines.
const diffLines = computed(() => {
  if (props.detail.type !== "diff") return { del: [] as string[], add: [] as string[] };
  return { del: props.detail.oldText.split("\n"), add: props.detail.newText.split("\n") };
});
// Non-empty changed-line counts for the +N/−N stat badges.
const diffStats = computed(() => ({
  add: diffLines.value.add.filter((l) => l.length > 0).length,
  del: diffLines.value.del.filter((l) => l.length > 0).length,
}));
</script>

<template>
  <div class="mt-1 space-y-1 text-xs">
    <template v-if="detail.type === 'diff'">
      <div class="flex items-center gap-2 font-mono text-fg-muted">
        <span class="inline-flex items-center gap-1"><File :size="14" />{{ detail.path }}</span>
        <span data-test="diff-stats" class="ml-auto flex items-center gap-2 font-mono text-[10px]">
          <span v-if="diffStats.add" class="text-run">+{{ diffStats.add }}</span>
          <span v-if="diffStats.del" class="text-danger">−{{ diffStats.del }}</span>
        </span>
      </div>
      <div class="overflow-x-auto rounded bg-bg p-2 font-mono">
        <div v-for="(l, i) in diffLines.del" :key="'d' + i" data-test="diff-del" class="whitespace-pre text-danger">- {{ l }}</div>
        <div v-for="(l, i) in diffLines.add" :key="'a' + i" data-test="diff-add" class="whitespace-pre text-run">+ {{ l }}</div>
      </div>
    </template>

    <template v-else-if="detail.type === 'command'">
      <div data-test="cmd-command" class="font-mono text-fg">$ {{ detail.command }}</div>
      <pre v-if="detail.output" data-test="cmd-output" class="overflow-x-auto rounded bg-raised p-2 font-mono text-fg whitespace-pre-wrap">{{ detail.output }}</pre>
      <div v-if="detail.exitCode !== undefined" class="text-fg-muted">exit {{ detail.exitCode }}</div>
    </template>

    <template v-else-if="detail.type === 'read'">
      <div data-test="read-path" class="inline-flex items-center gap-1 font-mono text-fg"><File :size="14" />{{ detail.path }}<span v-if="detail.lines" class="ml-2 text-fg-muted">{{ detail.lines }}</span></div>
      <pre v-if="detail.preview" class="overflow-x-auto rounded bg-bg p-2 font-mono text-fg-muted whitespace-pre-wrap">{{ detail.preview }}</pre>
    </template>

    <template v-else-if="detail.type === 'search'">
      <div data-test="search-query" class="inline-flex items-center gap-1 font-mono text-fg"><Search :size="14" />{{ detail.query }}</div>
      <pre v-if="detail.output" data-test="search-output" class="overflow-x-auto rounded bg-bg p-2 font-mono text-fg-muted whitespace-pre-wrap">{{ detail.output }}</pre>
    </template>

    <template v-else-if="detail.type === 'fields'">
      <dl class="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
        <template v-for="f in detail.fields" :key="f.label">
          <dt class="text-fg-muted">{{ f.label }}</dt>
          <dd :data-test="'field-' + f.label" class="font-mono text-fg break-all">{{ f.value }}</dd>
        </template>
      </dl>
      <pre v-if="detail.output" class="overflow-x-auto rounded bg-bg p-2 font-mono text-fg-muted whitespace-pre-wrap">{{ detail.output }}</pre>
    </template>

    <template v-else-if="detail.type === 'text'">
      <p data-test="tool-text" class="whitespace-pre-wrap text-fg-muted">{{ detail.text }}</p>
    </template>
  </div>
</template>
