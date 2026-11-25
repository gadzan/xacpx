<script setup lang="ts">
/**
 * Placeholder rows for a conversation whose first page is still in flight.
 *
 * Shared by the session transcript (MessageList) and the Bot/Group timeline
 * (ConversationTimeline) so both surfaces settle the same way: the pane never
 * shows "no messages yet" while it still does not know whether that is true.
 *
 * Alternates agent rows and the reader's own bubbles with varied widths, so the
 * placeholder reads as a conversation rather than a form. Each row carries its
 * own --sk-delay, so the pulse cascades top-to-bottom instead of breathing in
 * unison (see .sk-bar in style.css).
 */
const ROWS = [
  { kind: "agent", w: "64%", lines: 2 },
  { kind: "own", w: "44%", lines: 1 },
  { kind: "agent", w: "82%", lines: 2 },
  { kind: "own", w: "58%", lines: 2 },
  { kind: "agent", w: "38%", lines: 1 },
] as const;
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-5">
    <template v-for="(row, i) in ROWS" :key="i">
      <div v-if="row.kind === 'own'" class="flex justify-end" :style="{ '--sk-delay': `${i * 160}ms` }">
        <div class="space-y-1.5 rounded-2xl rounded-tr-sm bg-accent-soft px-3.5 py-2.5" :style="{ width: row.w }">
          <div
            v-for="n in row.lines"
            :key="n"
            class="sk-bar h-3 rounded-sm bg-accent/15"
            :style="{ width: n === row.lines ? '58%' : '100%' }"
          />
        </div>
      </div>
      <div v-else class="flex gap-3" :style="{ '--sk-delay': `${i * 160}ms` }">
        <div class="sk-bar mt-0.5 h-8 w-8 shrink-0 rounded-full bg-fg/10" />
        <div class="min-w-0 flex-1 space-y-2 py-1">
          <div
            v-for="n in row.lines"
            :key="n"
            class="sk-bar h-3 rounded-sm bg-fg/10"
            :style="{ width: n === row.lines ? row.w : '100%' }"
          />
        </div>
      </div>
    </template>
  </div>
</template>
