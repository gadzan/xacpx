<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
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
// Detail hydration for summary-backed edits: the form must not submit
// until the authoritative detail arrives. Otherwise an early Save would send
// instructions=null and silently wipe backend instructions the user never
// saw. Gated on the store's authoritative-hydration flag — never on the
// optional instructions field itself, which a complete detail legitimately
// omits when empty.
const detailHydrated = ref(
  !props.bot || directBotsStore.isBotDetailHydrated(props.instanceId, props.bot.id),
);
const detailLoading = ref(false);
const detailLoadError = ref<string | null>(null);

// Prepopulate defaults if create mode. A generation counter fences the async
// form-options + instructions loads: closing/reopening (or switching bots) must
// not let a stale response overwrite the current dialog's fields. Unmount bumps
// the generation so a late resolution after close is dropped.
let dialogGeneration = 0;
onUnmounted(() => { dialogGeneration++; });
// Retryable detail hydration: a transient bots.get failure must surface a
// visible error + Retry instead of silently wedging Save disabled. A late
// background success (e.g. bots-changed converging the store) also releases
// the gate via syncHydratedFromStore(). Untouched-fields-only fill preserves
// user edits across retries.
function fillUntouchedFromDetail(detail: BotDetailDto): void {
  // Full hydration from the authoritative detail: the open-time summary
  // may predate a remote update (rev2 landed after the sidebar rendered
  // rev1). Overwrite only fields the user has not touched since open;
  // every field uses an explicit dirty flag because type-then-revert
  // (old -> tmp -> old) looks pristine under value comparison but is a
  // real user choice that must survive hydration.
  if (!instructionsDirty.value) {
    if (detail.instructions) instructions.value = detail.instructions;
    else if (props.bot && detail.profileRevision !== props.bot.profileRevision) instructions.value = "";
  }
  if (!nameDirty.value) name.value = detail.name;
  if (!avatarDirty.value) avatar.value = detail.avatar ?? "";
  if (!roleDirty.value) role.value = detail.role ?? "";
  if (!agentDirty.value) agent.value = detail.agent;
  if (!workspaceDirty.value) workspace.value = detail.workspace;
  if (!modelDirty.value) model.value = detail.model ?? "";
  if (!effortDirty.value) effort.value = detail.effort ?? "";
  if (!enabledDirty.value) enabled.value = detail.enabled;
  // detail load also converges authoritative lifecycle (hasRuntime);
  // identityLocked reads the store, so no local copy is needed.
}
function syncHydratedFromStore(): boolean {
  if (!props.bot || detailHydrated.value) return detailHydrated.value;
  if (directBotsStore.isBotDetailHydrated(props.instanceId, props.bot.id)) {
    const detail = directBotsStore.botDetails[`${props.instanceId}:${props.bot.id}`];
    if (detail) fillUntouchedFromDetail(detail);
    detailHydrated.value = true;
    detailLoadError.value = null;
    return true;
  }
  return false;
}
async function hydrateDetail(generation: number): Promise<void> {
  if (!props.bot || syncHydratedFromStore()) return;
  detailLoading.value = true;
  detailLoadError.value = null;
  try {
    const detail = await directBotsStore.loadBotDetail(props.instanceId, props.bot.id);
    if (generation !== dialogGeneration) return;
    fillUntouchedFromDetail(detail);
    detailHydrated.value = true;
  } catch (err: unknown) {
    if (generation !== dialogGeneration) return;
    // Fail-closed with a recovery path: Save stays gated (it cannot wipe
    // unseen instructions), but the user gets an explicit Retry instead of
    // a silently dead form.
    detailLoadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (generation === dialogGeneration) detailLoading.value = false;
  }
}
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
  if (props.bot && !directBotsStore.isBotDetailHydrated(props.instanceId, props.bot.id)) {
    await hydrateDetail(generation);
  }
  // A background bots-changed may converge authority while this dialog sits
  // in the failed state: release the gate without requiring a manual retry.
  syncHydratedFromStore();
  if (!agent.value && availableAgents.value.length > 0) {
    agent.value = availableAgents.value[0]?.name ?? "";
  }
  if (!workspace.value && availableWorkspaces.value.length > 0) {
    workspace.value = availableWorkspaces.value[0]?.name ?? "";
  }
});

function retryHydrate(): void {
  // Reuse the mount generation: the dialog is still open, so the in-flight
  // fence stays valid; a close/reopen bumps it and drops late resolutions.
  void hydrateDetail(dialogGeneration);
}
// Reactive bridge for background authority convergence: bots-changed (or any
// other path) may hydrate the store while this dialog sits in the failed
// state. The plain botDetailHydrated map is non-reactive, so watch the
// reactive sources that always change alongside it — the cached detail row
// and the summary revision. syncHydratedFromStore() is sync and generation
// fenced by mount/unmount disposal, so late store writes cannot leak into a
// closed dialog.
watch(
  () => {
    const botId = props.bot?.id;
    if (!botId) return null;
    const key = `${props.instanceId}:${botId}`;
    return [
      directBotsStore.botDetails[key],
      directBotsStore.botsByInstance[props.instanceId]?.find((b) => b.id === botId)?.profileRevision,
    ] as const;
  },
  () => {
    syncHydratedFromStore();
  },
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
      if (modelDirty.value) patch.model = model.value.trim() || null;
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
              @input="modelDirty = true"
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
              @change="effortDirty = true"
              @input="effortDirty = true"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
            >
              <option value="">{{ $t("bot.fields.effortDefault") }}</option>
              <option v-for="opt in availableEffortOptions" :key="opt" :value="opt">{{ opt }}</option>
            </select>
            <template v-else>
              <input
                id="bot-effort"
                v-model="effort"
                @change="effortDirty = true"
                @input="effortDirty = true"
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
          :disabled="submitting || !name.trim() || (isEditing && !!props.bot && !detailHydrated)"
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
