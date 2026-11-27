<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Folder, Home, ArrowUp } from "lucide-vue-next";
import { isErrorPayload, type FsBrowseResult } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import DialogShell from "./DialogShell.vue";
import UiButton from "./UiButton.vue";
import { navigateBack } from "../lib/mobile-back";

// System-style directory picker that browses the TARGET INSTANCE's filesystem
// via control.fs.browse (the instance may be a remote machine — that's why the
// browser's native showDirectoryPicker can't be used). Not workspace-scoped:
// its whole purpose is choosing a cwd for a workspace that doesn't exist yet.
const props = defineProps<{ instanceId: string; initialPath?: string }>();
const emit = defineEmits<{ confirm: [path: string]; close: [] }>();
const { t } = useI18n();

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
    // Realign the editable path box with the still-current directory: the failed
    // target (e.g. a typo) must not stay displayed while confirm submits the old
    // listing's path - what the user sees must be what confirm would submit.
    if (result.value) pathInput.value = result.value.path;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
onMounted(() => void navigate(props.initialPath ?? ""));

const visibleDirs = computed(() => {
  const dirs = result.value?.dirs ?? [];
  return showHidden.value ? dirs : dirs.filter((d) => !d.name.startsWith("."));
});

// Breadcrumbs: cumulative ABSOLUTE paths — the daemon resolves relatives against
// homedir, so a crumb must carry its full path. POSIX root "/" splits to
// ["", "home", …] (empties filtered for labels) and re-prefixed with "/"; on
// Windows the first crumb is the bare drive root ("C:\\"), later crumbs are
// joined cumulative segments ("C:\\Users\\me").
const crumbs = computed(() => {
  const r = result.value;
  if (!r) return [];
  const parts = r.path.split(r.sep).filter(Boolean);
  return parts.map((label, i) => ({
    label,
    path: r.sep === "\\"
      ? (i === 0 ? parts[0] + "\\" : parts.slice(0, i + 1).join("\\"))
      : "/" + parts.slice(0, i + 1).join("/"),
  }));
});

// Toggling hidden dirs off can shrink the list under the highlighted index —
// clamp so Enter never silently no-ops on a stale highlight.
watch(visibleDirs, (v) => {
  if (highlight.value >= v.length) highlight.value = 0;
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
  // A pending navigation leaves `result` at the OLD listing - confirming then
  // would silently submit the stale directory. Inert until it settles.
  if (loading.value || !result.value) return;
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
  <DialogShell
    panel-class="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl focus:outline-none"
    labelledby="dp-title"
    test-id="dp-dialog"
    level="nested"
    @close="emit('close')"
  >
        <header class="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h2 id="dp-title" class="text-base font-semibold text-fg">{{ $t("dirPicker.title") }}</h2>
          <button type="button" class="rounded-sm p-1 text-fg-muted-overlay hover:bg-fill-hover hover:text-fg" :aria-label='$t("session.close")'
                  @click="navigateBack"><X :size="16" /></button>
        </header>

        <div class="flex items-center gap-1.5 px-5 pt-3">
          <input v-model="pathInput" data-test="dp-path" :placeholder='$t("dirPicker.pathPlaceholder")'
                 class="min-w-0 flex-1 rounded-lg ui-well px-3 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                 @keydown.enter.prevent="submitPath" />
          <button type="button" data-test="dp-home" :title='$t("dirPicker.home")' :aria-label='$t("dirPicker.home")'
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-fg/5 hover:text-fg"
                  @click="home"><Home :size="14" /></button>
          <button type="button" data-test="dp-up" :title='$t("dirPicker.up")' :aria-label='$t("dirPicker.up")'
                  :disabled="!result?.parent"
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-fg-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40"
                  @click="up"><ArrowUp :size="14" /></button>
        </div>

        <nav v-if="crumbs.length" class="flex flex-wrap gap-0.5 px-5 pt-2 text-xs text-fg-muted" aria-label="breadcrumb">
          <button v-for="c in crumbs" :key="c.path" type="button"
                  class="rounded-sm px-1 hover:bg-fg/5 hover:text-fg" @click="navigate(c.path)">{{ c.label }}</button>
        </nav>

        <div class="mt-2 min-h-[12rem] flex-1 overflow-y-auto px-2 py-1"
             role="listbox" :aria-label='$t("dirPicker.title")' tabindex="0" @keydown="onListKeydown">
          <!-- Five folder rows: the list keeps its row height, so the real entries land in place. -->
        <div v-if="loading" role="status" :aria-label="$t('session.loadingOptions')" class="space-y-0.5 px-1 py-1">
          <div v-for="(w, i) in [34, 52, 44, 60, 30]" :key="i" class="flex items-center gap-2 px-2 py-1.5"
               :style="{ '--sk-delay': `${i * 90}ms` }">
            <span class="sk-bar h-3.5 w-3.5 shrink-0 rounded-sm bg-fg/[0.08]" />
            <span class="sk-bar h-3 rounded-sm bg-fg/[0.06]" :style="{ width: `${w}%` }" />
          </div>
        </div>
          <template v-else>
            <button v-for="(d, i) in visibleDirs" :key="d.path" type="button" role="option"
                    :data-test="`dp-dir-${d.name}`" :aria-selected="i === highlight"
                    class="flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-left text-sm"
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
        <p v-if="error" data-test="dp-error" class="mx-5 mt-2 rounded-lg bg-danger/[0.08] px-3 py-2 text-xs text-danger-overlay">{{ error }}</p>

        <footer class="flex justify-end gap-2 border-t border-hairline bg-bg/30 px-5 py-3">
          <UiButton variant="secondary" @click="navigateBack">{{ $t("common.cancel") }}</UiButton>
          <UiButton data-test="dp-confirm" :disabled="!result || loading" @click="choose">
            {{ $t("dirPicker.chooseCurrent") }}
          </UiButton>
        </footer>
  </DialogShell>
  </Teleport>
</template>
