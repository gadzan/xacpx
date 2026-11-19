<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "lucide-vue-next";
import type { AgentCapabilityState } from "@ganglion/xacpx-relay-protocol";
import { useInstancesStore } from "../stores/instances";

const props = defineProps<{
  instanceId: string;
  agentName: string;
  installedHint?: string;
  workspaceNames: string[];
}>();

type RowState = { status: "idle" } | { status: "loading" } | AgentCapabilityState;

const { t } = useI18n();
const store = useInstancesStore();

// The selected workspace is the capability scope: capability answers are per
// agent + workspace, so the row always reads and renders exactly one scope.
// Every load bumps `seq`; a late answer from a superseded scope is dropped.
const workspace = ref(props.workspaceNames[0] ?? "");
const state = ref<RowState>(workspace.value ? { status: "loading" } : { status: "idle" });
const shownWorkspace = ref<string | null>(null);
const checking = ref(false);
let seq = 0;

const hasWorkspace = computed(() => workspace.value !== "");
const showPicker = computed(() => props.workspaceNames.length > 1);

const statusKey = computed(() => {
  const s = state.value.status;
  if (s === "ready") return "agents.readinessReady";
  if (s === "needs-setup") return "agents.readinessNeedsSetup";
  if (s === "unsupported") return "agents.readinessUnsupported";
  if (s === "empty") return "agents.readinessEmpty";
  if (s === "error") return "agents.readinessError";
  if (s === "loading") return "agents.readinessChecking";
  return "agents.readinessIdle";
});

const statusClass = computed(() => {
  const s = state.value.status;
  if (s === "ready") return "text-ok";
  if (s === "needs-setup" || s === "unsupported" || s === "empty") return "text-warning";
  if (s === "error") return "text-error";
  return "text-fg-muted";
});

const reason = computed((): string | null => {
  const s = state.value;
  if (s.status === "idle" || s.status === "loading") return null;
  return s.reason?.message ?? null;
});

const recovery = computed((): string | null => {
  const s = state.value;
  if (s.status === "idle" || s.status === "loading" || s.status === "ready") return null;
  return s.recovery;
});

const modelCount = computed((): number | null =>
  state.value.status === "ready" ? state.value.models.length : null,
);

async function load(probe: boolean): Promise<void> {
  const ws = workspace.value;
  if (!ws) return;
  const my = ++seq;
  checking.value = true;
  try {
    // A plain read rides the store cache (fresh entries return without a new
    // RPC); only an explicit Check passes probe for a fresh read.
    const next = await store.getAgentCapabilities(props.instanceId, {
      agent: props.agentName,
      workspace: ws,
      ...(probe ? { probe: true } : {}),
    });
    if (my !== seq) return;
    state.value = next;
    shownWorkspace.value = ws;
  } catch {
    // getAgentCapabilities already maps transport failures to typed error
    // states; an unexpected throw keeps the last settled row either way.
    if (my !== seq) return;
  } finally {
    if (my === seq) checking.value = false;
  }
}

function check(): void {
  if (!hasWorkspace.value || checking.value) return;
  void load(true);
}

onMounted(() => {
  if (hasWorkspace.value) void load(false);
});

watch(workspace, () => {
  void load(false);
});

// A workspace added elsewhere (the workspaces tab) adopts itself as the scope
// once the instance has at least one.
watch(
  () => props.workspaceNames,
  (names) => {
    if (!workspace.value && names.length > 0) {
      workspace.value = names[0] ?? "";
      void load(false);
    }
  },
);

// An invalidation that touches exactly this scope re-reads it, like the bot
// and session dialogs; anything else leaves the row alone.
watch(
  () => (workspace.value ? store.capabilityEpochFor(props.instanceId, props.agentName, workspace.value) : -1),
  () => {
    void load(false);
  },
);
</script>

// Read-only readiness row: status, reason, and hints only. Install, download,
// sign-in, and update actions belong to UX2b and must never be added here.

<template>
  <div :data-test="`arr-row-${agentName}`" class="mt-1 space-y-1 rounded-sm bg-surface-2/60 px-2 py-1.5 text-xs">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span v-if="installedHint" data-test="arr-installed" class="text-fg-muted">{{ installedHint }}</span>
      <span data-test="arr-status" class="font-medium" :class="statusClass">{{ $t(statusKey) }}</span>
      <span v-if="modelCount !== null" data-test="arr-models" class="text-fg-muted">{{
        $t("agents.readinessModels", { count: modelCount })
      }}</span>
      <RefreshCw v-if="checking" :size="12" class="animate-spin text-fg-muted" aria-hidden="true" />
    </div>
    <p v-if="reason" data-test="arr-reason" class="text-fg-muted">{{ reason }}</p>
    <p v-if="recovery" data-test="arr-recovery" class="text-fg-muted">{{ recovery }}</p>
    <div class="flex flex-wrap items-center gap-2">
      <label v-if="showPicker" class="inline-flex items-center gap-1 text-fg-muted">
        <span>{{ $t("agents.readinessWorkspace") }}</span>
        <select v-model="workspace" data-test="arr-workspace"
                class="rounded-sm bg-surface-2 px-1 py-0.5 text-xs text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <option v-for="name in workspaceNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <span v-if="shownWorkspace" data-test="arr-checked-in" class="text-fg-muted">{{
        $t("agents.readinessCheckedIn", { workspace: shownWorkspace })
      }}</span>
      <button type="button" data-test="arr-check" :disabled="!hasWorkspace || checking"
              :title="hasWorkspace ? $t('agents.readinessCheckHint', { name: agentName, workspace: workspace }) : ''"
              :aria-label="$t('agents.readinessCheckHint', { name: agentName, workspace: workspace || '—' })"
              class="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-2 py-0.5 text-xs text-fg transition-colors hover:bg-accent-soft disabled:opacity-50"
              @click="check">
        <RefreshCw :size="12" :class="checking ? 'animate-spin' : ''" aria-hidden="true" />
        {{ $t("agents.readinessCheck") }}
      </button>
    </div>
    <p v-if="!hasWorkspace" data-test="arr-no-workspace" class="text-fg-muted">{{ $t("agents.readinessNoWorkspace") }}</p>
  </div>
</template>
