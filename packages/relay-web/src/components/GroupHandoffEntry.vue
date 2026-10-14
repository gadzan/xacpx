<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  ConversationMessageDto,
  ConversationRunDetailDto,
  MemberTurnSummaryDto,
  BotAvatarConfig,
} from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore } from "../stores/groups";
import BotAvatar from "./BotAvatar.vue";

const props = defineProps<{
  message: ConversationMessageDto;
  fromName: string;
  toName: string;
  fromDriver?: string;
  toDriver?: string;
  fromAvatar?: BotAvatarConfig;
  toAvatar?: BotAvatarConfig;
}>();
const emit = defineEmits<{ jump: [messageId: string] }>();
const { t } = useI18n();
const groups = useGroupsStore();
const expanded = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const detail = shallowRef<
  | { state: "idle" | "loading" | "unavailable" }
  | { state: "loaded"; run: ConversationRunDetailDto }
>({ state: "idle" });
const panelId = computed(() => `group-handoff-${encodeURIComponent(props.message.id)}`);
let generation = 0;

function scopedTurn(turn: MemberTurnSummaryDto | undefined): turn is MemberTurnSummaryDto {
  const message = props.message;
  const handoff = message.handoff;
  return !!turn && !!handoff && !!message.runId
    && turn.id === handoff.memberTurnId
    && turn.conversationId === message.conversationId
    && turn.topicId === message.topicId
    && turn.runId === message.runId
    && turn.botId === handoff.to;
}

function exactTurn(turn: MemberTurnSummaryDto | undefined): turn is MemberTurnSummaryDto {
  return scopedTurn(turn)
    && (!turn.assignmentId || turn.assignmentId === props.message.handoff?.assignmentId);
}

const liveTurn = computed(() => {
  const id = props.message.handoff?.memberTurnId;
  const turn = id ? groups.memberTurnsById[id] : undefined;
  return scopedTurn(turn) ? turn : null;
});
const turn = computed(() => {
  if (liveTurn.value) return exactTurn(liveTurn.value) ? liveTurn.value : null;
  if (detail.value.state !== "loaded") return null;
  const run = detail.value.run;
  const message = props.message;
  if (run.id !== message.runId || run.conversationId !== message.conversationId
    || run.topicId !== message.topicId) return null;
  const matches = run.memberTurns.filter((member) => member.id === message.handoff?.memberTurnId);
  return matches.length === 1 && exactTurn(matches[0]) ? matches[0] : null;
});
const result = computed(() => {
  const member = turn.value;
  const message = props.message;
  if (!member?.promptRequestId) return null;
  const matches = groups.messages.filter((candidate) => candidate.role === "bot"
    && !candidate.handoff
    && candidate.conversationId === message.conversationId
    && candidate.topicId === message.topicId
    && candidate.runId === message.runId
    && candidate.senderBotId === member.botId
    && candidate.promptRequestId === member.promptRequestId
    && candidate.seq > message.seq
    && candidate.content.trim().length > 0);
  return matches.length === 1 ? matches[0] : null;
});
const resultPreview = computed(() => {
  const text = result.value?.content ?? "";
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
});

async function loadDetail(): Promise<void> {
  if (liveTurn.value || detail.value.state !== "idle") return;
  const owner = generation;
  detail.value = { state: "loading" };
  try {
    const run = await groups.loadHandoffRunDetail(props.message);
    if (owner !== generation) return;
    detail.value = run ? { state: "loaded", run } : { state: "unavailable" };
  } catch {
    if (owner === generation) detail.value = { state: "unavailable" };
  }
}

function collapse(): void {
  expanded.value = false;
  const owner = generation;
  void nextTick(() => {
    if (owner === generation) trigger.value?.focus({ preventScroll: true });
  });
}
function toggle(): void {
  if (expanded.value) collapse();
  else {
    expanded.value = true;
    if (detail.value.state === "unavailable") detail.value = { state: "idle" };
    void loadDetail();
  }
}

watch(
  () => [groups.instanceId, groups.selectedGroupId, groups.activeConversationId, groups.activeTopicId],
  () => {
    generation++;
    expanded.value = false;
    detail.value = { state: "idle" };
  },
  { flush: "sync" },
);
onBeforeUnmount(() => { generation++; });
watch(
  () => groups.handoffDetailRevision,
  () => {
    generation++;
    detail.value = { state: "idle" };
    if (expanded.value) void loadDetail();
  },
);
</script>

<template>
  <div data-test="group-handoff" class="min-w-0" @keydown.esc.stop.prevent="collapse">
    <button
      ref="trigger"
      type="button"
      data-test="group-handoff-toggle"
      :aria-label="t('group.handoff.label', { from: fromName, to: toName })"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      class="flex min-h-11 min-w-11 items-center rounded-lg px-1 text-accent transition-colors hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      @click="toggle"
    >
      <span aria-hidden="true" data-handoff-avatar="from" class="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-surface">
        <BotAvatar :avatar="fromAvatar" :driver="fromDriver" :name="fromName" :size="24" static />
      </span>
      <span aria-hidden="true" data-handoff-avatar="to" class="-ml-2 grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-surface">
        <BotAvatar :avatar="toAvatar" :driver="toDriver" :name="toName" :size="24" static />
      </span>
    </button>
    <div
      v-if="expanded && message.handoff"
      :id="panelId"
      data-test="group-handoff-details"
      class="mt-1 space-y-2 rounded-xl border border-border bg-surface/70 p-3 text-xs text-fg [overflow-wrap:anywhere]"
    >
      <dl class="space-y-2">
        <div><dt class="text-fg-muted">{{ t('group.handoff.from') }}</dt><dd>{{ fromName }}</dd></div>
        <div><dt class="text-fg-muted">{{ t('group.handoff.to') }}</dt><dd>{{ toName }}</dd></div>
        <div><dt class="text-fg-muted">{{ t('group.handoff.task') }}</dt><dd class="whitespace-pre-wrap">{{ message.handoff.task }}</dd></div>
        <div v-if="message.handoff.expectedOutput"><dt class="text-fg-muted">{{ t('group.handoff.expected') }}</dt><dd class="whitespace-pre-wrap">{{ message.handoff.expectedOutput }}</dd></div>
        <div v-if="turn"><dt class="text-fg-muted">{{ t('group.handoff.state') }}</dt><dd data-test="group-handoff-state" :data-state="turn.state">{{ t(`group.handoff.states.${turn.state}`) }}</dd></div>
      </dl>
      <p v-if="!turn" data-test="group-handoff-availability" role="status" class="text-fg-muted">{{ t(detail.state === 'loading' ? 'group.handoff.loading' : 'group.handoff.detailsUnavailable') }}</p>
      <div v-if="result" data-test="group-handoff-result">
        <p class="text-fg-muted">{{ t('group.handoff.result') }}</p>
        <p class="whitespace-pre-wrap">{{ resultPreview }}</p>
        <button type="button" data-test="group-handoff-jump" class="mt-1 rounded text-accent underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" @click="emit('jump', result.id)">{{ t('group.handoff.jump') }}</button>
      </div>
      <p v-else-if="turn || detail.state !== 'loading'" data-test="group-handoff-result-unavailable" class="text-fg-muted">{{ t('group.handoff.resultUnavailable') }}</p>
      <button type="button" data-test="group-handoff-collapse" class="rounded text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" @click="collapse">{{ t('group.handoff.collapse') }}</button>
    </div>
  </div>
</template>
