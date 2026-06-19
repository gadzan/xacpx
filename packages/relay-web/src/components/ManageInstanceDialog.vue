<script setup lang="ts">
import { onMounted, ref } from "vue";
import { X } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import WorkspacesManager from "./WorkspacesManager.vue";
import AgentsManager from "./AgentsManager.vue";

const props = defineProps<{ instanceId: string; instanceName: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useInstancesStore();

const loading = ref(true);

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
        <h2 class="text-sm font-semibold text-fg">{{ $t("instance.manageTitle", { name: instanceName }) }}</h2>
        <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label="$t('instance.close')" @click="emit('close')"><X :size="16" /></button>
      </header>
      <div v-if="loading" class="py-6 text-center text-sm text-fg-muted">{{ $t("instance.dialogLoading") }}</div>
      <div v-else class="space-y-6 p-5">
        <WorkspacesManager :instance-id="instanceId" />
        <AgentsManager :instance-id="instanceId" />
      </div>
    </div>
  </div>
  </Teleport>
</template>
