<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Loader2, Plus, Trash2, X } from "lucide-vue-next";
import type { BotSummaryDto, ConversationRunStateDto, GroupSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useGroupsStore, type GroupMemberWork } from "../stores/groups";
import { useModalA11y } from "../lib/use-modal-a11y";
import { pushToast } from "../lib/use-toasts";

// The backend rejects a longer title or description.
const TITLE_MAX = 80;
const DESCRIPTION_MAX = 16384;

const props = defineProps<{
  instanceId: string;
  group?: GroupSummaryDto;
}>();

const emit = defineEmits<{
  close: [];
  saved: [group: GroupSummaryDto];
  deleted: [groupId: string];
  createBot: [];
}>();

const { t } = useI18n();
const directBotsStore = useDirectBotsStore();
const groupsStore = useGroupsStore();

const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

// The edit baseline is what the dialog opened with. The prop may be a live
// store row, and diffing against a row that a remote edit already moved would
// send untouched fields and roll that edit back.
const opened: GroupSummaryDto | undefined = props.group
  ? { ...props.group, botIds: [...props.group.botIds] }
  : undefined;
const isEditing = !!opened;
const liveGroup = computed<GroupSummaryDto | undefined>(() => {
  if (!opened) return undefined;
  return groupsStore.groupsByInstance[props.instanceId]?.find((g) => g.id === opened.id) ?? props.group;
});
const isDeleting = computed(() => liveGroup.value?.lifecycle === "deleting");

const title = ref(opened?.title ?? "");
const description = ref(opened?.description ?? "");
const memberIds = ref<string[]>([...(opened?.botIds ?? [])]);
const leadBotId = ref(opened?.leadBotId ?? "");
// Create mode keeps suggesting the first enabled member until the user picks a
// Lead. Edit mode starts from the saved Lead, which may legitimately be none.
const leadTouched = ref(isEditing);
const leadReassigned = ref<{ previous: string; next: string } | null>(null);

const submitting = ref(false);
const errorMessage = ref<string | null>(null);
const confirmingDelete = ref(false);
const deleteTopicCount = ref<number | null>(null);
const deletingNow = ref(false);

const catalogLoading = ref(false);
const catalogError = ref<string | null>(null);
const bots = computed<BotSummaryDto[]>(() => directBotsStore.botsByInstance[props.instanceId] ?? []);
const botsById = computed(() => new Map(bots.value.map((b) => [b.id, b])));
const catalogReady = computed(() => directBotsStore.botsLoaded[props.instanceId] === true || bots.value.length > 0);
const unknownMemberIds = computed(() => memberIds.value.filter((id) => !botsById.value.has(id)));

const duplicateNames = computed(() => {
  const counts = new Map<string, number>();
  for (const bot of bots.value) {
    const key = bot.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([key]) => key));
});

function hasDuplicateName(bot: BotSummaryDto): boolean {
  return duplicateNames.value.has(bot.name.trim().toLowerCase());
}

function botLabel(botId: string): string {
  const bot = botsById.value.get(botId);
  if (!bot) return botId;
  return hasDuplicateName(bot) ? `${bot.name} (${bot.id})` : bot.name;
}

function suggestedLead(ids: string[]): string {
  return ids.find((id) => botsById.value.get(id)?.enabled === true) ?? "";
}

function toggleMember(botId: string): void {
  memberIds.value = memberIds.value.includes(botId)
    ? memberIds.value.filter((id) => id !== botId)
    : [...memberIds.value, botId];
}

watch([memberIds, botsById], () => {
  if (leadBotId.value && !memberIds.value.includes(leadBotId.value)) {
    const previous = leadBotId.value;
    leadBotId.value = suggestedLead(memberIds.value);
    leadReassigned.value = { previous, next: leadBotId.value };
    return;
  }
  if (!leadTouched.value) leadBotId.value = suggestedLead(memberIds.value);
});

function onLeadChange(): void {
  leadTouched.value = true;
  leadReassigned.value = null;
}

const canSave = computed(() =>
  !submitting.value
  && !deletingNow.value
  && !isDeleting.value
  && catalogReady.value
  && title.value.trim().length > 0
  && memberIds.value.length >= 2,
);

async function loadCatalog(): Promise<void> {
  catalogLoading.value = true;
  catalogError.value = null;
  try {
    await directBotsStore.loadBots(props.instanceId);
  } catch (err: unknown) {
    catalogError.value = err instanceof Error ? err.message : String(err);
  } finally {
    catalogLoading.value = false;
  }
}

onMounted(() => {
  if (directBotsStore.botsLoaded[props.instanceId] !== true) void loadCatalog();
});

