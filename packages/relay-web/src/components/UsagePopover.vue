<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { computeCalloutPlacement, type Rect } from "../lib/fue-placement";

type Cost = { amount?: number; currency?: string };
type Breakdown = {
  inputTokens?: number; outputTokens?: number; cachedReadTokens?: number;
  cachedWriteTokens?: number; thoughtTokens?: number; totalTokens?: number;
};
const props = defineProps<{
  used: number; size: number; pct: number; cost?: Cost; breakdown?: Breakdown; anchor?: Rect | null;
}>();
const emit = defineEmits<{ dismiss: [] }>();

const card = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({ visibility: "hidden" });

const breakdownRows = [
  { key: "inputTokens", label: "chat.usage.input" },
  { key: "outputTokens", label: "chat.usage.output" },
  { key: "cachedReadTokens", label: "chat.usage.cacheRead" },
  { key: "cachedWriteTokens", label: "chat.usage.cacheWrite" },
  { key: "thoughtTokens", label: "chat.usage.thinking" },
  { key: "totalTokens", label: "chat.usage.total" },
] as const;

function num(v: number | undefined): string | null {
  return typeof v === "number" ? v.toLocaleString() : null;
}
function costText(): string | null {
  const a = props.cost?.amount;
  if (typeof a !== "number") return null;
  const cur = props.cost?.currency;
  try {
    if (cur) return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 4 }).format(a);
  } catch { /* unknown currency code → fall through to plain number */ }
  return cur ? `${a} ${cur}` : String(a);
}

function reposition(): void {
  const el = card.value;
  if (!el) return;
  const size = { width: el.offsetWidth || 240, height: el.offsetHeight || 160 };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (props.anchor) {
    const p = computeCalloutPlacement(props.anchor, size, viewport);
    style.value = { top: `${p.top}px`, left: `${p.left}px`, visibility: "visible" };
  } else {
    style.value = {
      top: `${Math.max(8, viewport.height / 2 - size.height / 2)}px`,
      left: `${Math.max(8, viewport.width / 2 - size.width / 2)}px`,
      visibility: "visible",
    };
  }
}
function onKey(e: KeyboardEvent): void { if (e.key === "Escape") emit("dismiss"); }
function onDocPointer(e: PointerEvent): void {
  if (card.value && !card.value.contains(e.target as Node)) emit("dismiss");
}

onMounted(() => {
  reposition();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", reposition);
  // Defer the outside-click listener so the opening click doesn't immediately dismiss.
  setTimeout(() => document.addEventListener("pointerdown", onDocPointer), 0);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", reposition);
  document.removeEventListener("pointerdown", onDocPointer);
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="card"
      data-test="usage-popover"
      class="fixed z-[60] w-60 rounded-lg border border-border bg-raised p-3 text-sm shadow-e2"
      :style="style"
      role="dialog"
    >
      <p class="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("chat.usage.contextWindow") }}</p>
      <div class="flex items-baseline justify-between tabular-nums">
        <span class="text-fg">{{ used.toLocaleString() }} / {{ size.toLocaleString() }}</span>
        <span class="text-fg-muted">{{ pct }}%</span>
      </div>

      <template v-if="breakdown">
        <p class="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("chat.usage.tokens") }}</p>
        <dl class="space-y-0.5">
          <template v-for="row in breakdownRows" :key="row.key">
            <div v-if="num((breakdown as Record<string, number | undefined>)[row.key]) !== null" class="flex justify-between tabular-nums">
              <dt class="text-fg-muted">{{ $t(row.label) }}</dt>
              <dd class="text-fg">{{ num((breakdown as Record<string, number | undefined>)[row.key]) }}</dd>
            </div>
          </template>
        </dl>
      </template>

      <template v-if="costText() !== null">
        <p class="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{{ $t("chat.usage.cost") }}</p>
        <div class="flex justify-between tabular-nums">
          <span class="text-fg-muted">{{ $t("chat.usage.cumulative") }}</span>
          <span class="text-fg">{{ costText() }}</span>
        </div>
      </template>
    </div>
  </Teleport>
</template>
