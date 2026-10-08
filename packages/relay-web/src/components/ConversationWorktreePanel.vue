<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { MSG, isErrorPayload, isConversationWorktreeStatus, type ConversationWorktreePayload, type ConversationWorktreeStatusDto } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
const props = defineProps<{ instanceId: string; runId: string }>();
const { t } = useI18n();
const status = ref<ConversationWorktreeStatusDto>();
const error = ref(""); const busy = ref(false); const authorized = ref(false);
let epoch = 0;
const candidate = computed(() => status.value?.resources.find(r => r.kind === "integration"));
async function load(): Promise<void> {
  const expected = epoch, instance = props.instanceId, runId = props.runId;
  try {
    const result = await api.rpc<{ run: { worktree?: unknown } }>(instance, MSG.runsGet, { runId });
    if (expected !== epoch || busy.value) return;
    if (isErrorPayload(result)) throw new Error(result.error.message);
    if (isConversationWorktreeStatus(result.run?.worktree) && result.run.worktree.runId === runId
      && (!status.value || result.run.worktree.revision >= status.value.revision)) {
      if (status.value?.preview?.id !== result.run.worktree.preview?.id) authorized.value = false;
      status.value = result.run.worktree;
    }
  } catch (e) { if (expected === epoch) error.value = e instanceof Error ? e.message : String(e); }
}
async function operate(action: ConversationWorktreePayload["action"]): Promise<void> {
  const current = status.value; if (!current) return;
  const input: ConversationWorktreePayload = action === "preview"
    ? { action, runId: props.runId, botIds: current.resources.filter(r => r.kind === "member").map(r => r.botId) }
    : action === "integrate" ? { action, runId: props.runId, requestId: crypto.randomUUID(), previewId: current.preview!.id, snapshotUncommitted: true }
    : { action, runId: props.runId };
  const expected = epoch; busy.value = true; error.value = "";
  try {
    const result = await api.rpc<{ worktree: unknown }>(props.instanceId, MSG.conversationWorktree, input);
    if (expected !== epoch) return;
    if (isErrorPayload(result)) throw new Error(result.error.message);
    if (!isConversationWorktreeStatus(result.worktree) || result.worktree.runId !== props.runId) throw new Error(t("group.worktree.invalidResponse"));
    status.value = result.worktree; authorized.value = false;
  } catch (e) { if (expected === epoch) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (expected === epoch) busy.value = false; }
}
watch(() => [props.instanceId, props.runId], () => { epoch++; status.value = undefined; busy.value = false; authorized.value = false; error.value = ""; void load(); }, { immediate: true });
const timer = setInterval(() => { if (!busy.value) void load(); }, 5000);
onUnmounted(() => { epoch++; clearInterval(timer); });
</script>
<template>
  <details v-if="status" class="border-t border-border px-4 py-2 text-xs" data-test="worktree-panel">
    <summary>{{ t("group.worktree.title") }} · {{ status.integration?.state ?? status.disposition }}</summary>
    <p class="my-2 text-fg-muted">{{ t("group.worktree.boundary") }}</p>
    <p>{{ t("group.worktree.base") }}: <code>{{ status.baseCommitSha }}</code></p>
    <div v-for="r in status.resources" :key="r.id" class="my-1 break-all">{{ r.botId }} · {{ r.state }} · {{ r.worktreePath }}</div>
    <p v-if="error" role="alert" class="my-2 text-danger">{{ error }}</p>
    <div class="my-2 flex flex-wrap gap-3">
      <button :disabled="busy" @click="load">{{ t("group.worktree.refresh") }}</button>
      <button v-if="!status.integration && status.disposition === 'pending'" :disabled="busy" @click="operate('preview')">{{ t("group.worktree.preview") }}</button>
      <button v-if="status.integration?.state === 'conflicted'" :disabled="busy" @click="operate('continue')">{{ t("group.worktree.continue") }}</button>
      <button v-if="status.integration && ['preparing', 'integrating', 'failed', 'recovery-required'].includes(status.integration.state)" :disabled="busy" @click="operate('recover')">{{ t("group.worktree.recover") }}</button>
      <button v-if="status.disposition === 'pending'" :disabled="busy" @click="operate('abandon')">{{ t("group.worktree.abandon") }}</button>
      <button v-if="status.disposition === 'integrated'" :disabled="busy" @click="operate('cleanup')">{{ t("group.worktree.cleanup") }}</button>
    </div>
    <template v-if="status.preview && !status.integration">
      <pre v-for="m in status.preview.members" :key="m.worktreeId" class="my-2 max-h-32 overflow-auto whitespace-pre-wrap">{{ m.botId + '\n' + m.diff }}</pre>
      <label class="flex items-center gap-2"><input v-model="authorized" type="checkbox">{{ t("group.worktree.authorize") }}</label>
      <button class="my-2" :disabled="busy || !authorized" @click="operate('integrate')">{{ t("group.worktree.integrate") }}</button>
    </template>
    <p v-if="candidate" class="break-all">{{ t("group.worktree.candidate") }}: {{ candidate.branchRef }} · {{ status.integration?.candidateCommitSha }}</p>
    <p v-if="status.integration?.state === 'conflicted'" role="alert" class="text-danger">{{ t("group.worktree.conflict") }}: {{ status.integration.conflictFiles.join(', ') }}</p>
  </details>
</template>
