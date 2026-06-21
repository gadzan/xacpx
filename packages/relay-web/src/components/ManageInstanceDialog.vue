<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import WorkspacesManager from "./WorkspacesManager.vue";
import AgentsManager from "./AgentsManager.vue";

const props = defineProps<{ instanceId: string; instanceName: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useInstancesStore();
const { t } = useI18n();

const coreVersion = computed(() => store.byId(props.instanceId)?.coreVersion ?? null);

const loading = ref(true);

// Seed the editable name from the prop. The dialog header binds to this local ref
// (not the static prop) so the title updates live the moment a rename succeeds.
const name = ref(props.instanceName);
const renameError = ref("");
const renaming = ref(false);

async function saveName(): Promise<void> {
  const next = name.value.trim();
  if (!next || renaming.value) return;
  renaming.value = true; renameError.value = "";
  try {
    await store.renameInstance(props.instanceId, next);
    name.value = next;
  } catch (e) {
    renameError.value = e instanceof Error ? e.message : t("instance.renameFailed");
  } finally {
    renaming.value = false;
  }
}

onMounted(async () => {
  try {
    await store.loadFormOptions(props.instanceId);
  } catch {
    // best-effort: managers degrade to empty lists if options fail to load
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!-- Teleport to body: the mobile instance drawer uses `transform`, which would
       otherwise trap this fixed overlay inside the narrow off-canvas drawer. -->
  <Teleport to="body">
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
    <div class="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl border border-border bg-raised shadow-xl" data-test="manage-instance-dialog">
      <header class="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 class="text-sm font-semibold text-fg">{{ $t("instance.manageTitle", { name }) }}</h2>
        <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label="$t('instance.close')" @click="emit('close')"><X :size="16" /></button>
      </header>
      <div v-if="loading" class="py-6 text-center text-sm text-fg-muted">{{ $t("instance.dialogLoading") }}</div>
      <div v-else class="space-y-6 p-5">
        <section class="space-y-3">
          <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.nameLabel") }}</h3>
          <p v-if="renameError" data-test="rename-error" class="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{{ renameError }}</p>
          <div class="flex gap-2">
            <input v-model="name" data-test="rename-name" :placeholder="$t('instance.renamePlaceholder')"
                   class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                   @keyup.enter="saveName" />
            <button data-test="rename-save" class="shrink-0 rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
                    :disabled="renaming || !name.trim()" @click="saveName">{{ renaming ? $t("instance.renameSaving") : $t("instance.renameSave") }}</button>
          </div>
        </section>
        <section class="space-y-1">
          <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.versionLabel") }}</h3>
          <p class="text-sm text-fg-muted" data-test="instance-version">
            {{ coreVersion ? $t("instance.coreVersion", { version: coreVersion }) : $t("instance.coreVersionUnknown") }}
          </p>
        </section>
        <WorkspacesManager :instance-id="instanceId" />
        <AgentsManager :instance-id="instanceId" />
      </div>
    </div>
  </div>
  </Teleport>
</template>