function errorCode(err: unknown): string {
  return err instanceof Error && "code" in err ? String((err as { code: unknown }).code ?? "") : "";
}

// No response from the hub or connector says nothing about whether the write
// landed, so these never read as a plain failure.
const OUTCOME_UNKNOWN = new Set(["timeout", "instance-offline", "instance-reconnected"]);

const ERROR_KEYS: Record<string, string> = {
  title_required: "group.manage.errors.titleRequired",
  title_too_long: "group.manage.errors.titleTooLong",
  description_too_long: "group.manage.errors.descriptionTooLong",
  group_membership_min: "group.manage.errors.membershipMin",
  group_membership_duplicate: "group.manage.errors.membershipDuplicate",
  group_lead_not_member: "group.manage.errors.leadNotMember",
  bot_not_found: "group.manage.errors.botNotFound",
  group_member_has_work: "group.manage.errors.memberHasWork",
  conversation_deleting: "group.manage.errors.deleting",
  "unknown-type": "bot.errors.connectorOutdated",
};

function describeError(err: unknown): string {
  const key = ERROR_KEYS[errorCode(err)];
  if (key) return t(key);
  return err instanceof Error ? err.message : String(err);
}

const memberWork = ref<GroupMemberWork[] | null>(null);
const memberWorkLoading = ref(false);
const memberWorkError = ref<string | null>(null);
const stoppingRunIds = ref<string[]>([]);

function removedMemberIds(): string[] {
  const before = new Set([...(opened?.botIds ?? []), ...(liveGroup.value?.botIds ?? [])]);
  return [...before].filter((id) => !memberIds.value.includes(id));
}

async function locateMemberWork(): Promise<void> {
  if (!opened) return;
  memberWorkLoading.value = true;
  memberWorkError.value = null;
  try {
    memberWork.value = await groupsStore.findMemberWork(props.instanceId, opened.id, removedMemberIds());
  } catch (err: unknown) {
    memberWork.value = null;
    memberWorkError.value = describeError(err);
  } finally {
    memberWorkLoading.value = false;
  }
}

async function stopRun(runId: string): Promise<void> {
  stoppingRunIds.value = [...stoppingRunIds.value, runId];
  try {
    await groupsStore.cancelRun(props.instanceId, runId);
  } catch (err: unknown) {
    memberWorkError.value = describeError(err);
  } finally {
    stoppingRunIds.value = stoppingRunIds.value.filter((id) => id !== runId);
  }
  await locateMemberWork();
}

const RUN_STATE_KEYS: Partial<Record<ConversationRunStateDto, string>> = {
  queued: "bot.run.queued",
  running: "bot.run.running",
  "waiting-human": "bot.run.waitingHuman",
  indeterminate: "bot.run.indeterminate",
};

