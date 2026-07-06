<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { ArrowLeft, FileText, FileDiff, X, Search, Pencil, Save as SaveIcon } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useFilesStore } from "../stores/files";
import type { FsDiffResult, FsReadResult } from "@ganglion/xacpx-relay-protocol";
import CodeEditor from "./CodeEditor.vue";
import { parseUnifiedDiff } from "../lib/unified-diff";
import CopyButton from "./CopyButton.vue";
import { draftKey, loadFileDraft, saveFileDraft, clearFileDraft } from "../lib/file-drafts";
import { createDebouncedFlush } from "../lib/debounce-flush";

// Roomy file/diff viewer that takes over the center column. A single CodeMirror instance
// (CodeEditor) renders file content for BOTH read and edit — read is editable:false, the
// pencil flips it to editable:true. The write path (save/stale/dirty/close-guard) is
// unchanged from the file-edit-save feature; only the render substrate is CodeMirror now.
const props = defineProps<{
  instanceId: string;
  workspace: string;
  path?: string;
  diffPath?: string;
  line?: number;
  lineRev?: number;
  sessionKey?: string;
}>();
const emit = defineEmits<{ back: []; close: []; "dirty-change": [boolean] }>();
const { t } = useI18n();
const files = useFilesStore();

const rootEl = ref<HTMLElement | null>(null);
const codeEditor = ref<InstanceType<typeof CodeEditor> | null>(null);

const file = ref<FsReadResult | null>(null);
const diff = ref<FsDiffResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// The editor buffer. Equals file.content in read mode; diverges while editing.
const content = ref("");

let loadToken = 0;
async function load(): Promise<void> {
  const token = ++loadToken;
  const { instanceId, workspace, path, diffPath } = props;
  loading.value = true;
  error.value = null;
  try {
    if (path) {
      const result = await files.readFile(instanceId, workspace, path);
      if (token !== loadToken) return;
      file.value = result;
      diff.value = null;
      content.value = result.binary ? "" : result.content;
      editing.value = false;
      emit("dirty-change", false);
      // Restore a persisted edit draft: enter edit mode with the saved buffer. Only when the
      // draft differs from disk (equal ⇒ nothing to restore) and the file is actually editable
      // (a truncated / mtime-less file can't be saved). Staleness isn't checked here — the
      // existing save-time mtime guard (baseRev) catches a disk that changed while away.
      if (!result.binary && !result.truncated && typeof result.mtimeMs === "number") {
        const draft = loadFileDraft(draftKey(props.sessionKey ?? "", path));
        if (draft !== null && draft !== result.content) {
          baseRev.value = { mtimeMs: result.mtimeMs, size: result.size };
          content.value = draft;
          editing.value = true;
        }
      }
    } else if (diffPath) {
      const result = await files.readDiff(instanceId, workspace, diffPath);
      if (token !== loadToken) return;
      diff.value = result;
      file.value = null;
    } else {
      file.value = null;
      diff.value = null;
    }
  } catch (e) {
    if (token !== loadToken) return;
    file.value = null;
    diff.value = null;
    error.value = e instanceof Error ? e.message : "read-failed";
  } finally {
    if (token === loadToken) loading.value = false;
  }
}
watch(() => [props.instanceId, props.workspace, props.path, props.diffPath] as const, load, { immediate: true });

const parsedDiff = computed(() => (diff.value?.diff ? parseUnifiedDiff(diff.value.diff) : null));

function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Edit mode ────────────────────────────────────────────────────────────────────────
const editing = ref(false);
const baseRev = ref<{ mtimeMs: number; size: number } | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const showEditor = computed(() => !!file.value && !file.value.binary);
const canEdit = computed(
  () => !!file.value && !file.value.binary && !file.value.truncated && typeof file.value.mtimeMs === "number",
);
const editDirty = computed(() => editing.value && !!file.value && content.value !== file.value.content);
watch(editDirty, (v) => emit("dirty-change", v));

