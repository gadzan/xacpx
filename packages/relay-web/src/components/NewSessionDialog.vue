<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { X, Loader2, AlertTriangle } from "lucide-vue-next";
import type { NativeSessionDto } from "@ganglion/xacpx-relay-protocol";
import { useInstancesStore } from "../stores/instances";
import { genAlias, uniqueName, workspaceNameFromPath } from "../lib/session-form";

const props = defineProps<{ instanceId: string; instanceName: string }>();
const emit = defineEmits<{ created: [alias: string]; close: [] }>();

const store = useInstancesStore();
const inst = computed(() => store.byId(props.instanceId));

const alias = ref("");
const agentValue = ref("");           // chosen agent NAME or un-configured driver
const sessionSource = ref<"new" | "native">("new"); // fresh transport session vs attach existing native session
const wsMode = ref<"existing" | "path">("existing");
const workspaceSel = ref("");
const workspacePath = ref("");
const submitting = ref(false);
const pending = ref(false);
const submittedAlias = ref("");
const error = ref("");
const loading = ref(true);

// Native ("agent-side") session attach: pick an existing acpx-owned rollout to resume.
const nativeSessions = ref<NativeSessionDto[]>([]);
const nativeSel = ref("");            // chosen agentSessionId
const nativeLoading = ref(false);
const nativeError = ref("");

