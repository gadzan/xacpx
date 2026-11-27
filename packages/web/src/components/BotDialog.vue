<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Loader2, AlertCircle, ChevronLeft, Pencil } from "lucide-vue-next";
import { copyBotAvatar, hasWorkspaceNameChars, unsupportedCapability, type AgentCapabilityState, type BotAvatarConfig, type BotDetailDto, type BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { supportsBotDedicatedWorkspace, supportsBotDedicatedWorkspaceCleanup, useInstancesStore } from "../stores/instances";
import { useDirectBotsStore } from "../stores/direct-bots";
import DialogShell from "./DialogShell.vue";
import UiButton from "./UiButton.vue";
import { navigateBack } from "../lib/mobile-back";
import { mergeEffortRefresh } from "../lib/capability-view";
import type { BotAvatarState } from "../lib/bot-avatar-state";
import ModelPicker from "./ModelPicker.vue";
import SelectMenu, { type SelectGroup } from "./SelectMenu.vue";
import BotRemovalDialog from "./BotRemovalDialog.vue";
import BotAvatarEditor from "./BotAvatarEditor.vue";
import BotAvatarQuickView from "./BotAvatarQuickView.vue";
import BotAvatar from "./BotAvatar.vue";
import { randomCharacterAvatar } from "../lib/bot-avatar/catalog";
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

const isEditing = computed(() => !!props.bot);
// The Bot's own daemon-allocated workspace. It is private: the instance never
// lists it among registered workspaces, so the form renders it as this Bot's
// dedicated slot and never as a normal option.
const botDedicatedWorkspace = ref(props.bot?.dedicatedWorkspace);
const ownsDedicatedWorkspace = computed(() => botDedicatedWorkspace.value !== undefined);
// Creating always allocates a dedicated workspace: a Bot is meant to have its own
// directory, and letting the form pick a shared one invited two Bots to collide in
// the same tree. Editing may point the Bot at a shared workspace, and may always
// come back to its own — but may not request a SECOND dedicated directory, since
// the first would keep its registration with nothing left to release it.
const canRequestDedicatedWorkspace = computed(() =>
  isEditing.value ? false : supportsBotDedicatedWorkspace(inst.value));
// Editing an existing Bot freely re-points its workspace, so the picker is offered
// there. A new Bot is given a directory by the daemon and has nothing to choose —
// except against an older core that cannot allocate one, where the picker is the
// only way to name a workspace and must stay.
const canChooseWorkspace = computed(() => isEditing.value || !supportsBotDedicatedWorkspace(inst.value));
// The workspace is required exactly when the form neither picks it nor receives it
// from the daemon: only a create against a core that allocates one leaves it out.
const workspaceRequired = computed(() => !canRequestDedicatedWorkspace.value);
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
const avatar = ref<BotAvatarConfig | undefined>(
  props.bot ? copyBotAvatar(props.bot.avatar) : randomCharacterAvatar(),
);
const avatarPreviewState = ref<BotAvatarState>("idle");
// Single-surface dialog: the basic form embeds the avatar (click = enlarged
// quick view); the corner badge flips to the full appearance editor and the
// header back button returns.
const view = ref<"basic" | "appearance">("basic");
const avatarQuickView = ref(false);

function onAvatarPick(value: BotAvatarConfig | undefined): void {
  avatar.value = copyBotAvatar(value);
  avatarDirty.value = true;
}
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
const capabilityRefreshing = ref(false);
const capabilityFailure = ref<{ message: string; recovery: string } | undefined>();
let capabilitySeq = 0;

function normalizedModel(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return undefined;
  return trimmed;
}

async function loadCapabilities(probe = false): Promise<void> {
  const seq = ++capabilitySeq;
  // Fenced-off reads never reach their own clear, so every pre-fetch return
  // clears here or the icon spins forever.
  if (!agent.value || (!canRequestDedicatedWorkspace.value && !capabilityWorkspace.value)) {
    capabilityRefreshing.value = false;
    capabilityFailure.value = undefined;
    return;
  }
  const previewWorkspace = capabilityWorkspace.value;
  let next: AgentCapabilityState;
  if (previewWorkspace) {
    capabilityRefreshing.value = true;
    try {
      next = await instancesStore.getAgentCapabilities(props.instanceId, {
        agent: agent.value,
        workspace: previewWorkspace,
        ...(props.bot ? { botId: props.bot.id } : {}),
        ...(probe ? { probe: true } : {}),
      });
    } finally {
      if (seq === capabilitySeq) capabilityRefreshing.value = false;
    }
  } else {
    capabilityRefreshing.value = false;
    capabilityFailure.value = undefined;
    // No registered workspace to probe: the dedicated workspace does not exist
    // yet, so there is nothing to discover against. One merged hint serves as
    // both reason and recovery; ModelPicker renders identical text once.
    const hint = t("bot.fields.workspacePreviewHint");
    next = unsupportedCapability(
      { code: "probe-unavailable", message: hint },
      hint,
      { fetchedAt: new Date().toISOString() },
    );
  }
  if (seq !== capabilitySeq) return;
  // Scope the effort list to the model in effect at this read; a switch drops
  // the previous model's options instead of carrying them over.
  const scopeId = normalizedModel(model.value) ?? (next.status === "ready" ? next.appliedModelId : undefined);
  const merged = mergeEffortRefresh(lastSettledCapability, next, scopeId);
  if (merged.state.status === "error") {
    capabilityFailure.value = { message: merged.state.reason.message, recovery: merged.state.recovery };
    if (lastSettledCapability) capability.value = lastSettledCapability;
    else capability.value = merged.state;
  } else {
    capabilityFailure.value = undefined;
    lastSettledCapability = merged.state;
    capability.value = merged.state;
  }
  carriedEfforts.value = merged.efforts?.status === "known"
    ? merged.efforts.options.map((option) => ({ id: option.id, name: option.name }))
    : [];
}

function onModelPick(value: string): void {
  model.value = value;
  modelDirty.value = true;
  void loadCapabilities(false);
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
const avatarDriver = computed(() => availableAgents.value.find((option) => option.name === agent.value)?.driver ?? agent.value);

const agentGroups = computed<SelectGroup[]>(() => [
  {
    options: availableAgents.value.map((a) => ({
      value: a.name,
      label: a.driver ? `${a.name} (${a.driver})` : a.name,
    })),
  },
]);

// Available workspaces from instance
const availableWorkspaces = computed(() => inst.value?.workspaces ?? []);
const workspaceGroups = computed<SelectGroup[]>(() => {
  const options = [...availableWorkspaces.value.map((w) => ({ value: w.name, label: w.name }))];
  // The Bot's own dedicated workspace never appears as an ordinary option: its
  // raw name stays out of the list, and the current value is labelled as the
  // Bot-owned slot so an update that keeps it still keeps the daemon's marker.
  // It is offered whenever the Bot owns one, so switching away and back is a
  // normal edit rather than a one-way trip.
  if (botDedicatedWorkspace.value) {
    options.unshift({ value: botDedicatedWorkspace.value.name, label: t("bot.fields.dedicatedWorkspaceCurrent") });
  } else if (isEditing.value && workspace.value && !options.some((option) => option.value === workspace.value)) {
    // A Bot may run in a workspace this instance no longer lists; the current
    // value must stay visible.
    options.unshift({ value: workspace.value, label: workspace.value });
  }
  return [{ options }];
});
const capabilityWorkspace = computed(() => workspace.value || (canRequestDedicatedWorkspace.value ? availableWorkspaces.value[0]?.name : undefined));
// Same rule as the daemon: a new workspace is named after the Bot, which needs
// at least one letter or digit (CJK included). Shown live under the name.
const nameNeedsWorkspaceChars = computed(() => {
  const trimmed = name.value.trim();
  return canRequestDedicatedWorkspace.value && !workspace.value && trimmed.length > 0 && !hasWorkspaceNameChars(trimmed);
});
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
  if (!avatarDirty.value) avatar.value = copyBotAvatar(detail.avatar);
  if (!roleDirty.value) role.value = detail.role ?? "";
  if (!agentDirty.value) agent.value = detail.agent;
  botDedicatedWorkspace.value = detail.dedicatedWorkspace;
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
    if (!detailHydrated.value) void hydrateDetail(generation);
    try {
      await instancesStore.loadFormOptions(props.instanceId);
    } catch {
      // Ignore options load error; validation surfaces a missing agent.
    }
    if (generation !== dialogGeneration) return;
    syncFromStore();
    if (!agent.value && availableAgents.value.length > 0) {
      agent.value = availableAgents.value[0]?.name ?? "";
    }
    if (!canRequestDedicatedWorkspace.value && !workspace.value && availableWorkspaces.value.length > 0) {
      workspace.value = availableWorkspaces.value[0]?.name ?? "";
    }
    await loadCapabilities(false);
  })();
});
watch([agent, capabilityWorkspace, () => props.bot?.id], () => {
  // A new agent/workspace/bot is a new capability scope: the previous scope's
  // settled list and effort carry must not leak into it, even when the model
  // string matches. The loud read below replaces the list either way.
  lastSettledCapability = undefined;
  carriedEfforts.value = [];
  capabilityFailure.value = undefined;
  void loadCapabilities(false);
});
watch(
  () => instancesStore.capabilityEpochFor(props.instanceId, agent.value, capabilityWorkspace.value ?? "", props.bot?.id),
  () => { void loadCapabilities(false); },
);

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
  if (!canRequestDedicatedWorkspace.value && !workspace.value) {
    errorMessage.value = t("bot.validation.workspaceRequired");
    return;
  }
  // Create is disabled while this shows; this also covers Enter-to-submit.
  if (nameNeedsWorkspaceChars.value) return;
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
        avatar?: BotAvatarConfig | null;
        role?: string | null;
        instructions?: string | null;
        agent?: string;
        workspace?: string;
        dedicatedWorkspace?: boolean;
        model?: string | null;
        effort?: string | null;
        enabled?: boolean | null;
        // Every field is dirty-gated: required-ness is enforced by the
        // validation above (empty name never reaches the patch), so an
        // untouched name must not go out either — otherwise a remote rename
        // (rev2) would be rolled back by a stale rev1 name on save.
      } = {};
      if (nameDirty.value) patch.name = trimmedName;
      if (avatarDirty.value) patch.avatar = copyBotAvatar(avatar.value) ?? null;
      if (roleDirty.value) patch.role = role.value.trim() || null;
      if (instructionsDirty.value) patch.instructions = instructions.value.trim() || null;
      if (agentDirty.value) patch.agent = agent.value;
      if (workspaceDirty.value) {
        if (workspace.value) patch.workspace = workspace.value;
        else patch.dedicatedWorkspace = true;
      }
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
        ...(workspace.value ? { workspace: workspace.value } : {}),
        avatar: copyBotAvatar(avatar.value),
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
    errorMessage.value = describeSubmitError(err);
  } finally {
    submitting.value = false;
  }
}

