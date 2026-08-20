<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X, Folder, Home, ArrowUp, Loader2 } from "lucide-vue-next";
import { isErrorPayload, type FsBrowseResult } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { useModalA11y } from "../lib/use-modal-a11y";

// System-style directory picker that browses the TARGET INSTANCE's filesystem
// via control.fs.browse (the instance may be a remote machine — that's why the
// browser's native showDirectoryPicker can't be used). Not workspace-scoped:
// its whole purpose is choosing a cwd for a workspace that doesn't exist yet.
const props = defineProps<{ instanceId: string; initialPath?: string }>();
const emit = defineEmits<{ confirm: [path: string]; close: [] }>();
const { t } = useI18n();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

function unwrap<T>(result: T | { error: { code: string; message: string } }): T {
  if (isErrorPayload(result)) throw new Error(result.error.message || result.error.code);
  return result;
}

const result = ref<FsBrowseResult | null>(null);
const pathInput = ref("");
const loading = ref(false);
const error = ref("");
const showHidden = ref(false); // reset per open; not persisted
const highlight = ref(0);

let seq = 0;
async function navigate(p: string): Promise<void> {
  const mine = ++seq;
  loading.value = true;
  error.value = "";
  try {
    const r = unwrap(await api.rpc<FsBrowseResult>(
      props.instanceId, "control.fs.browse", p ? { path: p } : {},
    ));
    if (mine !== seq) return; // superseded by a newer navigation
    result.value = r;
    pathInput.value = r.path;
    highlight.value = 0;
  } catch (e) {
    if (mine !== seq) return;
    error.value = e instanceof Error ? e.message : t("dirPicker.loadFailed");
  } finally {
    if (mine === seq) loading.value = false;
  }
}
onMounted(() => void navigate(props.initialPath ?? ""));

const visibleDirs = computed(() => {
  const dirs = result.value?.dirs ?? [];
  return showHidden.value ? dirs : dirs.filter((d) => !d.name.startsWith("."));
});

// Breadcrumbs: cumulative joins of the path segments (POSIX root "/" yields
// ["", "home", …] filtered to segment labels; each crumb navigates on click).
const crumbs = computed(() => {
  const r = result.value;
  if (!r) return [];
  const parts = r.path.split(r.sep).filter(Boolean);
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join(r.sep) }));
});

function submitPath(): void {
  const p = pathInput.value.trim();
  if (p) void navigate(p);
}
function up(): void {
  const parent = result.value?.parent;
  if (parent) void navigate(parent);
}
function home(): void {
  const h = result.value?.home;
  if (h) void navigate(h);
}
function choose(): void {
  if (!result.value) return;
  emit("confirm", result.value.path);
  emit("close");
}
function onListKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlight.value = Math.min(highlight.value + 1, visibleDirs.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    highlight.value = Math.max(highlight.value - 1, 0);
  } else if (e.key === "Enter") {
    const d = visibleDirs.value[highlight.value];
    if (d) { e.preventDefault(); void navigate(d.path); }
  } else if (e.key === "Backspace") {
    e.preventDefault();
    up();
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
      <div ref="dialogEl" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="dp-title"
           class="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-border bg-raised shadow-xl focus:outline-none"
           data-test="dp-dialog">
        <header class="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id="dp-title" class="text-sm font-semibold text-fg">{{ $t("dirPicker.title") }}</h2>
          <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label='$t("session.close")'
                  @click="emit('close')"><X :size="16" /></button>
        </header>

        <div class="flex items-center gap-1.5 px-5 pt-3">
          <input v-model="pathInput" data-test="dp-path" :placeholder='$t("dirPicker.pathPlaceholder")'
                 class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                 @keydown.enter.prevent="submitPath" />
          <button type="button" data-test="dp-home" :title='$t("dirPicker.home")' :aria-label='$t("dirPicker.home")'
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-fg-muted hover:bg-fg/5 hover:text-fg"
                  @click="home"><Home :size="14" /></button>
          <button type="button" data-test="dp-up" :title='$t("dirPicker.up")' :aria-label='$t("dirPicker.up")'
                  :disabled="!result?.parent"
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-fg-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
                  @click="up"><ArrowUp :size="14" /></button>
        </div>

        <nav v-if="crumbs.length" class="flex flex-wrap gap-0.5 px-5 pt-2 text-xs text-fg-muted" aria-label="breadcrumb">
          <button v-for="c in crumbs" :key="c.path" type="button"
                  class="rounded px-1 hover:bg-fg/5 hover:text-fg" @click="navigate(c.path)">{{ c.label }}</button>
        </nav>

        <div class="mt-2 min-h-[12rem] flex-1 overflow-y-auto border-y border-border px-2 py-1"
             role="listbox" :aria-label='$t("dirPicker.title")' tabindex="0" @keydown="onListKeydown">
          <div v-if="loading" class="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
            <Loader2 :size="16" class="animate-spin" /> {{ $t("session.loadingOptions") }}
          </div>
          <template v-else>
            <button v-for="(d, i) in visibleDirs" :key="d.path" type="button" role="option"
                    :data-test="`dp-dir-${d.name}`" :aria-selected="i === highlight"
                    class="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm"
                    :class="i === highlight ? 'bg-accent/15 text-fg' : 'text-fg hover:bg-fg/5'"
                    @click="navigate(d.path)" @mousemove="highlight = i">
              <Folder :size="14" class="shrink-0 text-fg-muted" />
              <span class="truncate font-mono text-xs">{{ d.name }}</span>
            </button>
            <p v-if="!visibleDirs.length" class="py-8 text-center text-sm text-fg-muted">{{ $t("dirPicker.empty") }}</p>
            <p v-if="result?.truncated" data-test="dp-truncated" class="px-3 py-2 text-xs italic text-fg-muted">
              {{ $t("dirPicker.truncated") }}
            </p>
          </template>
        </div>

        <label class="flex items-center gap-2 px-5 pt-2 text-xs text-fg-muted">
          <input v-model="showHidden" data-test="dp-show-hidden" type="checkbox" class="accent-accent" />
          {{ $t("dirPicker.showHidden") }}
        </label>
        <p v-if="error" data-test="dp-error" class="mx-5 mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{{ error }}</p>

        <footer class="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button class="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5" @click="emit('close')">{{ $t("common.cancel") }}</button>
          <button data-test="dp-confirm" :disabled="!result"
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-hover disabled:opacity-40"
                  @click="choose">{{ $t("dirPicker.chooseCurrent") }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