function runStateLabel(state: ConversationRunStateDto): string {
  const key = RUN_STATE_KEYS[state];
  return key ? t(key) : state;
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

async function submit(): Promise<void> {
  if (submitting.value || deletingNow.value || isDeleting.value || !catalogReady.value) return;
  const trimmedTitle = title.value.trim();
  if (!trimmedTitle) {
    errorMessage.value = t("group.manage.errors.titleRequired");
    return;
  }
  if (memberIds.value.length < 2) {
    errorMessage.value = t("group.manage.errors.membershipMin");
    return;
  }
  const trimmedDescription = description.value.trim();
  submitting.value = true;
  errorMessage.value = null;
  memberWork.value = null;
  memberWorkError.value = null;
  try {
    let saved: GroupSummaryDto;
    if (opened) {
      const patch: { title?: string; description?: string | null; botIds?: string[]; leadBotId?: string | null } = {};
      if (trimmedTitle !== opened.title) patch.title = trimmedTitle;
      if (trimmedDescription !== (opened.description ?? "")) patch.description = trimmedDescription || null;
      if (!sameMembers(memberIds.value, opened.botIds)) patch.botIds = [...memberIds.value];
      if ((leadBotId.value || undefined) !== opened.leadBotId) patch.leadBotId = leadBotId.value || null;
      if (Object.keys(patch).length === 0) {
        emit("close");
        return;
      }
      saved = await groupsStore.updateGroup(props.instanceId, opened.id, patch);
    } else {
      saved = await groupsStore.createGroup(props.instanceId, {
        title: trimmedTitle,
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
        botIds: [...memberIds.value],
        ...(leadBotId.value ? { leadBotId: leadBotId.value } : {}),
      });
    }
    emit("saved", saved);
    emit("close");
  } catch (err: unknown) {
    const code = errorCode(err);
    if (OUTCOME_UNKNOWN.has(code)) {
      errorMessage.value = t(opened ? "group.manage.errors.updateUncertain" : "group.manage.errors.createUncertain");
      void groupsStore.loadGroups(props.instanceId).catch(() => {});
    } else {
      errorMessage.value = describeError(err);
      if (code === "group_member_has_work") await locateMemberWork();
    }
  } finally {
    submitting.value = false;
  }
}

async function askDelete(): Promise<void> {
  if (!opened) return;
  confirmingDelete.value = true;
  errorMessage.value = null;
  deleteTopicCount.value = null;
  try {
    const detail = await groupsStore.loadGroupDetail(props.instanceId, opened.id);
    deleteTopicCount.value = detail.topics.length;
  } catch {
    deleteTopicCount.value = null;
  }
}

async function confirmDelete(): Promise<void> {
  if (!opened) return;
  const groupId = opened.id;
  const groupTitle = liveGroup.value?.title ?? opened.title;
  deletingNow.value = true;
  errorMessage.value = null;
  try {
    await groupsStore.deleteGroup(props.instanceId, groupId);
    pushToast("success", "group.manage.deleted", { title: groupTitle });
    emit("deleted", groupId);
    emit("close");
  } catch (err: unknown) {
    confirmingDelete.value = false;
    errorMessage.value = OUTCOME_UNKNOWN.has(errorCode(err))
      ? t("group.manage.errors.deleteUncertain")
      : t("group.manage.errors.deleteFailed", { msg: describeError(err) });
  } finally {
    deletingNow.value = false;
  }
}
</script>

<template>
  <!-- Escape the mobile sidebar's transformed containing block. -->
  <Teleport to="body">
  <div class="fixed inset-0 z-50 flex h-dvh items-center justify-center bg-black/50 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] backdrop-blur-sm"
       @click.self="emit('close')">
    <div ref="dialogEl"
         role="dialog"
         aria-modal="true"
         aria-labelledby="group-dialog-title"
         tabindex="-1"
         data-test="group-dialog"
         class="flex max-h-full min-h-0 w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl">
      <div class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
        <h2 id="group-dialog-title" class="text-base font-semibold">
          {{ isEditing ? $t("group.manage.editTitle") : $t("group.manage.createTitle") }}
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

      <form class="thin-scroll min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4" @submit.prevent="submit">
        <div v-if="isDeleting"
             data-test="group-dialog-deleting"
             class="flex items-start justify-between gap-2.5 rounded-lg border border-warn/30 bg-warn/10 p-3 text-xs text-warn">
          <div class="flex-1 leading-relaxed">{{ $t("group.manage.deletingNotice") }}</div>
          <button type="button"
                  data-test="group-dialog-retry-delete"
                  :disabled="deletingNow"
                  class="flex shrink-0 items-center gap-1 rounded bg-warn/20 px-2 py-0.5 font-medium transition-colors hover:bg-warn/30 disabled:opacity-50"
                  @click="confirmDelete">
            <Loader2 v-if="deletingNow" :size="12" class="animate-spin" />
            <span>{{ $t("group.manage.retryDelete") }}</span>
          </button>
        </div>

        <div v-if="errorMessage"
             data-test="group-dialog-error"
             class="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          <AlertCircle :size="15" class="mt-0.5 shrink-0" />
          <div class="flex-1 leading-relaxed">{{ errorMessage }}</div>
        </div>

        <div v-if="memberWorkLoading || memberWork || memberWorkError"
             data-test="group-dialog-member-work"
             class="space-y-2 rounded-lg border border-border bg-bg p-3 text-xs">
          <div v-if="memberWorkLoading" class="flex items-center gap-1.5 text-fg-muted">
            <Loader2 :size="12" class="animate-spin" />
            <span>{{ $t("group.manage.memberWorkLoading") }}</span>
          </div>
          <div v-else-if="memberWorkError" class="text-danger">
            {{ $t("group.manage.memberWorkFailed", { msg: memberWorkError }) }}
          </div>
          <template v-else-if="memberWork && memberWork.length > 0">
            <p class="font-medium">{{ $t("group.manage.memberWorkTitle") }}</p>
            <div v-for="work in memberWork"
                 :key="work.run.id"
                 data-test="group-dialog-member-work-row"
                 class="flex items-center justify-between gap-2">
              <span class="min-w-0 flex-1 truncate">
                {{ $t("group.manage.memberWorkRow", {
                  topic: work.topic.title || $t("bot.topic.default"),
                  state: runStateLabel(work.run.state),
                  members: work.botIds.map(botLabel).join(", "),
                }) }}
              </span>
              <button type="button"
                      :data-test="`group-dialog-stop-run-${work.run.id}`"
                      :disabled="stoppingRunIds.includes(work.run.id)"
                      class="flex shrink-0 items-center gap-1 rounded bg-danger/15 px-2 py-0.5 font-medium text-danger transition-colors hover:bg-danger/25 disabled:opacity-50"
                      @click="stopRun(work.run.id)">
                <Loader2 v-if="stoppingRunIds.includes(work.run.id)" :size="12" class="animate-spin" />
                <span>{{ $t("bot.prompt.stopRun") }}</span>
              </button>
            </div>
            <p class="text-fg-muted">{{ $t("group.manage.memberWorkHint") }}</p>
          </template>
          <p v-else-if="memberWork" class="text-fg-muted">{{ $t("group.manage.memberWorkNone") }}</p>
          <button v-if="!memberWorkLoading"
                  type="button"
                  data-test="group-dialog-member-work-refresh"
                  class="font-medium text-accent hover:underline"
                  @click="locateMemberWork">
            {{ $t("group.manage.refresh") }}
          </button>
        </div>

        <fieldset :disabled="isDeleting || deletingNow" class="min-w-0 space-y-4">
          <div>
            <label for="group-title" class="mb-1.5 block text-xs font-medium text-fg-muted">
              {{ $t("group.manage.name") }} <span class="text-danger">*</span>
            </label>
            <input
              id="group-title"
              v-model="title"
              data-test="group-dialog-title"
              type="text"
              required
              :maxlength="TITLE_MAX"
              :placeholder="$t('group.manage.namePlaceholder')"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div>
            <label for="group-description" class="mb-1.5 block text-xs font-medium text-fg-muted">
              {{ $t("group.manage.description") }}
            </label>
            <textarea
              id="group-description"
              v-model="description"
              data-test="group-dialog-description"
              rows="2"
              :maxlength="DESCRIPTION_MAX"
              :placeholder="$t('group.manage.descriptionPlaceholder')"
              class="w-full resize-y rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none transition-colors focus:border-accent"
            />
          </div>

          <div>
            <div class="mb-1.5 flex items-baseline justify-between">
              <span class="text-xs font-medium text-fg-muted">
                {{ $t("group.manage.members") }} <span class="text-danger">*</span>
              </span>
              <span data-test="group-dialog-member-count" class="text-[11px] text-fg-muted">
                {{ $t("group.manage.membersSelected", { count: memberIds.length }) }}
              </span>
            </div>
            <p class="mb-1.5 text-[11px] text-fg-muted">{{ $t("group.manage.membersHint") }}</p>

            <div v-if="catalogLoading && !catalogReady" class="flex items-center gap-1.5 py-2 text-xs text-fg-muted">
              <Loader2 :size="12" class="animate-spin" />
              <span>{{ $t("group.manage.botsLoading") }}</span>
            </div>
            <div v-else-if="catalogError && !catalogReady"
                 data-test="group-dialog-bots-error"
                 class="flex items-center justify-between gap-2 py-2 text-xs text-danger">
              <span>{{ $t("group.manage.botsLoadFailed", { msg: catalogError }) }}</span>
              <button type="button" class="font-medium text-accent hover:underline" @click="loadCatalog">
                {{ $t("common.retry") }}
              </button>
            </div>
            <template v-else>
              <div v-if="!isEditing && catalogReady && bots.length < 2"
                   data-test="group-dialog-need-bots"
                   class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs">
                <span class="flex-1 leading-relaxed">{{ $t("group.manage.needBots", { count: bots.length }) }}</span>
                <button type="button"
                        data-test="group-dialog-create-bot"
                        class="flex shrink-0 items-center gap-1 rounded bg-accent px-2 py-1 font-medium text-accent-fg hover:opacity-90"
                        @click="emit('createBot')">
                  <Plus :size="12" />
                  <span>{{ $t("bot.actions.newBot") }}</span>
                </button>
              </div>
              <div class="max-h-56 space-y-px overflow-y-auto rounded-lg border border-border bg-bg p-1 thin-scroll">
                <label v-for="bot in bots"
                       :key="bot.id"
                       :data-test="`group-dialog-member-${bot.id}`"
                       class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
                  <input type="checkbox"
                         :checked="memberIds.includes(bot.id)"
                         class="rounded border-border text-accent focus:ring-accent"
                         @change="toggleMember(bot.id)" />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-sm" :class="bot.enabled ? 'text-fg' : 'text-fg-muted'">
                      {{ bot.name }}
                      <span v-if="hasDuplicateName(bot)" data-test="group-dialog-member-id" class="font-mono text-[10.5px] text-fg-muted">{{ bot.id }}</span>
                    </span>
                    <span class="truncate text-[11px] text-fg-muted">{{ [bot.role, bot.agent].filter(Boolean).join(" · ") }}</span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1 text-[10.5px] text-fg-muted">
                    <span class="h-1.5 w-1.5 rounded-full" :class="bot.enabled ? 'bg-run' : 'bg-fg-muted'" />
                    {{ bot.enabled ? $t("bot.status.enabled") : $t("bot.status.disabled") }}
                  </span>
                </label>
                <label v-for="id in unknownMemberIds"
                       :key="id"
                       :data-test="`group-dialog-member-${id}`"
                       class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
                  <input type="checkbox" checked class="rounded border-border" @change="toggleMember(id)" />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{{ id }}</span>
                </label>
              </div>
            </template>
          </div>

          <div>
            <label for="group-lead" class="mb-1.5 block text-xs font-medium text-fg-muted">
              {{ $t("group.manage.lead") }}
            </label>
            <select
              id="group-lead"
              v-model="leadBotId"
              data-test="group-dialog-lead"
              class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent"
              @change="onLeadChange"
            >
              <option value="">{{ $t("group.manage.noLead") }}</option>
              <option v-for="id in memberIds" :key="id" :value="id">
                {{ botLabel(id) }}{{ botsById.get(id)?.enabled === false ? ` (${$t("bot.status.disabled")})` : "" }}
              </option>
            </select>
            <p v-if="leadReassigned" data-test="group-dialog-lead-reassigned" class="mt-1 text-[11px] text-warn">
              {{ leadReassigned.next
                ? $t("group.manage.leadReassigned", { previous: botLabel(leadReassigned.previous), next: botLabel(leadReassigned.next) })
                : $t("group.manage.leadCleared", { previous: botLabel(leadReassigned.previous) }) }}
            </p>
            <p class="mt-1 text-[11px] text-fg-muted">{{ $t("group.manage.leadHint") }}</p>
          </div>
        </fieldset>

        <div v-if="confirmingDelete"
             data-test="group-dialog-delete-confirm"
             class="space-y-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs">
          <p class="font-semibold text-danger">{{ $t("group.manage.deleteConfirmTitle", { title: liveGroup?.title ?? title }) }}</p>
          <ul class="list-disc space-y-1 pl-4 leading-relaxed text-fg">
            <li data-test="group-dialog-delete-topics">
              {{ deleteTopicCount === null
                ? $t("group.manage.deleteTopicsUnknown")
                : $t("group.manage.deleteTopics", { count: deleteTopicCount }) }}
            </li>
            <li>{{ $t("group.manage.deleteRuns") }}</li>
            <li>{{ $t("group.manage.deleteWorktrees") }}</li>
            <li>{{ $t("group.manage.deleteBotsKept") }}</li>
          </ul>
          <div class="flex justify-end gap-2 pt-1">
            <button type="button"
                    class="rounded-lg border border-border px-3 py-1 font-medium text-fg-muted hover:bg-raised"
                    @click="confirmingDelete = false">
              {{ $t("common.cancel") }}
            </button>
            <button type="button"
                    data-test="group-dialog-delete-confirm-button"
                    :disabled="deletingNow"
                    class="flex items-center gap-1 rounded-lg bg-danger px-3 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
                    @click="confirmDelete">
              <Loader2 v-if="deletingNow" :size="12" class="animate-spin" />
              <span>{{ $t("group.manage.delete") }}</span>
            </button>
          </div>
        </div>
      </form>

      <div class="flex shrink-0 items-center justify-between gap-2.5 border-t border-border bg-surface/50 px-5 py-3">
        <button v-if="isEditing && !isDeleting"
                type="button"
                data-test="group-dialog-delete"
                :disabled="confirmingDelete || deletingNow || submitting"
                class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                @click="askDelete">
          <Trash2 :size="13" />
          <span>{{ $t("group.manage.delete") }}</span>
        </button>
        <span v-else />
        <div class="flex items-center gap-2.5">
          <button
            type="button"
            class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
            @click="emit('close')"
          >
            {{ $t("common.cancel") }}
          </button>
          <button
            type="button"
            data-test="group-dialog-save"
            :disabled="!canSave"
            class="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
            @click="submit"
          >
            <Loader2 v-if="submitting" :size="13" class="animate-spin" />
            <span>{{ isEditing ? $t("common.save") : $t("common.create") }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
</template>