const SUBMIT_ERROR_KEYS: Record<string, string> = {
  workspace_name_underivable: "bot.validation.dedicatedWorkspaceNameInvalid",
  // A concurrent editor (or a stale cached dialog) can lose this race; the
  // backend string would otherwise surface raw in the banner.
  dedicated_workspace_exists: "bot.validation.dedicatedWorkspaceExists",
};

function describeSubmitError(err: unknown): string {
  const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code ?? "") : "";
  const key = SUBMIT_ERROR_KEYS[code];
  if (key) return t(key);
  return err instanceof Error ? err.message : String(err);
}
</script>

<template>
  <!-- Escape the mobile sidebar's transformed containing block. -->
  <Teleport to="body">
  <DialogShell
    :panel-class="`relative flex max-h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-2xl ${view === 'appearance' ? 'max-w-3xl' : 'max-w-lg lg:max-w-2xl'}`"
    labelledby="bot-dialog-title"
    safe-area
    @close="emit('close')"
  >
      <!-- Header -->
      <div class="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-5 py-3.5">
        <div class="flex min-w-0 items-center gap-1.5">
          <button
            v-if="view === 'appearance'"
            type="button"
            data-test="bot-avatar-back"
            :aria-label="$t('common.back')"
            class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-fg-muted-overlay transition-colors hover:bg-fill-hover hover:text-fg"
            @click="view = 'basic'"
          >
            <ChevronLeft :size="16" />
          </button>
          <h2 id="bot-dialog-title" class="min-w-0 truncate text-base font-semibold text-fg">
            {{ view === 'appearance' ? $t("bot.avatar.appearanceTitle") : isEditing ? $t("bot.dialog.editTitle") : $t("bot.dialog.createTitle") }}
          </h2>
        </div>
        <button
          type="button"
          :aria-label="$t('common.close')"
          class="grid h-7 w-7 place-items-center rounded-lg text-fg-muted-overlay transition-colors hover:bg-fill-hover hover:text-fg"
          @click="navigateBack"
        >
          <X :size="16" />
        </button>
      </div>

      <!-- Form Content -->
      <form class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 space-y-4 thin-scroll" @submit.prevent="submit">
        <!-- Error Banner -->
        <div v-if="errorMessage" class="flex items-start gap-2.5 rounded-lg bg-danger/10 p-3 text-xs text-danger-overlay">
          <AlertCircle :size="15" class="mt-0.5 shrink-0" />
          <div class="flex-1 leading-relaxed">{{ errorMessage }}</div>
        </div>

        <!-- Detail hydration failure: fail-closed (Save stays gated so unseen
          instructions cannot be wiped) with an explicit Retry. -->
        <div v-if="isEditing && props.bot && !detailHydrated && detailLoadError"
             data-test="bot-detail-retry"
             class="flex items-center justify-between gap-2.5 rounded-lg bg-warning/10 p-3 text-xs text-warn-overlay">
          <div class="flex-1 leading-relaxed">{{ $t("bot.validation.detailLoadFailed", { msg: detailLoadError }) }}</div>
          <button type="button"
                  data-test="bot-detail-retry-button"
                  :disabled="detailLoading"
                  class="flex items-center gap-1 rounded-sm bg-warning/20 px-2 py-0.5 font-medium hover:bg-warning/30 transition-colors disabled:opacity-50"
                  @click="retryHydrate">
            <Loader2 v-if="detailLoading" :size="12" class="animate-spin motion-reduce:animate-none" />
            <span>{{ $t("bot.prompt.retry") }}</span>
          </button>
        </div>
        <div v-else-if="isEditing && props.bot && !detailHydrated && detailLoading" role="status"
           :aria-label="$t('bot.validation.detailLoading')" class="space-y-2 p-3">
          <span class="sk-bar block h-2.5 w-24 rounded-sm bg-fg/[0.08]" />
          <span class="sk-bar block h-2.5 w-full rounded-sm bg-fg/[0.05]" />
          <span class="sk-bar block h-2.5 w-2/3 rounded-sm bg-fg/[0.05]" />
        </div>

        <section v-show="view === 'basic'" id="bot-panel-basic" class="space-y-4">
        <div data-test="bot-group-identity" class="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0 first:space-y-3">
          <h3 class="text-xs font-semibold tracking-wide text-fg">{{ $t("bot.groups.identity") }}</h3>
        <!-- Avatar: click to view enlarged; the corner badge opens the appearance
             editor. Narrow screens center the avatar above the fields; from sm up
             it sits beside them, the two fields stacked to its full height. -->
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
          <div class="relative shrink-0 self-center">
            <button type="button" data-test="bot-avatar-quick-view"
                    :aria-label="$t('bot.avatar.quickView')"
                    aria-haspopup="dialog"
                    class="block rounded-2xl outline-none transition-transform duration-150 ease-ui motion-reduce:transition-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-accent"
                    @click="avatarQuickView = true">
              <span class="sm:hidden"><BotAvatar :avatar="avatar" :driver="avatarDriver" :name="name" :size="96" static /></span>
              <span class="hidden sm:block"><BotAvatar :avatar="avatar" :driver="avatarDriver" :name="name" :size="128" static /></span>
            </button>
            <button type="button" data-test="bot-avatar-edit"
                    :aria-label="$t('bot.avatar.editAppearance')"
                    class="absolute bottom-0.5 right-0.5 grid h-6 w-6 place-items-center rounded-full bg-raised text-fg shadow-press transition-colors hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent"
                    @click="view = 'appearance'">
              <Pencil :size="12" />
            </button>
          </div>
          <div class="min-w-0 flex-1 space-y-3">
            <!-- Name -->
            <div>
              <label for="bot-name" class="block text-xs font-medium text-fg-muted mb-1.5">
                {{ $t("bot.fields.name") }} <span class="text-danger-overlay">*</span>
              </label>
              <input
                id="bot-name"
                v-model="name"
                @input="nameDirty = true"
                type="text"
                required
                maxlength="60"
                :placeholder="$t('bot.fields.namePlaceholder')"
                :aria-invalid="nameNeedsWorkspaceChars ? 'true' : undefined"
                :aria-describedby="nameNeedsWorkspaceChars ? 'bot-name-error' : undefined"
                class="w-full rounded-lg ui-well px-3 py-1.5 text-sm outline-none transition-colors"
                :class="nameNeedsWorkspaceChars ? 'ring-1 ring-danger focus-visible:ring-2 focus-visible:ring-danger' : ''"
              />
              <p v-if="nameNeedsWorkspaceChars" id="bot-name-error" data-test="bot-name-error" role="alert" class="mt-1 text-xs text-danger-overlay">
                {{ $t("bot.validation.dedicatedWorkspaceNameInvalid") }}
              </p>
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
                class="w-full rounded-lg ui-well px-3 py-1.5 text-sm outline-none transition-colors"
              />
            </div>
          </div>
        </div>
        </div>

        <div data-test="bot-group-does" class="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0 first:space-y-3">
          <div class="space-y-1">
            <h3 class="text-xs font-semibold tracking-wide text-fg">{{ $t("bot.groups.does") }}</h3>
            <p class="text-xs text-fg-muted">{{ $t("bot.groups.doesHint") }}</p>
          </div>
        <!-- Agent & Workspace row -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <!-- Agent -->
          <div>
            <label for="bot-agent" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.agent") }} <span class="text-danger-overlay">*</span>
            </label>
            <p v-if="identityLocked" class="mb-1.5 text-xs text-fg-muted">
              {{ $t("bot.lifecycle.identityLocked") }}
            </p>
            <SelectMenu
              id="bot-agent"
              v-model="agent"
              data-test="bot-agent"
              :aria-label='$t("bot.fields.agent")'
              :title='$t("bot.fields.agent")'
              :placeholder='$t("bot.fields.agent")'
              :disabled="identityLocked"
              :groups="agentGroups"
              @update:model-value="agentDirty = true"
            />
          </div>

          <!-- Workspace -->
          <div>
            <label for="bot-workspace" class="block text-xs font-medium text-fg-muted mb-1.5">
              {{ $t("bot.fields.workspace") }} <span v-if="workspaceRequired" class="text-danger-overlay">*</span>
            </label>
            <SelectMenu
              v-if="canChooseWorkspace"
              id="bot-workspace"
              v-model="workspace"
              data-test="bot-workspace"
              :aria-label='$t("bot.fields.workspace")'
              :title='$t("bot.fields.workspace")'
              :placeholder='$t("bot.fields.workspace")'
              :disabled="identityLocked"
              :groups="workspaceGroups"
              @update:model-value="workspaceDirty = true"
            />
            <!-- A new Bot has no workspace to choose: the daemon allocates one,
                 named after the Bot, so two Bots can never share a tree. -->
            <p v-else data-test="bot-dedicated-workspace-hint" class="rounded-lg ui-well px-3 py-1.5 text-sm text-fg-muted">
              {{ $t("bot.fields.dedicatedWorkspaceHint") }}
            </p>
          </div>
        </div>
        </div>

        <div data-test="bot-group-knows" class="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0 first:space-y-3">
          <div class="space-y-1">
            <h3 class="text-xs font-semibold tracking-wide text-fg">{{ $t("bot.groups.knows") }}</h3>
            <p class="text-xs text-fg-muted">{{ $t("bot.groups.knowsHint") }}</p>
          </div>
        <!-- Instructions -->
        <div>
          <label for="bot-instructions" class="block text-xs font-medium text-fg-muted mb-1.5">
            {{ $t("bot.fields.instructions") }}
          </label>
          <div class="relative">
            <textarea
              id="bot-instructions"
              v-model="instructions"
              rows="5"
              :disabled="!detailHydrated"
              :placeholder="detailHydrated ? $t('bot.fields.instructionsPlaceholder') : $t('bot.fields.instructionsLoading')"
              class="w-full rounded-lg ui-well px-3 py-2 text-sm outline-none transition-colors resize-y disabled:cursor-wait disabled:opacity-60"
              @input="instructionsDirty = true"
            />
            <!-- Hydrating reads as a skeleton over the field, not as a caption the user has
                 to parse: the placeholder text stays in the DOM (the disabled field's own
                 contract) but is covered until the real value arrives. -->
            <div v-if="!detailHydrated && detailLoading" aria-hidden="true"
                 class="pointer-events-none absolute inset-0 space-y-2 rounded-lg bg-raised/85 px-3 py-3 backdrop-blur-[2px] dark:bg-bg/70">
              <span class="sk-bar block h-2.5 w-3/4 rounded-sm bg-fg/[0.08]" :style="{ '--sk-delay': '0ms' }" />
              <span class="sk-bar block h-2.5 w-1/2 rounded-sm bg-fg/[0.06]" :style="{ '--sk-delay': '110ms' }" />
              <span class="sk-bar block h-2.5 w-2/3 rounded-sm bg-fg/[0.05]" :style="{ '--sk-delay': '220ms' }" />
            </div>
          </div>
          <!-- A new Bot has no turns yet: the "applies to later turns" note
               only makes sense when editing, like ModelPicker's showAppliesLater. -->
          <p v-if="isEditing" data-test="bot-instructions-hint" class="mt-1 text-xs text-fg-muted">
            {{ $t("bot.fields.instructionsHint") }}
          </p>
        </div>
        </div>

        <div data-test="bot-group-brain" class="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0 first:space-y-3">
          <div class="space-y-1">
            <h3 class="text-xs font-semibold tracking-wide text-fg">{{ $t("bot.groups.brain") }}</h3>
            <p class="text-xs text-fg-muted">{{ $t("bot.groups.brainHint") }}</p>
          </div>
        <ModelPicker
          audience="bot"
          :show-applies-later="isEditing"
          :state="capability"
          :refreshing="capabilityRefreshing"
          :failure="capabilityFailure"
          :model="model"
          :effort="effort"
          :carried-efforts="carriedEfforts"
          model-test-id="bot-model"
          list-test-id="bot-model-list"
          @update:model="onModelPick"
          @update:effort="onEffortPick"
          @fetch="loadCapabilities(true)"
        />
        </div>
        <div data-test="bot-group-rules" class="space-y-3 border-t border-hairline pt-4 first:border-t-0 first:pt-0 first:space-y-3">
          <div class="space-y-1">
            <h3 class="text-xs font-semibold tracking-wide text-fg">{{ $t("bot.groups.rules") }}</h3>
            <p class="text-xs text-fg-muted">{{ $t("bot.groups.rulesHint") }}</p>
          </div>
        <div>
            <label class="flex items-center gap-2 cursor-pointer text-sm">
              <input
                v-model="enabled"
                @change="enabledDirty = true"
                type="checkbox"
                class="rounded-sm border-hairline text-accent focus:ring-accent"
              />
              <span class="font-medium text-xs">{{ $t("bot.fields.enabled") }}</span>
            </label>
          </div>
        <p v-if="storedEnabled === true && !enabled"
           data-test="bot-dialog-disable-note"
           class="rounded-lg bg-warn/10 px-3 py-2 text-xs leading-relaxed text-fg">
          {{ $t("bot.lifecycle.disableNote") }}
        </p>
        <p v-else-if="storedEnabled === false && enabled"
           data-test="bot-dialog-reenable-note"
           class="rounded-lg bg-warn/10 px-3 py-2 text-xs leading-relaxed text-fg">
          {{ $t("bot.lifecycle.reenableNote") }}
        </p>
        </div>
        </section>
        <section v-show="view === 'appearance'" id="bot-panel-appearance">
          <BotAvatarEditor v-model:preview-state="avatarPreviewState" :model-value="avatar" :driver="avatarDriver" :name="name" @update:model-value="onAvatarPick" />
        </section>
      </form>

      <!-- Footer -->
      <div class="flex shrink-0 items-center justify-end gap-2.5 border-t border-hairline bg-bg/30 px-5 py-3">
        <UiButton
          v-if="isEditing && props.bot && props.bot.retired !== true"
          variant="danger-ghost"
          size="sm"
          data-test="bot-dialog-remove"
          class="mr-auto"
          @click="removalOpen = true"
        >
          {{ $t("bot.removal.action") }}
        </UiButton>
        <UiButton variant="secondary" size="sm" @click="navigateBack">
          {{ $t("common.cancel") }}
        </UiButton>
        <UiButton
          size="sm"
          :disabled="submitting || !name.trim() || nameNeedsWorkspaceChars || (isEditing && !!props.bot && !detailHydrated)"
          @click="submit"
        >
          <Loader2 v-if="submitting" :size="13" class="animate-spin motion-reduce:animate-none" />
          <span>{{ isEditing ? $t("common.save") : $t("common.create") }}</span>
        </UiButton>
      </div>
      <BotAvatarQuickView v-if="avatarQuickView" :avatar="avatar" :driver="avatarDriver" :name="name"
                          @close="avatarQuickView = false" />
  </DialogShell>
    <!-- Sibling, not a child: the removal dialog must not be clipped by the
         panel's `overflow-hidden`, and it stacks one rung higher. -->
    <BotRemovalDialog
      v-if="removalOpen && props.bot"
      :bot-name="props.bot.name"
      :preview="() => directBotsStore.previewBotRemoval(props.instanceId, props.bot!.id)"
      :remove="(input) => directBotsStore.removeBot(props.instanceId, { botId: props.bot!.id, ...input })"
      :get-operation="(id) => directBotsStore.getLifecycleOperation(props.instanceId, id)"
      :abandon-run="(runId) => directBotsStore.abandonRun(props.instanceId, runId)"
      :supports-workspace-cleanup="supportsBotDedicatedWorkspaceCleanup(inst)"
      @close="removalOpen = false"
      @removed="removalOpen = false; emit('close')"
    />
  </Teleport>
</template>
