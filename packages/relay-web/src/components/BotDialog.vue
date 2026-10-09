<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Loader2, AlertCircle } from "lucide-vue-next";
import type { AgentCapabilityState, BotDetailDto, BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useInstancesStore } from "../stores/instances";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useModalA11y } from "../lib/use-modal-a11y";
import { mergeEffortRefresh } from "../lib/capability-view";
import ModelPicker from "./ModelPicker.vue";
import BotRemovalDialog from "./BotRemovalDialog.vue";

const props = defineProps<{
  instanceId: string;
  instanceName: string;
  bot?: BotDetailDto | BotSummaryDto;
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
// True once the Bot materialized an actual direct runtime binding/session:
// agent/workspace are then backend-locked (runtime_identity_locked). A
// persisted Direct Conversation alone keeps delete fail-closed (bot_in_use)
// but does not lock identity. Teardown/rebind is a later lifecycle surface,
// so PR5 treats a materialized Bot as identity-locked. The form tells this
// upfront instead of letting edits fail at submit.
const identityLocked = computed(() => {
  if (!props.bot) return false;
  const detailKey = `${props.instanceId}:${props.bot.id}`;
  const detail = directBotsStore.botDetails[detailKey];
  const listed = directBotsStore.botsByInstance[props.instanceId]
    ?.find((b) => b.id === (props.bot as BotSummaryDto).id);
  // hasRuntime is monotonic (no public teardown/rebind): a stale detail row
  // must never shadow a newer list row that already converged true, so merge
  // all three sources instead of detail-first fallthrough.
  return detail?.hasRuntime === true
    || listed?.hasRuntime === true
    || ("hasRuntime" in props.bot && props.bot.hasRuntime === true);
});

// Form fields
const name = ref(props.bot?.name ?? "");
const avatar = ref(props.bot?.avatar ?? "");
const role = ref(props.bot?.role ?? "");
const instructions = ref(
  props.bot && "instructions" in props.bot && typeof props.bot.instructions === "string"
    ? props.bot.instructions
    : "",
);
// True once the user edits a field: a slow detail fetch must fill only
// untouched fields. Value comparison is insufficient — typing then clearing
// back to the open-time value would equal the pristine snapshot and get
// overwritten (e.g. model old -> tmp -> old must survive a rev2 new).
const instructionsDirty = ref(false);
const nameDirty = ref(false);
const avatarDirty = ref(false);
const roleDirty = ref(false);
const agentDirty = ref(false);
const workspaceDirty = ref(false);
const agent = ref(props.bot?.agent ?? "");
const workspace = ref(props.bot?.workspace ?? "");
const model = ref(props.bot?.model ?? "");
const effort = ref(props.bot?.effort ?? "");
const modelDirty = ref(false);
const effortDirty = ref(false);
const enabled = ref(props.bot?.enabled ?? true);
const enabledDirty = ref(false);
const storedEnabled = computed(() =>
  props.bot
    ? directBotsStore.botDetails[`${props.instanceId}:${props.bot.id}`]?.enabled ?? props.bot.enabled
    : undefined,
);
const submitting = ref(false);
const removalOpen = ref(false);
const errorMessage = ref<string | null>(null);
const capability = ref<{ status: "loading" } | AgentCapabilityState>({ status: "loading" });
const carriedEfforts = ref<Array<{ id: string; name: string }>>([]);
let lastSettledCapability: AgentCapabilityState | undefined;
let capabilitySeq = 0;

function normalizedModel(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return undefined;
  return trimmed;
}

async function loadCapabilities(probe = false): Promise<void> {
  const seq = ++capabilitySeq;
  if (!agent.value || !workspace.value) return;
  capability.value = { status: "loading" };
  const next = await instancesStore.getAgentCapabilities(props.instanceId, {
    agent: agent.value,
    workspace: workspace.value,
    ...(props.bot ? { botId: props.bot.id } : {}),
    ...(probe ? { probe: true } : {}),
  });
  if (seq !== capabilitySeq) return;
  const merged = mergeEffortRefresh(lastSettledCapability, next);
  if (merged.state.status !== "error") lastSettledCapability = merged.state;
  capability.value = merged.state;
  if (merged.efforts?.status === "known") {
    carriedEfforts.value = merged.efforts.options.map((option) => ({ id: option.id, name: option.name }));
  }
}

function onModelPick(value: string): void {
  model.value = value;
  modelDirty.value = true;
}
function onEffortPick(value: string): void {
  effort.value = value;
  effortDirty.value = true;
}
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
// Revision of the authoritative detail that the untouched fields show. A
// summary never carries instructions, so Save stays gated while this is null.
// Submitting then could wipe instructions the user never saw.
const filledRevision = ref<number | null>(null);
const detailHydrated = computed(() => !props.bot || filledRevision.value !== null);
const detailLoading = ref(false);
const detailLoadError = ref<string | null>(null);

// Unmount bumps the generation so a load that resolves after close (or after
// switching Bots) cannot write into this dialog's fields.
let dialogGeneration = 0;
onUnmounted(() => { dialogGeneration++; });

function cachedDetail(): BotDetailDto | undefined {
  if (!props.bot || !directBotsStore.isBotDetailHydrated(props.instanceId, props.bot.id)) return undefined;
  return directBotsStore.botDetails[`${props.instanceId}:${props.bot.id}`];
}
function summaryRevision(): number | undefined {
  const botId = props.bot?.id;
  return directBotsStore.botsByInstance[props.instanceId]?.find((b) => b.id === botId)?.profileRevision;
}
// Each field has an explicit dirty flag because type-then-revert
// (old -> tmp -> old) looks pristine under value comparison but is a real
// user choice.
function applyDetail(detail: BotDetailDto): void {
  if (filledRevision.value !== null && detail.profileRevision <= filledRevision.value) return;
  if (!instructionsDirty.value) instructions.value = detail.instructions ?? "";
  if (!nameDirty.value) name.value = detail.name;
  if (!avatarDirty.value) avatar.value = detail.avatar ?? "";
  if (!roleDirty.value) role.value = detail.role ?? "";
  if (!agentDirty.value) agent.value = detail.agent;
  if (!workspaceDirty.value) workspace.value = detail.workspace;
  if (!modelDirty.value) model.value = detail.model ?? "";
  if (!effortDirty.value) effort.value = detail.effort ?? "";
  if (!enabledDirty.value) enabled.value = detail.enabled;
  filledRevision.value = detail.profileRevision;
  detailLoadError.value = null;
}
async function hydrateDetail(generation: number): Promise<void> {
  if (!props.bot || detailLoading.value) return;
  detailLoading.value = true;
  detailLoadError.value = null;
  try {
    const detail = await directBotsStore.loadBotDetail(props.instanceId, props.bot.id);
    if (generation !== dialogGeneration) return;
    applyDetail(detail);
  } catch (err: unknown) {
    if (generation !== dialogGeneration) return;
    detailLoadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (generation === dialogGeneration) detailLoading.value = false;
  }
}
// The store refetches detail only for the selected Bot, so a dialog opened
// from the sidebar for another Bot refetches itself on a newer revision.
function syncFromStore(): void {
  if (!props.bot) return;
  const cached = cachedDetail();
  if (cached) {
    applyDetail(cached);
    return;
  }
  const rev = summaryRevision();
  if (filledRevision.value !== null && typeof rev === "number" && rev > filledRevision.value) {
    void hydrateDetail(dialogGeneration);
  }
}

const openTimeDetail = cachedDetail();
if (openTimeDetail) applyDetail(openTimeDetail);

onMounted(() => {
  void (async () => {
    const generation = ++dialogGeneration;
    try {
      await instancesStore.loadFormOptions(props.instanceId);
    } catch {
      // Ignore options load error; validation surfaces missing agent/workspace.
    }
    if (generation !== dialogGeneration) return;
    if (!detailHydrated.value) await hydrateDetail(generation);
    if (generation !== dialogGeneration) return;
    syncFromStore();
    if (!agent.value && availableAgents.value.length > 0) {
      agent.value = availableAgents.value[0]?.name ?? "";
    }
    if (!workspace.value && availableWorkspaces.value.length > 0) {
      workspace.value = availableWorkspaces.value[0]?.name ?? "";
    }
    await loadCapabilities(false);
  })();
});
watch([agent, workspace, () => props.bot?.id], () => {
  void loadCapabilities(false);
});

function retryHydrate(): void {
  void hydrateDetail(dialogGeneration);
}
// botDetailHydrated in the store is not reactive; the cached row and the
// summary revision always change alongside it.
watch(
  () => {
    const botId = props.bot?.id;
    if (!botId) return null;
    return [directBotsStore.botDetails[`${props.instanceId}:${botId}`], summaryRevision()] as const;
  },
  syncFromStore,
);
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
  if (isEditing.value && props.bot && !detailHydrated.value) {
    errorMessage.value = t("bot.validation.detailLoading");
    return;
  }

  submitting.value = true;
  errorMessage.value = null;

  try {
    if (isEditing.value && props.bot) {
      // Dirty-only patch: the dialog may have hydrated at rev1 while a remote
      // client moved the Bot to rev2 (instructions/model changed elsewhere).
      // Sending every field would overwrite the remote rev2 rows with stale
      // rev1 values the user never touched. Only touched fields go out; the
      // backend merges the patch and bumps the revision.
      const patch: {
        name?: string;
        avatar?: string | null;
        role?: string | null;
        instructions?: string | null;
        agent?: string;
        workspace?: string;
        model?: string | null;
        effort?: string | null;
        enabled?: boolean | null;
        // Every field is dirty-gated: required-ness is enforced by the
        // validation above (empty name never reaches the patch), so an
        // untouched name must not go out either — otherwise a remote rename
        // (rev2) would be rolled back by a stale rev1 name on save.
      } = {};
      if (nameDirty.value) patch.name = trimmedName;
      if (avatarDirty.value) patch.avatar = avatar.value.trim() || null;
      if (roleDirty.value) patch.role = role.value.trim() || null;
      if (instructionsDirty.value) patch.instructions = instructions.value.trim() || null;
      if (agentDirty.value) patch.agent = agent.value;
      if (workspaceDirty.value) patch.workspace = workspace.value;
      if (modelDirty.value) patch.model = normalizedModel(model.value) ?? null;
      if (effortDirty.value) patch.effort = effort.value.trim() || null;
      if (enabledDirty.value) patch.enabled = enabled.value;
      const updated = await directBotsStore.updateBot(props.instanceId, props.bot.id, patch);
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
        model: normalizedModel(model.value),
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

        <!-- Detail hydration failure: fail-closed (Save stays gated so unseen
          instructions cannot be wiped) with an explicit Retry. -->
        <div v-if="isEditing && props.bot && !detailHydrated && detailLoadError"
             data-test="bot-detail-retry"
             class="flex items-center justify-between gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
          <div class="flex-1 leading-relaxed">{{ $t("bot.validation.detailLoadFailed", { msg: detailLoadError }) }}</div>
          <button type="button"
                  data-test="bot-detail-retry-button"
                  :disabled="detailLoading"
                  class="flex items-center gap-1 rounded bg-warning/20 px-2 py-0.5 font-medium hover:bg-warning/30 transition-colors disabled:opacity-50"
                  @click="retryHydrate">
            <Loader2 v-if="detailLoading" :size="12" class="animate-spin" />
            <span>{{ $t("bot.prompt.retry") }}</span>
          </button>
        </div>
        <div v-else-if="isEditing && props.bot && !detailHydrated && detailLoading"
             class="p-3 text-xs text-fg-muted">
          {{ $t("bot.validation.detailLoading") }}
        </div>

        <!-- Name -->
        <div>
          <label for="bot-name" class="block text-xs font-medium text-fg-muted mb-1.5">
            {{ $t("bot.fields.name") }} <span class="text-danger">*</span>
          </label>
          <input
            id="bot-name"
            v-model="name"
            @input="nameDirty = true"
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
            @input="roleDirty = true"
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
              @change="agentDirty = true"
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
              @change="workspaceDirty = true"
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
            :disabled="!detailHydrated"
            :placeholder="detailHydrated ? $t('bot.fields.instructionsPlaceholder') : $t('bot.fields.instructionsLoading')"
            class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors focus:border-accent resize-y disabled:cursor-wait disabled:opacity-60"
            @input="instructionsDirty = true"
          />
          <p class="mt-1 text-[11px] text-fg-muted">
            {{ $t("bot.fields.instructionsHint") }}
          </p>
        </div>

        <ModelPicker
          audience="bot"
          :state="capability"
          :model="model"
          :effort="effort"
          :carried-efforts="carriedEfforts"
          model-test-id="bot-model"
          list-test-id="bot-model-list"
          @update:model="onModelPick"
          @update:effort="onEffortPick"
          @fetch="loadCapabilities(true)"
        />
        <!-- Avatar & Status -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 items-center">
          <div>
            <label for="bot-avatar" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.avatar") }}
            </label>
            <input
              id="bot-avatar"
              v-model="avatar"
              @input="avatarDirty = true"
              type="text"
              :placeholder="$t('bot.fields.avatarPlaceholder')"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div class="pt-4 sm:pt-0">
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input
                v-model="enabled"
                @change="enabledDirty = true"
                type="checkbox"
                class="rounded border-border text-accent focus:ring-accent"
              />
              <span class="font-medium text-xs">{{ $t("bot.fields.enabled") }}</span>
            </label>
          </div>
        </div>
        <p v-if="storedEnabled === true && !enabled"
           data-test="bot-dialog-disable-note"
           class="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-fg">
          {{ $t("bot.lifecycle.disableNote") }}
        </p>
        <p v-else-if="storedEnabled === false && enabled"
           data-test="bot-dialog-reenable-note"
           class="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-fg">
          {{ $t("bot.lifecycle.reenableNote") }}
        </p>
      </form>

      <!-- Footer -->
      <div class="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3 bg-surface/50">
        <button
          v-if="isEditing && props.bot && props.bot.retired !== true"
          type="button"
          data-test="bot-dialog-remove"
          class="mr-auto rounded-lg border border-danger/40 px-3 py-1.5 text-xs font-medium text-danger"
          @click="removalOpen = true"
        >
          {{ $t("bot.removal.action") }}
        </button>
        <button
          type="button"
          class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
          @click="emit('close')"
        >
          {{ $t("common.cancel") }}
        </button>
        <button
          type="button"
          :disabled="submitting || !name.trim() || (isEditing && !!props.bot && !detailHydrated)"
          class="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          @click="submit"
        >
          <Loader2 v-if="submitting" :size="13" class="animate-spin" />
          <span>{{ isEditing ? $t("common.save") : $t("common.create") }}</span>
        </button>
      </div>
    </div>
    <BotRemovalDialog
      v-if="removalOpen && props.bot"
      :bot-name="props.bot.name"
      :preview="() => directBotsStore.previewBotRemoval(props.instanceId, props.bot!.id)"
      :remove="(input) => directBotsStore.removeBot(props.instanceId, { botId: props.bot!.id, ...input })"
      :get-operation="(id) => directBotsStore.getLifecycleOperation(props.instanceId, id)"
      @close="removalOpen = false"
      @removed="removalOpen = false; emit('close')"
    />
  </div>
</template>
