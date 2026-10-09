<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AgentCapabilityState, CapabilityModel, SelectionEffect } from "@ganglion/xacpx-relay-protocol";
import { classifySelection } from "@ganglion/xacpx-relay-protocol";

const props = withDefaults(defineProps<{
  state: { status: "loading" } | AgentCapabilityState;
  model: string;
  effort: string;
  /** Kept when a refresh cannot fetch efforts. */
  carriedEfforts?: Array<{ id: string; name: string }>;
  audience?: "bot" | "session";
  showEffort?: boolean;
  modelTestId?: string;
  listTestId?: string;
}>(), {
  audience: "session",
  showEffort: true,
  modelTestId: "model-picker-custom",
  listTestId: "model-picker-list",
});

const emit = defineEmits<{
  "update:model": [value: string];
  "update:effort": [value: string];
  fetch: [];
}>();

const { t } = useI18n();
const open = ref(false);

const settled = computed(() => props.state.status === "loading" ? undefined : props.state);
const adapterModels = computed((): CapabilityModel[] => settled.value?.status === "ready" ? settled.value.models : []);
const suggestions = computed((): CapabilityModel[] => {
  const state = settled.value;
  if (!state || state.status === "error" || !("suggestions" in state)) return [];
  return state.suggestions;
});
const effortOptions = computed(() => {
  const state = settled.value;
  if (state && state.status !== "error" && "efforts" in state && state.efforts.status === "known" && state.efforts.options.length > 0) {
    return state.efforts.options;
  }
  return props.carriedEfforts ?? [];
});
const appliedModelId = computed(() => settled.value?.status === "ready" ? settled.value.appliedModelId : undefined);
const effect = computed((): SelectionEffect => classifySelection({
  selectedModelId: props.model,
  appliedModelId: appliedModelId.value,
  advertisedIds: adapterModels.value.map((model) => model.modelId),
}));
const effectText = computed(() => {
  const current = effect.value;
  if (current.kind === "default") {
    return current.appliedModelId
      ? t("capability.effectDefaultApplied", { model: current.appliedModelId })
      : t("capability.effectDefault");
  }
  if (current.kind === "in-effect") return t("capability.effectInEffect", { model: current.modelId });
  if (current.kind === "fell-back") {
    return t("capability.effectFellBack", { model: current.selectedModelId, applied: current.appliedModelId });
  }
  if (!current.advertised) return t("capability.effectCustom", { model: current.modelId });
  return current.appliedModelId
    ? t("capability.effectSavedApplied", { model: current.modelId, applied: current.appliedModelId })
    : t("capability.effectSaved", { model: current.modelId });
});
const reason = computed(() => settled.value && settled.value.status !== "ready" ? settled.value.reason.message : "");
const recovery = computed(() => settled.value && settled.value.status !== "ready" ? settled.value.recovery : "");
const canFetch = computed(() => settled.value?.status === "needs-setup" && settled.value.reason.code === "discovery-available");

function pickModel(modelId: string): void {
  emit("update:model", modelId);
  open.value = false;
}
function onCustom(event: Event): void {
  emit("update:model", (event.target as HTMLInputElement).value);
  open.value = true;
}
function onEffort(event: Event): void {
  emit("update:effort", (event.target as HTMLInputElement).value);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && open.value) {
    event.stopPropagation();
    open.value = false;
  }
}
</script>

<template>
  <div data-test="model-picker" class="space-y-2">
    <p v-if="state.status === 'loading'" data-test="model-picker-loading" class="text-xs text-fg-muted">
      {{ t("capability.loading") }}
    </p>
    <p v-else-if="reason" data-test="model-picker-reason" class="text-xs text-fg-muted">{{ reason }}</p>
    <p v-if="recovery" data-test="model-picker-recovery" class="text-xs text-fg-muted">{{ recovery }}</p>
    <div class="flex gap-2">
      <button v-if="canFetch" type="button" data-test="model-picker-fetch" class="rounded-lg border border-border px-2 py-1 text-xs text-fg hover:bg-fg/5" @click="emit('fetch')">
        {{ t("capability.fetch") }}
      </button>
      <button v-if="state.status === 'error'" type="button" data-test="model-picker-retry" class="rounded-lg border border-border px-2 py-1 text-xs text-fg hover:bg-fg/5" @click="emit('fetch')">
        {{ t("capability.retry") }}
      </button>
    </div>
    <p data-test="model-picker-effect" class="text-xs text-fg-muted">{{ effectText }}</p>
    <p v-if="audience === 'bot'" class="text-[11px] text-fg-muted">{{ t("capability.appliesLater") }}</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="relative">
        <label class="mb-1.5 block text-xs font-medium text-fg-muted" :for="modelTestId">{{ t("capability.model") }}</label>
        <input
          :id="modelTestId"
          :data-test="modelTestId"
          :value="model"
          autocomplete="off"
          :placeholder="t('capability.defaultModel')"
          class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
          @focus="open = true"
          @input="onCustom"
          @keydown="onKeydown"
        />
        <ul v-if="open" :data-test="listTestId" class="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-raised py-1 shadow-xl">
          <li data-test="model-picker-default" class="cursor-pointer px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5" @mousedown.prevent="pickModel('')">
            {{ t("capability.defaultModel") }}
          </li>
          <li
            v-for="entry in adapterModels"
            :key="entry.modelId"
            data-test="model-option"
            :data-model-id="entry.modelId"
            class="cursor-pointer px-3 py-1.5 text-sm text-fg hover:bg-fg/5"
            @mousedown.prevent="pickModel(entry.modelId)"
          >
            <span class="block truncate">{{ entry.name }}</span>
            <span v-if="entry.name !== entry.modelId" class="block truncate text-[11px] text-fg-muted">{{ entry.modelId }}</span>
          </li>
          <li
            v-for="entry in suggestions"
            :key="`suggestion:${entry.modelId}`"
            data-test="model-suggestion"
            :data-model-id="entry.modelId"
            class="cursor-pointer px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5"
            @mousedown.prevent="pickModel(entry.modelId)"
          >
            {{ entry.modelId }}
            <span class="ml-2 text-[11px]">{{ t("capability.suggestion") }}</span>
          </li>
        </ul>
      </div>
      <div v-if="showEffort">
        <label class="mb-1.5 block text-xs font-medium text-fg-muted" for="model-picker-effort">{{ t("capability.efforts") }}</label>
        <select
          v-if="effortOptions.length"
          id="model-picker-effort"
          data-test="model-picker-effort"
          :value="effort"
          class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
          @change="onEffort"
        >
          <option value="">{{ t("capability.effortDefault") }}</option>
          <option v-for="option in effortOptions" :key="option.id" data-test="effort-option" :value="option.id">{{ option.name }}</option>
        </select>
        <input
          v-else
          id="model-picker-effort"
          data-test="model-picker-effort"
          :value="effort"
          class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
          :placeholder="t('capability.effortDefault')"
          @input="onEffort"
        />
      </div>
    </div>
  </div>
</template>
