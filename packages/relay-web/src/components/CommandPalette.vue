<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { MessageSquare, Search } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import { navigateBack, pushModal } from "../lib/mobile-back";

const emit = defineEmits<{
  close: [];
  "select-session": [instanceId: string, alias: string];
}>();

const instances = useInstancesStore();
const query = ref("");
const input = ref<HTMLInputElement | null>(null);
const active = ref(0);

// The palette is a masked overlay, so it owns a history entry while open: the Android
// back key and the iOS swipe dismiss it instead of leaving the site.
let unregister: (() => void) | null = null;

interface Row {
  label: string;
  sub: string;
  instanceId: string;
  alias: string;
}

// All sessions across instances, flattened to palette rows. The dashboard is
// GUI-first, so the palette is session navigation only — xacpx slash commands are
// no longer surfaced here (anything typed in the composer is forwarded to the agent).
const sessionRows = computed<Row[]>(() =>
  instances.instances.flatMap((inst) =>
    inst.sessions.map((s) => ({
      label: s.displayName || s.alias,
      sub: `${inst.name} · ${s.agent}`,
      instanceId: inst.id,
      alias: s.alias,
    })),
  ),
);

function matches(row: Row, q: string): boolean {
  if (!q) return true;
  const hay = `${row.label} ${row.sub} ${row.alias}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

const rows = computed<Row[]>(() => {
  const q = query.value.trim();
  return sessionRows.value.filter((r) => matches(r, q));
});

function clampActive() {
  if (active.value >= rows.value.length) active.value = Math.max(0, rows.value.length - 1);
}

function choose(row: Row) {
  emit("select-session", row.instanceId, row.alias);
  emit("close");
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") { navigateBack(); return; }
  else if (e.key === "ArrowDown") { e.preventDefault(); active.value = Math.min(active.value + 1, rows.value.length - 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); active.value = Math.max(active.value - 1, 0); }
  else if (e.key === "Enter") { e.preventDefault(); const r = rows.value[active.value]; if (r) choose(r); }
}

onMounted(() => {
  unregister = pushModal({ id: "palette", close: () => emit("close") });
  void nextTick(() => input.value?.focus());
});
onBeforeUnmount(() => { unregister?.(); unregister = null; });
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-24 backdrop-blur-sm" data-test="command-palette" @click.self="navigateBack">
    <div class="w-full max-w-lg overflow-hidden rounded-2xl bg-glass-strong shadow-glass-float backdrop-blur-glass backdrop-saturate-glass">
      <div class="flex min-h-12 items-center gap-2 px-4">
        <Search :size="16" class="shrink-0 text-fg-muted-overlay" />
        <input ref="input" v-model="query" data-test="palette-input" data-ring="container"
               class="w-full bg-transparent text-sm text-fg placeholder:text-fg-muted-overlay outline-none"
               @input="active = 0; clampActive()" @keydown="onKeydown" />
      </div>
      <ul class="max-h-80 overflow-y-auto p-1 text-ui">
        <li v-for="(r, i) in rows" :key="`${r.instanceId}:${r.alias}:${i}`">
          <button data-test="palette-row" class="flex min-h-12 w-full items-center gap-2 rounded-item px-4 py-1.5 text-left"
                  :class="i === active ? 'bg-fill-strong text-fg' : 'text-fg hover:bg-fill-hover'"
                  @mouseenter="active = i" @click="choose(r)">
            <MessageSquare :size="14" class="shrink-0" />
            <span class="font-medium">{{ r.label }}</span>
            <span class="truncate text-xs text-fg-muted-overlay">{{ r.sub }}</span>
          </button>
        </li>
        <li v-if="!rows.length" class="px-4 py-3 text-xs text-fg-muted-overlay">{{ $t("palette.noMatches") }}</li>
      </ul>
    </div>
  </div>
</template>
