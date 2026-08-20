<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Trash2, FolderOpen } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import { confirm } from "../lib/use-confirm";
import DirectoryPicker from "./DirectoryPicker.vue";

const props = defineProps<{ instanceId: string }>();
const store = useInstancesStore();
const { t } = useI18n();
const inst = computed(() => store.byId(props.instanceId));

const name = ref("");
const path = ref("");
const description = ref("");
const error = ref("");
const busy = ref(false);
const formOpen = ref(false);
const browsing = ref(false);
const filter = ref("");

const all = computed(() => inst.value?.workspaces ?? []);
const showFilter = computed(() => all.value.length > 6);
const list = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return all.value;
  return all.value.filter((w) => w.name.toLowerCase().includes(q) || (w.cwd ?? "").toLowerCase().includes(q));
});

async function create(): Promise<void> {
  if (!name.value.trim() || !path.value.trim() || busy.value) return;
  busy.value = true; error.value = "";
  try {
    await store.createWorkspace(props.instanceId, name.value.trim(), path.value.trim(), description.value.trim() || undefined);
    name.value = ""; path.value = ""; description.value = "";
  } catch (e) { error.value = e instanceof Error ? e.message : t("workspaces.createFailed"); }
  finally { busy.value = false; }
}

// Close on confirm as well as close: a confirmed path always dismisses the picker.
function onBrowseConfirm(p: string): void {
  path.value = p;
  browsing.value = false;
}

async function remove(wsName: string): Promise<void> {
  if (busy.value) return;
  const ok = await confirm({
    title: t("workspaces.removeTitle"),
    message: t("workspaces.removeBody", { name: wsName }),
    confirmLabel: t("common.remove"),
    tone: "danger",
  });
  if (!ok) return;
  busy.value = true; error.value = "";
  try { await store.removeWorkspace(props.instanceId, wsName); }
  catch (e) { error.value = e instanceof Error ? e.message : t("workspaces.removeFailed"); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="space-y-3">
    <p v-if="error" data-test="wm-error" class="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</p>
    <input v-if="showFilter" v-model="filter" data-test="wm-filter" :placeholder="$t('common.filter')"
           class="w-full rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
    <p v-if="!all.length" data-test="wm-empty" class="text-sm text-fg-muted">{{ $t("workspaces.empty") }}</p>
    <ul v-else class="max-h-64 divide-y divide-border overflow-y-auto rounded border border-border">
      <li v-for="w in list" :key="w.name" class="flex items-center justify-between gap-2 px-3 py-2 text-sm">
        <span class="min-w-0 truncate" :title="`${w.name} — ${w.cwd}`">
          <span class="font-medium text-fg">{{ w.name }}</span><span class="text-fg-muted"> — {{ w.cwd }}</span>
        </span>
        <button :data-test="`wm-remove-${w.name}`" :title="$t('workspaces.remove', { name: w.name })" :aria-label="$t('workspaces.removeAria', { name: w.name })"
                class="grid h-7 w-7 shrink-0 place-items-center rounded text-fg-muted transition-colors hover:bg-danger/15 hover:text-danger disabled:opacity-50"
                :disabled="busy" @click="remove(w.name)"><Trash2 :size="14" /></button>
      </li>
      <li v-if="!list.length" class="px-3 py-2 text-sm text-fg-muted">{{ $t("common.noMatch") }}</li>
    </ul>

    <button v-if="!formOpen" type="button" data-test="wm-add-toggle" @click="formOpen = true"
            class="flex items-center gap-1.5 rounded border border-dashed border-border px-3 py-1.5 text-sm text-fg-muted transition-colors hover:border-accent hover:text-fg">
      <Plus :size="14" /> {{ $t("workspaces.add") }}
    </button>
    <div v-else class="space-y-2 rounded border border-border p-3">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input v-model="name" data-test="wm-name" :placeholder="$t('workspaces.namePlaceholder')" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <input v-model="description" data-test="wm-desc" :placeholder="$t('workspaces.descPlaceholder')" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      </div>
      <div class="flex gap-2">
        <input v-model="path" data-test="wm-path" :placeholder="$t('workspaces.pathPlaceholder')"
               class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <button type="button" data-test="wm-browse" :title="$t('workspaces.browsePath')" :aria-label="$t('workspaces.browsePath')"
                class="grid h-8 w-8 shrink-0 place-items-center rounded border border-border text-fg-muted hover:bg-fg/5 hover:text-fg"
                @click="browsing = true"><FolderOpen :size="14" /></button>
      </div>
      <div class="flex gap-2">
        <button data-test="wm-create" class="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
                :disabled="busy || !name.trim() || !path.trim()" @click="create">{{ $t("common.add") }}</button>
        <button type="button" data-test="wm-add-cancel" class="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5 hover:text-fg" @click="formOpen = false">{{ $t("common.cancel") }}</button>
      </div>
    </div>
    <DirectoryPicker v-if="browsing" :instance-id="instanceId" :initial-path="path.trim() || undefined"
                     @confirm="onBrowseConfirm" @close="browsing = false" />
  </section>
</template>
