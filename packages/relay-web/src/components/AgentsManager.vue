<script setup lang="ts">
import { computed, ref } from "vue";
import { useInstancesStore } from "../stores/instances";

const props = defineProps<{ instanceId: string }>();
const store = useInstancesStore();
const inst = computed(() => store.byId(props.instanceId));

const driver = ref("");
const customName = ref("");
const error = ref("");
const busy = ref(false);

const addableDrivers = computed(() => (inst.value?.agentCatalog ?? []).filter((c) => !c.configured));

async function add(): Promise<void> {
  if (!driver.value || busy.value) return;
  busy.value = true; error.value = "";
  try {
    await store.createAgent(props.instanceId, customName.value.trim() || driver.value, driver.value);
    driver.value = ""; customName.value = "";
  } catch (e) { error.value = e instanceof Error ? e.message : "add failed"; }
  finally { busy.value = false; }
}

async function remove(name: string): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = "";
  try { await store.removeAgent(props.instanceId, name); }
  catch (e) { error.value = e instanceof Error ? e.message : "remove failed"; }
  finally { busy.value = false; }
}

function hint(installed: string): string {
  return installed === "builtin" ? "built-in" : installed === "yes" ? "installed" : "CLI not detected";
}
</script>

<template>
  <section class="space-y-3">
    <h3 class="text-sm font-semibold uppercase text-fg-muted">Agents</h3>
    <p v-if="error" data-test="am-error" class="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</p>
    <p v-if="!(inst?.agents ?? []).length" data-test="am-empty" class="text-sm text-fg-muted">No agents yet.</p>
    <ul v-else class="divide-y divide-border rounded border border-border">
      <li v-for="a in inst?.agents ?? []" :key="a.name" class="flex items-center justify-between px-3 py-2 text-sm text-fg">
        <span><span class="font-medium">{{ a.name }}</span> · <span class="text-fg-muted">{{ a.driver }}</span></span>
        <button :data-test="`am-remove-${a.name}`" class="text-danger hover:underline disabled:opacity-50" :disabled="busy" @click="remove(a.name)">remove</button>
      </li>
    </ul>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <select v-model="driver" data-test="am-driver" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <option value="" disabled>Choose a driver…</option>
        <option v-for="c in addableDrivers" :key="c.driver" :value="c.driver" :disabled="c.installed === 'unknown'">
          {{ c.driver }} ({{ hint(c.installed) }})
        </option>
      </select>
      <input v-model="customName" data-test="am-name" placeholder="name (optional, = driver)" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button data-test="am-add" class="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
              :disabled="busy || !driver" @click="add">Add agent</button>
    </div>
  </section>
</template>
