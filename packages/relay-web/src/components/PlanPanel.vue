<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { Circle, Loader2, CheckCircle2, ChevronDown, ChevronRight } from "lucide-vue-next";
import type { PlanEntryDto } from "@ganglion/xacpx-relay-protocol";

// `active` defaults to `undefined` (not Vue's Boolean-cast `false`) so an unspecified prop
// leaves the panel expanded and the auto expand/collapse watch dormant.
// `variant: "side"` renders in the wide-screen column right of the message list: the
// `max-h-48` cap is dropped and the list flexes to the column height instead.
const props = withDefaults(
  defineProps<{ entries: PlanEntryDto[]; active?: boolean; variant?: "inline" | "side" }>(),
  { active: undefined, variant: "inline" },
);
const expanded = ref(props.active ?? true);
const listEl = ref<HTMLUListElement | null>(null);
const done = computed(() => props.entries.filter((e) => e.status === "completed").length);
const activeIndex = computed(() => {
  let idx = -1;
  props.entries.forEach((e, i) => { if (e.status === "in_progress") idx = i; });
  if (idx >= 0) return idx;
  props.entries.forEach((e, i) => { if (e.status === "completed") idx = i; });
  return idx >= 0 ? idx : props.entries.length - 1;
});
const iconOf = (s: PlanEntryDto["status"]) =>
  s === "completed" ? CheckCircle2 : s === "in_progress" ? Loader2 : Circle;
const clsOf = (s: PlanEntryDto["status"]) =>
  s === "completed" ? "text-run" : s === "in_progress" ? "text-accent" : "text-fg-muted";

async function scrollToActive() {
  if (!expanded.value) return;
  await nextTick();
  const ul = listEl.value;
  if (!ul) return;
  const li = ul.children[activeIndex.value] as HTMLElement | undefined;
  li?.scrollIntoView?.({ block: "nearest" });
}
watch(() => props.entries, scrollToActive, { flush: "post" });
watch(expanded, scrollToActive);
// Expand while a turn runs and collapse when it ends, without breaking manual toggle.
// When `active` is unset (e.g. some tests) the watch never fires and expanded keeps its default.
watch(() => props.active, (a) => { if (a !== undefined) expanded.value = a; });
</script>

<template>
  <div v-if="entries.length" data-test="plan-panel"
       :class="['rounded-md border border-border bg-surface p-2 text-sm', variant === 'side' ? 'flex min-h-0 max-h-full flex-col' : '']">
    <button
      type="button"
      data-test="plan-toggle"
      :aria-expanded="expanded"
      aria-controls="plan-list"
      :aria-label="$t('plan.togglePlan')"
      class="mb-1 flex w-full items-center gap-1.5 text-xs font-semibold uppercase text-fg-muted hover:text-fg transition-colors"
      @click="expanded = !expanded"
    >
      <ChevronDown v-if="expanded" :size="12" class="shrink-0" />
      <ChevronRight v-else :size="12" class="shrink-0" />
      {{ $t("plan.title") }}
      <span class="ml-auto font-mono tabular-nums">{{ done }}/{{ entries.length }}</span>
    </button>
    <ul v-show="expanded" id="plan-list" ref="listEl"
        :class="['overflow-y-auto thin-scroll space-y-0.5', variant === 'side' ? 'min-h-0 flex-1' : 'max-h-48']">
      <li
        v-for="(e, i) in entries"
        :key="i"
        :data-test="i === activeIndex ? 'plan-active' : undefined"
        class="flex items-start gap-1.5"
      >
        <component :is="iconOf(e.status)" :size="13" :class="[clsOf(e.status), 'mt-0.5 shrink-0', e.status === 'in_progress' ? 'animate-spin motion-reduce:animate-none' : '']" />
        <span :class="['min-w-0', e.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg']">{{ e.content }}</span>
      </li>
    </ul>
  </div>
</template>
