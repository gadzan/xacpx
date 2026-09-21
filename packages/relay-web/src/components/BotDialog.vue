<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X, Loader2, AlertCircle } from "lucide-vue-next";
import type { BotDetailDto, BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useInstancesStore } from "../stores/instances";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useModalA11y } from "../lib/use-modal-a11y";

const props = defineProps<{
  instanceId: string;
  instanceName: string;
  bot?: BotDetailDto | BotSummaryDto;
  advertisedEfforts?: string[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [bot: BotDetailDto];
}>();

const { t } = useI18n();
const instancesStore = useInstancesStore();
const directBotsStore = useDirectBotsStore();

const inst = computed(() => instancesStore.byId(props.instanceId));

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

const isEditing = computed(() => !!props.bot);
// True once the Bot materialized a direct runtime: agent/workspace are
// backend-locked (runtime_identity_locked) and delete is fail-closed
// (bot_in_use). Teardown/rebind is a later lifecycle surface, so PR5 treats
// a used Bot as identity-locked. The form tells this upfront instead of
// letting edits fail at submit.
const authoritativeBot = computed(() => {
  if (!props.bot) return undefined;
  const detailKey = `${props.instanceId}:${props.bot.id}`;
  // Detail-first: the store detail cache carries authoritative lifecycle
  // (hasRuntime) once loaded; fall back to the list row, then the frozen prop.
  const fromStore =
    directBotsStore.botDetails[detailKey]
    ?? directBotsStore.botsByInstance[props.instanceId]?.find((b) => b.id === (props.bot as BotSummaryDto).id);
  return fromStore ?? props.bot;
});
const identityLocked = computed(() => (authoritativeBot.value && "hasRuntime" in authoritativeBot.value && authoritativeBot.value.hasRuntime) === true);

// Form fields
const name = ref(props.bot?.name ?? "");
const avatar = ref(props.bot?.avatar ?? "");
const role = ref(props.bot?.role ?? "");
const instructions = ref(
  props.bot && "instructions" in props.bot && typeof props.bot.instructions === "string"
    ? props.bot.instructions
    : "",
);
// True once the user edits instructions: a slow detail fetch must fill only an
// untouched field. Value comparison is insufficient — typing then clearing back
// to "" would equal the pristine snapshot and get overwritten.
const instructionsDirty = ref(false);
const agent = ref(props.bot?.agent ?? "");
const workspace = ref(props.bot?.workspace ?? "");
const model = ref(props.bot?.model ?? "");
const effort = ref(props.bot?.effort ?? "");
const enabled = ref(props.bot?.enabled ?? true);
const submitting = ref(false);
const errorMessage = ref<string | null>(null);


// Effort options: when advertised by the adapter capability source, present only
// the advertised options (preserving any pre-existing custom effort on the Bot).
// If no advertised choices are available (e.g. before runtime exists), provide
// an open text input with datalist suggestions rather than an inaccurate closed enum.
const hasAdvertisedEfforts = computed(() => Array.isArray(props.advertisedEfforts) && props.advertisedEfforts.length > 0);
const availableEffortOptions = computed(() => {
  const list = [...(props.advertisedEfforts ?? [])];
  if (effort.value && !list.includes(effort.value)) {
    list.push(effort.value);
  }
  return list;
});
// Available agents from instance: only configured agent NAMES are valid Bot
// identities. The driver catalog lists installable drivers, but submitting an
// unconfigured driver fails backend validation (agent_not_registered), so it
// must never appear as a selectable Bot agent.
const availableAgents = computed(() => {
  const list = inst.value?.agents ?? [];
  const names = new Set<string>();
  const options: Array<{ name: string; driver?: string }> = [];

  for (const a of list) {
    if (!names.has(a.name)) {
      names.add(a.name);
      options.push({ name: a.name, driver: a.driver });
    }
  }
  return options;
});

// Available workspaces from instance
const availableWorkspaces = computed(() => inst.value?.workspaces ?? []);

// Prepopulate defaults if create mode. A generation counter fences the async
// form-options + instructions loads: closing/reopening (or switching bots) must
// not let a stale response overwrite the current dialog's fields. Unmount bumps
// the generation so a late resolution after close is dropped.
let dialogGeneration = 0;
onUnmounted(() => { dialogGeneration++; });
onMounted(async () => {
  const generation = ++dialogGeneration;
  // instructionsDirty tracks real user edits (value comparison is
  // insufficient: type-then-clear returns to the pristine value).
  try {
    await instancesStore.loadFormOptions(props.instanceId);
  } catch {
    // Ignore options load error; validation surfaces missing agent/workspace.
  }
  if (generation !== dialogGeneration) return;
  if (props.bot && (!("instructions" in props.bot) || props.bot.instructions === undefined)) {
    try {
      const detail = await directBotsStore.loadBotDetail(props.instanceId, props.bot.id);
      if (generation !== dialogGeneration) return;
      if (detail.instructions && !instructionsDirty.value) {
        instructions.value = detail.instructions;
      }
      // detail load also converges authoritative lifecycle (hasRuntime);
      // identityLocked reads the store, so no local copy is needed.
    } catch {
      // Ignore background load error
    }
  }

  if (!agent.value && availableAgents.value.length > 0) {
    agent.value = availableAgents.value[0]?.name ?? "";
  }
  if (!workspace.value && availableWorkspaces.value.length > 0) {
    workspace.value = availableWorkspaces.value[0]?.name ?? "";
  }
});

async function submit(): Promise<void> {
  const trimmedName = name.value.trim();
  if (!trimmedName) {
    errorMessage.value = t("bot.validation.nameRequired");
    return;
  }
  if (!agent.value) {
    errorMessage.value = t("bot.validation.agentRequired");
    return;
  }
  if (!workspace.value) {
    errorMessage.value = t("bot.validation.workspaceRequired");
    return;
  }

  submitting.value = true;
  errorMessage.value = null;

  try {
    if (isEditing.value && props.bot) {
      const updated = await directBotsStore.updateBot(props.instanceId, props.bot.id, {
        name: trimmedName,
        avatar: avatar.value.trim() || null,
        role: role.value.trim() || null,
        instructions: instructions.value.trim() || null,
        agent: agent.value,
        workspace: workspace.value,
        model: model.value.trim() || null,
        effort: effort.value.trim() || null,
        enabled: enabled.value,
      });
      emit("saved", updated);
      emit("close");
    } else {
      const created = await directBotsStore.createBot(props.instanceId, {
        name: trimmedName,
        agent: agent.value,
        workspace: workspace.value,
        avatar: avatar.value.trim() || undefined,
        role: role.value.trim() || undefined,
        instructions: instructions.value.trim() || undefined,
        model: model.value.trim() || undefined,
        effort: effort.value.trim() || undefined,
        enabled: enabled.value,
      });
      emit("saved", created);
      emit("close");
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
       @click.self="emit('close')">
    <div ref="dialogEl"
         role="dialog"
         aria-modal="true"
         :aria-labelledby="'bot-dialog-title'"
         class="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
        <h2 id="bot-dialog-title" class="text-base font-semibold">
          {{ isEditing ? $t("bot.dialog.editTitle") : $t("bot.dialog.createTitle") }}
        </h2>
        <button
          type="button"
          :aria-label="$t('common.close')"
          class="grid h-7 w-7 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          @click="emit('close')"
        >
          <X :size="16" />
        </button>
      </div>

      <!-- Form Content -->
      <form class="flex-1 overflow-y-auto px-5 py-4 space-y-4 thin-scroll" @submit.prevent="submit">
        <!-- Error Banner -->
        <div v-if="errorMessage" class="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <AlertCircle :size="15" class="mt-0.5 shrink-0" />
          <div class="flex-1 leading-relaxed">{{ errorMessage }}</div>
        </div>

        <!-- Name -->
        <div>
          <label for="bot-name" class="block text-xs font-medium text-fg-muted mb-1.5">
            {{ $t("bot.fields.name") }} <span class="text-danger">*</span>
          </label>
          <input
            id="bot-name"
            v-model="name"
            type="text"
            required
            maxlength="60"
            :placeholder="$t('bot.fields.namePlaceholder')"
            class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
          />
        </div>

        <!-- Role / Title -->
        <div>
          <label for="bot-role" class="block text-xs font-medium text-fg-muted mb-1.5">
            {{ $t("bot.fields.role") }}
          </label>
          <input
            id="bot-role"
            v-model="role"
            type="text"
            maxlength="100"
            :placeholder="$t('bot.fields.rolePlaceholder')"
            class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
          />
        </div>

        <!-- Agent & Workspace row -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <!-- Agent -->
          <div>
            <label for="bot-agent" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.agent") }} <span class="text-danger">*</span>
            </label>
            <p v-if="identityLocked" class="mb-1.5 text-[11px] text-fg-muted">
              {{ $t("bot.lifecycle.identityLocked") }}
            </p>
            <select
              id="bot-agent"
              v-model="agent"
              required
              :disabled="identityLocked"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option v-for="a in availableAgents" :key="a.name" :value="a.name">
                {{ a.name }} {{ a.driver ? `(${a.driver})` : '' }}
              </option>
            </select>
          </div>

          <!-- Workspace -->
          <div>
            <label for="bot-workspace" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.workspace") }} <span class="text-danger">*</span>
            </label>
            <select
              id="bot-workspace"
              v-model="workspace"
              required
              :disabled="identityLocked"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option v-for="w in availableWorkspaces" :key="w.name" :value="w.name">
                {{ w.name }}
              </option>
            </select>
          </div>
        </div>

        <!-- Instructions -->
        <div>
          <label for="bot-instructions" class="block text-xs font-medium text-fg-muted mb-1.5">
            {{ $t("bot.fields.instructions") }}
          </label>
          <textarea
            id="bot-instructions"
            v-model="instructions"
            rows="4"
            :placeholder="$t('bot.fields.instructionsPlaceholder')"
            class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors focus:border-accent resize-y"
            @input="instructionsDirty = true"
          />
          <p class="mt-1 text-[11px] text-fg-muted">
            {{ $t("bot.fields.instructionsHint") }}
          </p>
        </div>

        <!-- Advanced: Model & Effort -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <!-- Model -->
          <div>
            <label for="bot-model" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.model") }}
            </label>
            <input
              id="bot-model"
              v-model="model"
              type="text"
              :placeholder="$t('bot.fields.modelPlaceholder')"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <!-- Effort -->
          <div>
            <label for="bot-effort" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.effort") }}
            </label>
            <select
              v-if="hasAdvertisedEfforts"
              id="bot-effort"
              v-model="effort"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
            >
              <option value="">{{ $t("bot.fields.effortDefault") }}</option>
              <option v-for="opt in availableEffortOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <template v-else>
              <input
                id="bot-effort"
                v-model="effort"
                list="bot-effort-options"
                type="text"
                :placeholder="$t('bot.fields.effortDefault')"
                class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
              />
              <datalist id="bot-effort-options">
                <option value="low" />
                <option value="medium" />
                <option value="high" />
                <option value="xhigh" />
                <option value="max" />
              </datalist>
            </template>
          </div>
        </div>
        <!-- Avatar & Status -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 items-center">
          <div>
            <label for="bot-avatar" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.avatar") }}
            </label>
            <input
              id="bot-avatar"
              v-model="avatar"
              type="text"
              :placeholder="$t('bot.fields.avatarPlaceholder')"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div class="pt-4 sm:pt-0">
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input
                v-model="enabled"
                type="checkbox"
                class="rounded border-border text-accent focus:ring-accent"
              />
              <span class="font-medium text-xs">{{ $t("bot.fields.enabled") }}</span>
            </label>
          </div>
        </div>
      </form>

      <!-- Footer -->
      <div class="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3 bg-surface/50">
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          @click="emit('close')"
        >
          {{ $t("common.cancel") }}
        </button>
        <button
          type="button"
          :disabled="submitting || !name.trim()"
          class="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          @click="submit"
        >
          <Loader2 v-if="submitting" :size="13" class="animate-spin" />
          <span>{{ isEditing ? $t("common.save") : $t("common.create") }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