// Persist the edit buffer while editing so a reload can restore it. Clearing the edits back to
// disk content removes the key (empty store). Only writes in edit mode with a real path.
// Writes are debounced (each one re-parses + re-stringifies the whole draft map), with a
// synchronous flush on pagehide/unmount so a reload right after typing still restores the
// very last edits. Key + buffer + disk content are captured at schedule time, so a write
// firing after a tab switch still lands under the file it was typed into.
let pendingEditDraft: { key: string; text: string; disk: string } | null = null;
const editDraftPersist = createDebouncedFlush(() => {
  const p = pendingEditDraft;
  pendingEditDraft = null;
  if (!p) return;
  if (p.text !== p.disk) saveFileDraft(p.key, p.text);
  else clearFileDraft(p.key);
}, 300);
function cancelPendingEditDraft(): void {
  pendingEditDraft = null;
  editDraftPersist.cancel();
}
watch(content, (val) => {
  if (!editing.value || !props.path || !file.value) return;
  pendingEditDraft = { key: draftKey(props.sessionKey ?? "", props.path), text: val, disk: file.value.content };
  editDraftPersist.schedule();
});
function flushEditDraft(): void {
  editDraftPersist.flush();
}
onMounted(() => window.addEventListener("pagehide", flushEditDraft));
onBeforeUnmount(() => {
  window.removeEventListener("pagehide", flushEditDraft);
  flushEditDraft();
});

const saveErrorLabel = computed(() => {
  const code = saveError.value;
  if (!code) return "";
  const known: Record<string, string> = {
    "stale-write": t("files.staleConflict"),
    "files-write-disabled": t("files.writeDisabled"),
    "is-binary": t("files.binaryNotEditable"),
    "file-too-large": t("files.tooLarge"),
  };
  return known[code] ?? code;
});
const isStale = computed(() => saveError.value === "stale-write");

function startEdit() {
  if (!canEdit.value || !file.value) return;
  baseRev.value = { mtimeMs: file.value.mtimeMs, size: file.value.size };
  saveError.value = null;
  editing.value = true;
}
function cancelEdit() {
  if (file.value) content.value = file.value.content; // revert the buffer
  editing.value = false;
  baseRev.value = null;
  saveError.value = null;
  emit("dirty-change", false);
  cancelPendingEditDraft(); // a late debounced write must not resurrect the cleared draft
  if (props.path) clearFileDraft(draftKey(props.sessionKey ?? "", props.path));
}
async function save() {
  if (!editing.value) return;
  if (saving.value) return;
  if (!file.value || !baseRev.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const res = await files.saveFile(props.instanceId, props.workspace, file.value.path, content.value, baseRev.value);
    file.value = { ...file.value, content: content.value, size: res.size, mtimeMs: res.mtimeMs };
    editing.value = false;
    baseRev.value = null;
    emit("dirty-change", false);
    cancelPendingEditDraft(); // the buffer just became disk content — drop the stale write
    if (props.path) clearFileDraft(draftKey(props.sessionKey ?? "", props.path));
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : "write-failed";
  } finally {
    saving.value = false;
  }
}
// Stale reload: re-read for a fresh token but KEEP the user's edited buffer so they can
// reconcile (do NOT call load(), which would reset `content`).
async function reloadFromDisk() {
  if (!file.value) return;
  try {
    const fresh = await files.readFile(props.instanceId, props.workspace, file.value.path);
    file.value = fresh;
    baseRev.value = { mtimeMs: fresh.mtimeMs, size: fresh.size };
    saveError.value = null;
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : "read-failed";
  }
}

function openSearch() { codeEditor.value?.openSearch(); }

