<script setup lang="ts">
import { computed } from "vue";
import { FileText } from "lucide-vue-next";
import type { AttachmentMetadata } from "@ganglion/xacpx-relay-protocol";
import { openLightbox } from "../lib/use-image-lightbox";

const props = defineProps<{ attachments: AttachmentMetadata[] }>();

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The lightbox pages within THIS bubble's images, in attachment order. The
// viewer index of attachment i is its rank among the preceding viewable images.
const imageRank = computed(() => {
  const ranks = new Map<number, number>();
  let n = 0;
  props.attachments.forEach((a, i) => {
    if (a.kind === "image" && a.previewUrl) ranks.set(i, n++);
  });
  return ranks;
});

function openAt(attachmentIndex: number): void {
  const images = props.attachments
    .filter((a) => a.kind === "image" && a.previewUrl)
    .map((a) => ({ src: a.previewUrl!, alt: a.filename }));
  openLightbox(images, imageRank.value.get(attachmentIndex) ?? 0);
}
</script>
<template>
  <div class="mt-1 flex flex-wrap gap-2">
    <template v-for="(a, i) in attachments" :key="a.id">
      <button
        v-if="a.kind === 'image' && a.previewUrl"
        type="button"
        data-test="att-image"
        class="cursor-zoom-in overflow-hidden rounded-lg border border-border transition-opacity hover:opacity-85"
        :aria-label="`${$t('chat.lightboxOpen')}: ${a.filename}`"
        :title="$t('chat.lightboxOpen')"
        @click="openAt(i)"
      >
        <img
          :src="a.previewUrl"
          :alt="a.filename"
          class="block max-h-40 max-w-[200px] object-cover"
          loading="lazy"
        />
      </button>
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
