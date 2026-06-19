<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { MessageSquare, Search } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";

const emit = defineEmits<{
  close: [];
  "select-session": [instanceId: string, alias: string];
}>();

const instances = useInstancesStore();
const query = ref("");
const input = ref<HTMLInputElement | null>(null);
const active = ref(0);

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
      label: s.alias,
      sub: `${inst.name} · ${s.agent}`,
      instanceId: inst.id,
      alias: s.alias,
    })),
  ),
);

function matches(row: Row, q: string): boolean {
  if (!q) return true;
  const hay = `${row.label} ${row.sub}`.toLowerCase();
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
  if (e.key === "Escape") { emit("close"); return; }
  if (e.key === "ArrowDown") { e.preventDefault(); active.value = Math.min(active.value + 1, rows.value.length - 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); active.value = Math.max(active.value - 1, 0); }
  else if (e.key === "Enter") { e.preventDefault(); const r = rows.value[active.value]; if (r) choose(r); }
}

onMounted(() => void nextTick(() => input.value?.focus()));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24" data-test="command-palette" @click.self="emit('close')">
    <div class="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-raised shadow-xl">
      <div class="flex items-center gap-2 border-b border-border px-4 py-3">
        <Search :size="16" class="shrink-0 text-fg-muted" />
        <input ref="input" v-model="query" data-test="palette-input"
               :placeholder='$t("palette.placeholder")'
               class="w-full bg-transparent text-sm text-fg placeholder:text-fg-muted outline-none"
               @input="active = 0; clampActive()" @keydown="onKeydown" />
      </div>
      <ul class="max-h-80 overflow-y-auto py-1 text-sm">
        <li v-for="(r, i) in rows" :key="`${r.instanceId}:${r.alias}:${i}`">
          <button data-test="palette-row" class="flex w-full items-center gap-2 px-4 py-1.5 text-left"
                  :class="i === active ? 'bg-accent/10 text-accent' : 'text-fg hover:bg-fg/5'"
                  @mouseenter="active = i" @click="choose(r)">
            <MessageSquare :size="14" class="shrink-0" />
            <span class="font-medium">{{ r.label }}</span>
            <span class="truncate text-xs text-fg-muted">{{ r.sub }}</span>
          </button>
        </li>
        <li v-if="!rows.length" class="px-4 py-3 text-xs text-fg-muted">{{ $t("palette.noMatches") }}</li>
      </ul>
    </div>
  </div>
</template>