// Cmd/Ctrl-F opens the editor's search panel; Cmd/Ctrl-S saves — both only in the VISIBLE
// pane (every open tab has a mounted, v-show-hidden FileViewer; offsetParent is null while
// hidden, so hidden panes ignore the shortcut).
function onKeydown(e: KeyboardEvent) {
  const visible = !!rootEl.value && rootEl.value.offsetParent !== null;
  if (!visible) return;
  if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S") && editing.value) {
    e.preventDefault();
    void save();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F") && showEditor.value) {
    const tgt = e.target as HTMLElement | null;
    // Avoid stealing Cmd/Ctrl-F from OTHER form fields (e.g. the right-rail file search input).
    // CodeMirror's focused element is a contenteditable DIV (.cm-content), not one of these
    // tags, so editor focus is NOT special-cased here — this guard doesn't fire for it. A
    // duplicate openSearchPanel() call while the editor is focused is benign: it just refocuses
    // the already-open panel.
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT")) return;
    e.preventDefault();
    openSearch();
  }
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div ref="rootEl" class="flex h-full flex-1 flex-col bg-bg" data-test="file-viewer-center">
    <!-- header: back + path + meta -->
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <button data-test="fv-back-list" :aria-label="$t('files.backToList')"
              class="flex lg:hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('back')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("files.title") }}</button>
      <button data-test="fv-back" :aria-label="$t('files.back')"
              class="hidden lg:flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('close')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("files.back") }}</button>
      <span class="h-4 w-px bg-border" aria-hidden="true" />
      <template v-if="file">
        <FileText :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ file.path }}</span>
        <span class="shrink-0 text-[11px] text-fg-muted">{{ fmtSize(file.size) }}</span>
        <span v-if="file.truncated" class="shrink-0 rounded bg-warn/10 px-1 text-[10.5px] text-warn">{{ $t("files.truncated") }}</span>
        <span v-if="file.binary" class="shrink-0 rounded bg-fg/5 px-1 text-[10.5px] text-fg-muted">{{ $t("files.binary") }}</span>
      </template>
      <template v-else-if="props.diffPath">
        <FileDiff :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ props.diffPath }}</span>
      </template>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button v-if="showEditor" data-test="fv-find-toggle" :aria-label="$t('files.find')" :title="$t('files.find')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="openSearch()"><Search :size="15" /></button>
        <button v-if="canEdit && !editing" data-test="fv-edit" :aria-label="$t('files.editFile')" :title="$t('files.editFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="startEdit()"><Pencil :size="15" /></button>
        <template v-if="editing">
          <span v-if="editDirty" data-test="fv-dirty-dot" class="mr-0.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          <button data-test="fv-save" :disabled="saving || !editDirty" :aria-label="$t('files.save')"
                  class="flex h-7 items-center gap-1 rounded px-2 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                  @click="save()"><SaveIcon :size="14" />{{ saving ? $t("files.saving") : $t("files.save") }}</button>
          <button data-test="fv-cancel" :aria-label="$t('files.cancel')"
                  class="h-7 rounded px-2 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                  @click="cancelEdit()">{{ $t("files.cancel") }}</button>
        </template>
        <CopyButton v-if="file && !file.binary && !editing" :text="file.content" />
        <button data-test="fv-close" :aria-label="$t('files.closeFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:hidden"
                @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- body -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-if="error" data-test="fv-error" class="m-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</div>
      <div v-else-if="loading && !file && !diff" data-test="fv-loading" class="p-6 text-sm text-fg-muted">{{ $t("files.loading") }}</div>
      <!-- save error / stale-conflict banner -->
      <div v-if="saveError" data-test="fv-save-error" class="m-3 flex items-center gap-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
        <span class="min-w-0 flex-1">{{ saveErrorLabel }}</span>
        <button v-if="isStale" data-test="fv-reload" class="shrink-0 rounded bg-danger/15 px-2 py-0.5 text-[12px] font-medium hover:bg-danger/25" @click="reloadFromDisk()">{{ $t("files.reload") }}</button>
      </div>
      <!-- file content: one CodeMirror instance for read (editable:false) + edit (editable:true) -->
      <CodeEditor v-if="showEditor" ref="codeEditor" v-model="content" :filename="file!.path"
                  :editable="editing" :line="props.line" :line-rev="props.lineRev" class="h-full" @save="save()" />
      <div v-else-if="file && file.binary" class="p-6 text-sm text-fg-muted">{{ $t("files.binaryNotShown") }}</div>
      <!-- single-file diff: structured tinted rows -->
      <div v-else-if="props.diffPath && diff" class="h-full overflow-auto thin-scroll">
        <div v-if="parsedDiff && parsedDiff.rows.length" data-test="fv-diff-body" class="font-mono text-[12.5px] leading-relaxed">
          <div v-for="(r, i) in parsedDiff.rows" :key="i" data-test="fv-diff-row" class="flex"
               :class="r.type === 'add' ? 'bg-run/10' : r.type === 'del' ? 'bg-danger/10' : r.type === 'hunk' ? 'bg-info/5' : ''">
            <span class="sticky left-0 w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.oldNo ?? "" }}</span>
            <span class="w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.newNo ?? "" }}</span>
            <span class="w-4 shrink-0 select-none text-center" :class="r.type === 'add' ? 'text-run' : r.type === 'del' ? 'text-danger' : 'text-fg-muted/40'">{{ r.type === 'add' ? '+' : r.type === 'del' ? '-' : '' }}</span>
            <span class="whitespace-pre px-2" :class="r.type === 'hunk' ? 'text-info' : 'text-fg'">{{ r.text }}</span>
          </div>
        </div>
        <div v-else class="p-6 text-sm text-fg-muted">{{ $t("files.noDiffContent") }}</div>
        <div v-if="diff.truncated" class="px-4 py-1 text-xs text-warn">{{ $t("files.diffTruncated") }}</div>
      </div>
    </div>
  </div>
</template>
