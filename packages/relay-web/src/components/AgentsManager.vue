<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Trash2 } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import { confirm } from "../lib/use-confirm";

const props = defineProps<{ instanceId: string }>();
const store = useInstancesStore();
const { t } = useI18n();
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
  } catch (e) { error.value = e instanceof Error ? e.message : t("agents.addFailed"); }
  finally { busy.value = false; }
}

async function remove(name: string): Promise<void> {
  if (busy.value) return;
  const ok = await confirm({
    title: t("agents.removeTitle"),
    message: t("agents.removeBody", { name }),
    confirmLabel: t("common.remove"),
    tone: "danger",
  });
  if (!ok) return;
  busy.value = true; error.value = "";
  try { await store.removeAgent(props.instanceId, name); }
  catch (e) { error.value = e instanceof Error ? e.message : t("agents.removeFailed"); }
  finally { busy.value = false; }
}

function hint(installed: string): string {
  return installed === "builtin" ? t("agents.builtin") : installed === "yes" ? t("agents.installed") : t("agents.cliNotDetected");
}
</script>

<template>
  <section class="space-y-3">
    <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("agents.title") }}</h3>
    <p v-if="error" data-test="am-error" class="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</p>
    <p v-if="!(inst?.agents ?? []).length" data-test="am-empty" class="text-sm text-fg-muted">{{ $t("agents.empty") }}</p>
    <ul v-else class="divide-y divide-border rounded border border-border">
      <li v-for="a in inst?.agents ?? []" :key="a.name" class="flex items-center justify-between px-3 py-2 text-sm text-fg">
        <span><span class="font-medium">{{ a.name }}</span> · <span class="text-fg-muted">{{ a.driver }}</span></span>
        <button :data-test="`am-remove-${a.name}`" :title="$t('agents.remove', { name: a.name })" :aria-label="$t('agents.removeAria', { name: a.name })"
                class="grid h-7 w-7 shrink-0 place-items-center rounded text-fg-muted transition-colors hover:bg-danger/15 hover:text-danger disabled:opacity-50"
                :disabled="busy" @click="remove(a.name)"><Trash2 :size="14" /></button>
      </li>
    </ul>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <select v-model="driver" data-test="am-driver" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <option value="" disabled>{{ $t("agents.chooseDriver") }}</option>
        <option v-for="c in addableDrivers" :key="c.driver" :value="c.driver" :disabled="c.installed === 'unknown'">
          {{ c.driver }} ({{ hint(c.installed) }})
        </option>
      </select>
      <input v-model="customName" data-test="am-name" :placeholder="$t('agents.namePlaceholder')" class="rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <button data-test="am-add" class="rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
              :disabled="busy || !driver" @click="add">{{ $t("agents.add") }}</button>
    </div>
  </section>
</template>