onMounted(async () => {
  try {
    await store.loadFormOptions(props.instanceId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : "failed to load options";
  } finally {
    loading.value = false;
  }
  // default selections
  agentValue.value = inst.value?.agents[0]?.name ?? inst.value?.agentCatalog.find((c) => c.installed !== "unknown")?.driver ?? "";
  workspaceSel.value = inst.value?.workspaces[0]?.name ?? "";
});

// configured agent NAMEs (to know if a chosen value needs agent auto-create)
const configuredNames = computed(() => new Set((inst.value?.agents ?? []).map((a) => a.name)));
// catalog drivers not already configured (shown after configured agents)
const extraDrivers = computed(() =>
  (inst.value?.agentCatalog ?? []).filter((c) => !c.configured),
);

const resolvedWorkspaceName = computed(() =>
  wsMode.value === "path"
    ? (workspacePath.value.trim() ? workspaceNameFromPath(workspacePath.value) : "")
    : workspaceSel.value,
);
const aliasPlaceholder = computed(() =>
  resolvedWorkspaceName.value && agentValue.value ? genAlias(resolvedWorkspaceName.value, agentValue.value) : "auto",
);

// Native attach resolves the agent + workspace from config to list the agent's own
// rollouts, so it requires a CONFIGURED agent and an EXISTING workspace.
const agentIsConfigured = computed(() => configuredNames.value.has(agentValue.value));

async function loadNativeSessions(): Promise<void> {
  nativeSel.value = "";
  nativeSessions.value = [];
  nativeError.value = "";
  if (sessionSource.value !== "native" || !agentValue.value || !workspaceSel.value) return;
  if (!agentIsConfigured.value) {
    nativeError.value = "Pick a configured agent to list its native sessions.";
    return;
  }
  nativeLoading.value = true;
  try {
    nativeSessions.value = await store.listNativeSessions(props.instanceId, agentValue.value, workspaceSel.value);
    nativeSel.value = nativeSessions.value[0]?.sessionId ?? "";
  } catch (e) {
    nativeError.value = e instanceof Error ? e.message : "failed to list native sessions";
  } finally {
    nativeLoading.value = false;
  }
}

// (Re)fetch the native list whenever the source/agent/workspace changes while in native
// mode. Native mode forces an existing workspace (a brand-new path has no rollouts yet).
watch([sessionSource, agentValue, workspaceSel], () => {
  if (sessionSource.value === "native") {
    wsMode.value = "existing";
    void loadNativeSessions();
  }
});

// Turn a raw backend error into a friendlier hint. Listing an agent's native sessions
// shells out to its CLI, which can fail because the CLI isn't authenticated (e.g. codex
// needs a login on the host) — surface that as a clear next step rather than a raw code.
const nativeErrorHint = computed(() => {
  const e = nativeError.value;
  if (!e) return "";
  if (/auth|login|unauthor|credential|sign[\s-]?in/i.test(e)) {
    return `${agentValue.value || "This agent"} isn't authenticated on the host — log it in there (e.g. run its CLI login), then retry.`;
  }
  return "";
});

function nativeLabel(s: NativeSessionDto): string {
  const title = (s.title ?? "").trim() || s.sessionId;
  const tail = s.sessionId.length > 8 ? `…${s.sessionId.slice(-8)}` : s.sessionId;
  const when = s.updatedAt ? ` · ${new Date(s.updatedAt).toLocaleString()}` : "";
  return `${title} (${tail})${when}`;
}

const canSubmit = computed(() => {
  if (submitting.value || !agentValue.value) return false;
  if (sessionSource.value === "native") return !!nativeSel.value;
  if (wsMode.value === "existing") return !!workspaceSel.value;
  return !!workspacePath.value.trim();
});

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = "";
  try {
    const agentName = agentValue.value;
    const existingAliases = (inst.value?.sessions ?? []).map((s) => s.alias);

    // NATIVE: attach an existing agent-owned rollout. Agent + workspace are already
    // configured (the picker only lists for those), so nothing new is written here —
    // we just resume the chosen agentSessionId under a new logical alias.
    if (sessionSource.value === "native") {
      const workspaceName = workspaceSel.value;
      const finalAlias = alias.value.trim() || uniqueName(genAlias(workspaceName, agentName), existingAliases);
      if (!workspaceName || !finalAlias || !nativeSel.value) {
        error.value = "pick a native session and a valid alias";
        return;
      }
      const result = await store.createSession(props.instanceId, finalAlias, agentName, workspaceName, nativeSel.value);
      if (result.pending) { submittedAlias.value = finalAlias; pending.value = true; return; }
      emit("created", finalAlias);
      emit("close");
      return;
    }

    // NEW: create a fresh transport session.
    // 1) derive the workspace + alias names up front
    let workspaceName = workspaceSel.value;
    if (wsMode.value === "path") {
      const existing = (inst.value?.workspaces ?? []).map((w) => w.name);
      workspaceName = uniqueName(workspaceNameFromPath(workspacePath.value), existing);
    }
    const finalAlias = alias.value.trim() || uniqueName(genAlias(workspaceName, agentName), existingAliases);
    // 2) guard against empty derived names (e.g. an all-symbols path/alias)
    //    BEFORE creating anything (agent/workspace), so nothing is written on bad input.
    if (!workspaceName || !finalAlias) {
      error.value = "could not derive a valid name — please enter an alias or a normal path";
      return;
    }
    // 3) auto-create the config agent if an un-configured driver was picked
    if (!configuredNames.value.has(agentName)) {
      await store.createAgent(props.instanceId, agentName, agentName);
    }
    // 4) create the workspace from path once names are confirmed valid
    if (wsMode.value === "path") {
      await store.createWorkspace(props.instanceId, workspaceName, workspacePath.value.trim());
    }
    // 5) create the session (preserve PR #31 pending handling)
    const result = await store.createSession(props.instanceId, finalAlias, agentName, workspaceName);
    if (result.pending) { submittedAlias.value = finalAlias; pending.value = true; return; }
    emit("created", finalAlias);
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "create failed";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-border bg-raised shadow-xl" data-test="new-session-dialog">
      <header class="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 class="text-sm font-semibold text-fg">New session <span class="font-normal text-fg-muted">· {{ instanceName }}</span></h2>
        <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="space-y-4 px-5 py-4">
        <div v-if="pending" data-test="ns-pending" class="rounded-lg bg-info/10 px-3 py-3 text-xs text-info">
          Session is being created and will appear in the list shortly…
        </div>
        <div v-else-if="loading" class="py-6 text-center text-sm text-fg-muted">Loading options…</div>
        <template v-else>
          <div class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">Source</span>
            <div class="flex gap-1">
              <button type="button" data-test="ns-source-new"
                      class="flex-1 rounded px-2 py-1 text-xs"
                      :class="sessionSource === 'new' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                      @click="sessionSource = 'new'">New session</button>
              <button type="button" data-test="ns-source-native"
                      class="flex-1 rounded px-2 py-1 text-xs"
                      :class="sessionSource === 'native' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                      @click="sessionSource = 'native'">Native session</button>
            </div>
          </div>

          <label class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">Session alias <span class="font-normal text-fg-muted">(optional)</span></span>
            <input v-model="alias" data-test="ns-alias" :placeholder="aliasPlaceholder"
                   class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                   @keydown.enter="submit" />
          </label>

          <label class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">Agent</span>
            <select v-model="agentValue" data-test="ns-agent"
                    class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <optgroup v-if="inst?.agents.length" label="Configured">
                <option v-for="a in inst.agents" :key="a.name" :value="a.name">{{ a.name }} · {{ a.driver }}</option>
              </optgroup>
              <optgroup v-if="extraDrivers.length" label="Available drivers">
                <option v-for="c in extraDrivers" :key="c.driver" :value="c.driver" :disabled="c.installed === 'unknown'">
                  {{ c.driver }}{{ c.installed === 'unknown' ? ' — CLI not detected' : '' }}
                </option>
              </optgroup>
            </select>
          </label>

          <div class="block">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-xs font-medium text-fg-muted">Workspace</span>
              <div v-if="sessionSource === 'new'" class="flex gap-1">
                <button type="button" data-test="ns-ws-mode-existing"
                        class="rounded px-2 py-0.5 text-xs"
                        :class="wsMode === 'existing' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                        @click="wsMode = 'existing'">Existing</button>
                <button type="button" data-test="ns-ws-mode-path"
                        class="rounded px-2 py-0.5 text-xs"
                        :class="wsMode === 'path' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                        @click="wsMode = 'path'">New path</button>
              </div>
            </div>
            <select v-if="wsMode === 'existing'" v-model="workspaceSel" data-test="ns-workspace"
                    class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <option v-for="w in inst?.workspaces ?? []" :key="w.name" :value="w.name">{{ w.name }} — {{ w.cwd }}</option>
            </select>
            <input v-else v-model="workspacePath" data-test="ns-ws-path" placeholder="/abs/path"
                   class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
          </div>

          <!-- Native attach: pick an existing acpx-owned rollout for the chosen agent + workspace. -->
          <label v-if="sessionSource === 'native'" class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">Native session</span>
            <!-- Loading: animated spinner + shimmering skeleton rows (the list can take a while). -->
            <div v-if="nativeLoading" data-test="ns-native-loading" class="space-y-1.5">
              <div class="flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 :size="13" class="animate-spin motion-reduce:animate-none text-accent" />
                Listing native sessions…
              </div>
              <div v-for="n in 3" :key="n" class="h-7 animate-pulse rounded-lg bg-fg/5 motion-reduce:animate-none" :style="{ width: `${92 - n * 12}%` }" />
            </div>
            <select v-else-if="nativeSessions.length" v-model="nativeSel" data-test="ns-native"
                    class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <option v-for="s in nativeSessions" :key="s.sessionId" :value="s.sessionId">{{ nativeLabel(s) }}</option>
            </select>
            <!-- Error: distinct danger block with a friendly hint (e.g. agent not authenticated). -->
            <div v-else-if="nativeError" data-test="ns-native-error" class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              <div class="flex items-start gap-1.5">
                <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
                <div class="min-w-0">
                  <p class="break-words font-medium">{{ nativeError }}</p>
                  <p v-if="nativeErrorHint" class="mt-1 text-danger/80">{{ nativeErrorHint }}</p>
                </div>
              </div>
            </div>
            <p v-else data-test="ns-native-empty" class="rounded-lg bg-bg px-3 py-2 text-xs text-fg-muted">
              No native sessions found for this agent + workspace.
            </p>
          </label>

          <p v-if="error" data-test="ns-error" class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{{ error }}</p>
        </template>
      </div>

      <footer class="flex justify-end gap-2 border-t border-border px-5 py-3">
        <template v-if="pending">
          <button data-test="ns-pending-close"
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
                  @click="emit('created', submittedAlias); emit('close')">OK</button>
        </template>
        <template v-else>
          <button class="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5" @click="emit('close')">Cancel</button>
          <button data-test="ns-create" :disabled="!canSubmit"
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-hover disabled:opacity-40"
                  @click="submit">{{ submitting ? "Creating…" : "Create" }}</button>
        </template>
      </footer>
    </div>
  </div>
</template>
