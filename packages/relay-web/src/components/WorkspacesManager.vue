<script setup lang="ts">
import { computed, ref } from "vue";
import { useInstancesStore } from "../stores/instances";

const props = defineProps<{ instanceId: string }>();
const store = useInstancesStore();
const inst = computed(() => store.byId(props.instanceId));

const name = ref("");
const path = ref("");
const description = ref("");
const error = ref("");
const busy = ref(false);

async function create(): Promise<void> {
  if (!name.value.trim() || !path.value.trim() || busy.value) return;
  busy.value = true; error.value = "";
  try {
    await store.createWorkspace(props.instanceId, name.value.trim(), path.value.trim(), description.value.trim() || undefined);
    name.value = ""; path.value = ""; description.value = "";
  } catch (e) { error.value = e instanceof Error ? e.message : "create failed"; }
  finally { busy.value = false; }
}

async function remove(wsName: string): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { await store.removeWorkspace(props.instanceId, wsName); }
  catch (e) { error.value = e instanceof Error ? e.message : "remove failed"; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="space-y-3">
    <h3 class="text-sm font-semibold uppercase text-fg-muted">Workspaces</h3>
    <p v-if="error" data-test="wm-error" class="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</p>
    <p v-if="!(inst?.workspaces ?? []).length" data-test="wm-empty" class="text-sm text-fg-muted">No workspaces yet.</p>
    <ul v-else class="divide-y divide-border rounded border border-border">
      <li v-for="w in inst?.workspaces ?? []" :key="w.name" class="flex items-center justify-between px-3 py-2 text-sm text-fg">
        <span><span class="font-medium">{{ w.name }}</span> — <span class="text-fg-muted">{{ w.cwd }}</span></span>
        <button :data-test="`wm-remove-${w.name}`" class="text-danger hover:underline disabled:opacity-50" :disabled="busy" @click="remove(w.name)">remove</button>
      </li>
    </ul>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <input v-model="name" data-test="wm-name" placeholder="name" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <input v-model="path" data-test="wm-path" placeholder="/abs/path" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <input v-model="description" data-test="wm-desc" placeholder="description (optional)" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
    </div>
    <button data-test="wm-create" class="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
            :disabled="busy || !name.trim() || !path.trim()" @click="create">Add workspace</button>
  </section>
</template>
