<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolStepDto } from "@ganglion/xacpx-relay-protocol";
import { AlertTriangle, Bot, Check, Loader2, X } from "lucide-vue-next";
import ToolDetail from "./ToolDetail.vue";
import ToolStepCard from "./ToolStepCard.vue";
import { useModalA11y } from "../lib/use-modal-a11y";
import { resolveSubagentStatus } from "../lib/subagent-status";
import { indexToolSteps, toolStepDepthWithin } from "../lib/subagent-trace";

const props = defineProps<{ step: ToolStepDto; children: ToolStepDto[] }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);
const status = computed(() => resolveSubagentStatus(props.step, props.children));
const traceRows = computed(() => {
  const byId = indexToolSteps([props.step, ...props.children]);
  return props.children.map((child) => ({
    step: child,
    depth: toolStepDepthWithin(child, props.step.toolCallId, byId),
  }));
});
useModalA11y(dialog, () => emit("close"));
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[90] flex items-center justify-center p-3 sm:p-6" data-test="subagent-trace-dialog">
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="emit('close')" />
      <section ref="dialog" role="dialog" aria-modal="true" tabindex="-1"
               aria-labelledby="subagent-trace-title"
               class="relative flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-e3">
        <header class="relative shrink-0 overflow-hidden border-b border-border px-5 py-4 sm:px-6">
          <div class="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/10 via-transparent to-run/5" />
          <div class="relative flex items-start gap-3">
            <div class="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
              <Bot :size="20" />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-accent">
                  {{ $t("tools.subagent") }}
                </span>
                <span class="inline-flex items-center gap-1 text-[11px] text-fg-muted">
                  <Loader2 v-if="status === 'running'" :size="12" class="animate-spin motion-reduce:animate-none text-accent" />
                  <AlertTriangle v-else-if="status === 'error'" :size="12" class="text-danger" />
                  <Check v-else :size="12" class="text-run" />
                  {{ status === "running" ? $t("tools.running") : status === "error" ? $t("tools.failed") : $t("tools.finished") }}
                </span>
              </div>
              <h2 id="subagent-trace-title" class="mt-1.5 truncate text-[16px] font-semibold text-fg">{{ step.title }}</h2>
              <p class="mt-0.5 text-[11px] text-fg-muted">{{ $t("tools.traceCount", { count: children.length }) }}</p>
            </div>
            <button type="button" data-test="subagent-dialog-close" :aria-label="$t('common.dismiss')"
                    class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-fg/5 hover:text-fg"
                    @click="emit('close')">
              <X :size="17" />
            </button>
          </div>
        </header>

        <div class="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          <section v-if="step.detail" class="mb-5 rounded-xl border border-border bg-bg/60 p-3">
            <p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-muted">{{ $t("tools.delegatedTask") }}</p>
            <ToolDetail :detail="step.detail" />
          </section>
          <div v-if="traceRows.length" class="space-y-2.5">
            <div v-for="row in traceRows" :key="row.step.toolCallId"
                 class="border-l border-border/70 pl-2"
                 :style="{ marginLeft: `${row.depth * 16}px` }">
              <ToolStepCard :step="row.step" />
            </div>
          </div>
          <div v-else class="grid min-h-36 place-items-center rounded-xl border border-dashed border-border bg-bg/40 text-center">
            <div>
              <Loader2 :size="18" class="mx-auto animate-spin motion-reduce:animate-none text-accent" />
              <p class="mt-2 text-[12px] text-fg-muted">{{ $t("tools.waitingForActivity") }}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
