<script setup lang="ts">
import { FileText } from "lucide-vue-next";
import type { AttachmentMetadata } from "@ganglion/xacpx-relay-protocol";

defineProps<{ attachments: AttachmentMetadata[] }>();

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="mt-1 flex flex-wrap gap-2">
    <template v-for="a in attachments" :key="a.id">
      <img
        v-if="a.kind === 'image' && a.previewUrl"
        data-test="att-image"
        :src="a.previewUrl"
        :alt="a.filename"
        class="max-h-40 max-w-[200px] rounded-lg border border-border object-cover"
      />
      <div
        v-else
        data-test="att-file"
        class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[13px]"
      >
        <FileText :size="16" class="shrink-0 text-fg-muted" />
        <span class="max-w-[180px] truncate">{{ a.filename }}</span>
        <span class="text-fg-muted">{{ fmtSize(a.size) }}</span>
      </div>
    </template>
  </div>
</template>
