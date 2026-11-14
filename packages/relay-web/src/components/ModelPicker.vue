<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Check, RefreshCw } from "lucide-vue-next";
import type { AgentCapabilityState, CapabilityModel, SelectionEffect } from "@ganglion/xacpx-relay-protocol";
import { classifySelection } from "@ganglion/xacpx-relay-protocol";
import { useDropdown } from "../lib/use-dropdown";
import SelectMenu, { type SelectGroup } from "./SelectMenu.vue";
import { effortsForModel } from "../lib/capability-view";

const props = withDefaults(defineProps<{
  state: { status: "loading" } | AgentCapabilityState;
  model: string;
  effort: string;
  /** The owner's read is in flight, so the refresh icon spins for it too. */
  refreshing?: boolean;
  /** Kept when a refresh cannot fetch efforts. */
  carriedEfforts?: Array<{ id: string; name: string }>;
  audience?: "bot" | "session";
  /** Bot audience only: the "applies to later runs" note. Off when creating, since a new Bot has no runs. */
  showAppliesLater?: boolean;
  showEffort?: boolean;
  modelTestId?: string;
  listTestId?: string;
}>(), {
  refreshing: false,
  audience: "session",
  showAppliesLater: true,
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
// The model field is a combobox: useDropdown owns the shared contract (outside
// pointerdown and Esc close it, Escape returns focus to the field) exactly like
// every other dropdown.
const dd = useDropdown();
// Esc returns focus to the trigger, and focus opens the list again — which
// would make Esc a no-op. The close marks that focus as ours so the handler
// below does not re-open on it.
let focusIsReturn = false;
const closeMenu = dd.closeMenu.bind(dd);
dd.closeMenu = (options?: { focusTrigger?: boolean }) => {
  focusIsReturn = true;
  closeMenu(options);
  focusIsReturn = false;
};
function onFocus(): void {
  if (focusIsReturn) return;
  dd.openMenu();
}

const settled = computed(() => props.state.status === "loading" ? undefined : props.state);
const adapterModels = computed((): CapabilityModel[] => settled.value?.status === "ready" ? settled.value.models : []);
const suggestions = computed((): CapabilityModel[] => {
  const state = settled.value;
  if (!state || state.status === "error" || !("suggestions" in state)) return [];
  return state.suggestions;
});
const appliedModelId = computed(() => settled.value?.status === "ready" ? settled.value.appliedModelId : undefined);
const effortOptions = computed(() => {
  // A list scoped to another model stays hidden; the error carry below is
  // already scope-checked in mergeEffortRefresh, so it renders as-is.
  const scoped = effortsForModel(settled.value, props.model, appliedModelId.value);
  if (scoped?.status === "known" && scoped.options.length > 0) return scoped.options;
  return props.carriedEfforts ?? [];
});
const effortGroups = computed<SelectGroup[]>(() => [
  {
    options: [
      { value: "", label: t("capability.effortDefault"), testId: "effort-option" },
      ...effortOptions.value.map((option) => ({ value: option.id, label: option.name, testId: "effort-option" })),
    ],
  },
]);
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
// The refresh icon is the whole diagnostic: it tints danger when the list is a
// failed or unverified guess, and its tooltip/accessible name carries the
// reason. No prose above the field — a usable list says nothing at all.
const failure = computed(() => {
  const state = settled.value;
  if (!state) return "";
  return state.status === "ready" ? state.reason?.message ?? "" : state.reason.message;
});
/** Any refresh in flight: the owner's read, the daemon's background probe, or a cold first load. */
const spinning = computed(() =>
  props.refreshing
  || props.state.status === "loading"
  || (settled.value?.status === "ready" && settled.value.refreshing === true));
const refreshTitle = computed(() =>
  failure.value ? t("capability.refreshFailed", { message: failure.value }) : t("capability.refresh"));

function pickModel(modelId: string): void {
  emit("update:model", modelId);
  dd.closeMenu();
}
function onCustom(event: Event): void {
  emit("update:model", (event.target as HTMLInputElement).value);
  dd.openMenu();
}
function onEffort(value: string): void {
  emit("update:effort", value);
}
function onRefresh(): void {
  // Busy is disabled too; this keeps a queued double click from probing twice.
  if (spinning.value) return;
  emit("fetch");
}
</script>

<template>
  <div data-test="model-picker" class="space-y-2">
    <p data-test="model-picker-effect" class="text-xs text-fg-muted">{{ effectText }}</p>
    <p v-if="audience === 'bot' && showAppliesLater" data-test="model-picker-applies-later" class="text-xs text-fg-muted">{{ t("capability.appliesLater") }}</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="relative">
        <label class="mb-1.5 block text-xs font-medium text-fg-muted" :for="modelTestId">{{ t("capability.model") }}</label>
        <div class="relative">
          <input
            :id="modelTestId"
            :ref="(el) => (dd.trigger = el as HTMLElement | null)"
            :data-test="modelTestId"
            :value="model"
            autocomplete="off"
            :aria-haspopup="'listbox'"
            :aria-expanded="dd.open"
            :placeholder="t('capability.defaultModel')"
            class="w-full rounded-lg bg-surface-2 py-1.5 pl-3 pr-9 text-sm outline-none transition-colors"
            @focus="onFocus"
            @click="dd.openMenu()"
            @input="onCustom"
          />
          <!-- The only fetch affordance: no text button, and the field stays
               selectable while it spins. -->
          <button
            type="button"
            data-test="model-picker-refresh"
            class="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-sm transition-colors hover:bg-fg/10 disabled:opacity-50"
            :class="failure ? 'text-danger hover:text-danger' : 'text-fg-muted hover:text-fg'"
            :disabled="spinning"
            :title="refreshTitle"
            :aria-label="refreshTitle"
            @mousedown.prevent
            @click.stop="onRefresh"
          >
            <RefreshCw :size="14" :class="{ 'animate-spin motion-reduce:animate-none': spinning }" />
          </button>
        </div>
        <ul v-if="dd.open" :data-test="listTestId" data-dd-panel
            class="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-lg bg-glass-strong p-1 shadow-glass-float backdrop-blur-glass backdrop-saturate-glass">
          <li>
            <button type="button" data-test="model-picker-default"
                    class="flex h-[30px] w-full items-center rounded-item px-2 text-left text-ui"
                    :class="model === '' ? 'bg-fill-strong font-semibold text-fg' : 'text-fg-muted hover:bg-fill-hover'"
                    @mousedown.prevent="pickModel('')">
              <span class="min-w-0 flex-1 truncate">{{ t("capability.defaultModel") }}</span>
              <Check v-if="model === ''" :size="16" class="shrink-0 text-accent-text" />
            </button>
          </li>
          <li v-for="entry in adapterModels" :key="entry.modelId">
            <button type="button"
                data-test="model-option"
                :data-model-id="entry.modelId"
                class="flex min-h-[30px] w-full flex-col items-start justify-center rounded-item px-2 py-1 text-left text-ui"
                :class="entry.modelId === model ? 'bg-fill-strong font-semibold text-fg' : 'text-fg hover:bg-fill-hover'"
                @mousedown.prevent="pickModel(entry.modelId)"
            >
              <span class="flex w-full min-w-0 items-center gap-2">
                <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
                <Check v-if="entry.modelId === model" :size="16" class="shrink-0 text-accent-text" />
              </span>
              <span v-if="entry.name !== entry.modelId" class="block w-full truncate font-mono text-xs text-fg-muted-overlay">{{ entry.modelId }}</span>
            </button>
          </li>
          <li v-if="suggestions.length" class="px-2 pb-1 pt-2 text-xs text-fg-muted-overlay">{{ t("capability.suggestion") }}</li>
          <li v-for="entry in suggestions" :key="`suggestion:${entry.modelId}`">
            <button type="button"
                data-test="model-suggestion"
                :data-model-id="entry.modelId"
                class="flex h-[30px] w-full items-center gap-2 rounded-item px-2 text-left font-mono text-ui"
                :class="entry.modelId === model ? 'bg-fill-strong font-semibold text-fg' : 'text-fg hover:bg-fill-hover'"
                @mousedown.prevent="pickModel(entry.modelId)"
            >
              <span class="min-w-0 flex-1 truncate">{{ entry.modelId }}</span>
              <Check v-if="entry.modelId === model" :size="16" class="shrink-0 text-accent-text" />
            </button>
          </li>
        </ul>
      </div>
      <div v-if="showEffort">
        <label class="mb-1.5 block text-xs font-medium text-fg-muted" for="model-picker-effort">{{ t("capability.efforts") }}</label>
        <SelectMenu
          v-if="effortOptions.length"
          id="model-picker-effort"
          data-test="model-picker-effort"
          :model-value="effort"
          :aria-label="t('capability.efforts')"
          :title="t('capability.efforts')"
          :groups="effortGroups"
          @update:model-value="onEffort"
        />
        <input
          v-else
          id="model-picker-effort"
          data-test="model-picker-effort"
          :value="effort"
          class="w-full rounded-lg bg-surface-2 px-3 py-1.5 text-sm outline-none transition-colors"
          :placeholder="t('capability.effortDefault')"
          @input="onEffort(($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>
  </div>
</template>
