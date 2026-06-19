<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Loader2, AlertTriangle, ChevronDown } from "lucide-vue-next";
import type { NativeSessionDto } from "@ganglion/xacpx-relay-protocol";
import { useInstancesStore } from "../stores/instances";
import { genAlias, uniqueName, workspaceNameFromPath } from "../lib/session-form";
import { fmtDateTime } from "../lib/format";
import SelectMenu, { type SelectGroup } from "./SelectMenu.vue";

const props = defineProps<{ instanceId: string; instanceName: string }>();
const emit = defineEmits<{ created: [alias: string]; close: [] }>();

const { t } = useI18n();
const store = useInstancesStore();
const inst = computed(() => store.byId(props.instanceId));

const alias = ref("");
const agentValue = ref("");           // chosen agent NAME or un-configured driver
const sessionSource = ref<"new" | "native">("new"); // fresh transport session vs attach existing native session
const wsMode = ref<"existing" | "path">("existing");
const workspaceSel = ref("");
const workspacePath = ref("");
const model = ref("");                  // model override; empty = agent default ("default")
const modelSuggestions = ref<string[]>([]); // hints from existing same-agent sessions
// Themed combobox state (a native <datalist> renders an unstyleable white OS popup that
// clashes with the dark theme, so we roll our own dropdown).
const modelOpen = ref(false);
const modelHighlight = ref(0);
const modelBoxEl = ref<HTMLElement | null>(null);

// "default" is always first; then any deduped suggestions. Selecting "default" clears the
// field so the placeholder shows and no override is sent.
const modelOptions = computed(() => {
  const seen = new Set<string>(["default"]);
  const out = ["default"];
  for (const m of modelSuggestions.value) {
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out;
});
const filteredModelOptions = computed(() => {
  const q = model.value.trim().toLowerCase();
  if (!q) return modelOptions.value;
  return modelOptions.value.filter((o) => o.toLowerCase().includes(q));
});

function openModel(): void {
  modelOpen.value = true;
  modelHighlight.value = 0;
}
function closeModel(): void {
  modelOpen.value = false;
}
function pickModel(opt: string): void {
  model.value = opt === "default" ? "" : opt;
  closeModel();
}
function onModelKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!modelOpen.value) { openModel(); return; }
    modelHighlight.value = Math.min(modelHighlight.value + 1, filteredModelOptions.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    modelHighlight.value = Math.max(modelHighlight.value - 1, 0);
  } else if (e.key === "Enter") {
    if (modelOpen.value && modelHighlight.value >= 0 && modelHighlight.value < filteredModelOptions.value.length) {
      e.preventDefault();
      pickModel(filteredModelOptions.value[modelHighlight.value]);
    } else {
      submit();
    }
  } else if (e.key === "Escape" && modelOpen.value) {
    e.stopPropagation();
    closeModel();
  }
}

// Close the dropdown on an outside click.
function onDocPointerDown(e: MouseEvent): void {
  if (modelOpen.value && modelBoxEl.value && !modelBoxEl.value.contains(e.target as Node)) closeModel();
}
onMounted(() => document.addEventListener("mousedown", onDocPointerDown));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocPointerDown));
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
    error.value = e instanceof Error ? e.message : t("session.failedLoadOptions");
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

// Agent picker groups: configured agents first, then un-configured catalog drivers
// (an undetected CLI is shown but disabled). Mirrors the old <optgroup> layout.
const agentGroups = computed<SelectGroup[]>(() => {
  const groups: SelectGroup[] = [];
  const configured = inst.value?.agents ?? [];
  if (configured.length) {
    groups.push({ label: t("session.configured"), options: configured.map((a) => ({ value: a.name, label: `${a.name} · ${a.driver}` })) });
  }
  if (extraDrivers.value.length) {
    groups.push({
      label: t("session.availableDrivers"),
      options: extraDrivers.value.map((c) => ({
        value: c.driver,
        label: c.installed === "unknown" ? t("session.cliNotDetected", { driver: c.driver }) : c.driver,
        disabled: c.installed === "unknown",
      })),
    });
  }
  return groups;
});
const workspaceGroups = computed<SelectGroup[]>(() => [
  { options: (inst.value?.workspaces ?? []).map((w) => ({ value: w.name, label: `${w.name} — ${w.cwd}` })) },
]);

const resolvedWorkspaceName = computed(() =>
  wsMode.value === "path"
    ? (workspacePath.value.trim() ? workspaceNameFromPath(workspacePath.value) : "")
    : workspaceSel.value,
);
const aliasPlaceholder = computed(() =>
  resolvedWorkspaceName.value && agentValue.value ? genAlias(resolvedWorkspaceName.value, agentValue.value) : t("session.autoAlias"),
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
    nativeError.value = t("session.pickConfiguredAgent");
    return;
  }
  nativeLoading.value = true;
  try {
    nativeSessions.value = await store.listNativeSessions(props.instanceId, agentValue.value, workspaceSel.value);
    nativeSel.value = nativeSessions.value[0]?.sessionId ?? "";
  } catch (e) {
    nativeError.value = e instanceof Error ? e.message : t("session.failedListNative");
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

// Refresh the model datalist hints whenever the agent/workspace selection changes.
// Best-effort: acpx can't enumerate an agent's models without a live session, so the
// list is seeded from an existing same-agent+workspace session (empty otherwise). The
// field stays a free-text input that defaults to "default", so [] is fine.
watch([agentValue, workspaceSel], async () => {
  modelSuggestions.value = [];
  if (!agentValue.value || !workspaceSel.value) return;
  modelSuggestions.value = await store.listModelSuggestions(props.instanceId, agentValue.value, workspaceSel.value);
});

// Turn a raw backend error into a friendlier hint. Listing an agent's native sessions
// shells out to its CLI, which can fail because the CLI isn't authenticated (e.g. codex
// needs a login on the host) — surface that as a clear next step rather than a raw code.
const nativeErrorHint = computed(() => {
  const e = nativeError.value;
  if (!e) return "";
  if (/auth|login|unauthor|credential|sign[\s-]?in/i.test(e)) {
    return t("session.authHint", { agent: agentValue.value || t("session.thisAgent") });
  }
  return "";
});

function nativeLabel(s: NativeSessionDto): string {
  const title = (s.title ?? "").trim() || s.sessionId;
  const tail = s.sessionId.length > 8 ? `…${s.sessionId.slice(-8)}` : s.sessionId;
  const when = s.updatedAt ? ` · ${fmtDateTime(s.updatedAt)}` : "";
  return `${title} (${tail})${when}`;
}
const nativeGroups = computed<SelectGroup[]>(() => [
  { options: nativeSessions.value.map((s) => ({ value: s.sessionId, label: nativeLabel(s) })) },
]);

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
        error.value = t("session.pickNativeAndAlias");
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
      error.value = t("session.couldNotDeriveName");
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
    //    A blank or "default" model means "use the agent's default" — send nothing.
    const modelOverride = model.value.trim();
    const modelArg = modelOverride && modelOverride.toLowerCase() !== "default" ? modelOverride : undefined;
    const result = await store.createSession(props.instanceId, finalAlias, agentName, workspaceName, undefined, modelArg);
    if (result.pending) { submittedAlias.value = finalAlias; pending.value = true; return; }
    emit("created", finalAlias);
    emit("close");
  } catch (e) {
    error.value = e instanceof Error ? e.message : t("session.createFailed");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!-- Teleport to body: the mobile instance drawer uses `transform`, which would
       otherwise make this fixed overlay resolve against the drawer (narrow,
       off-canvas) instead of the viewport. -->
  <Teleport to="body">
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
    <div class="w-full max-w-md rounded-xl border border-border bg-raised shadow-xl" data-test="new-session-dialog">
      <header class="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 class="text-sm font-semibold text-fg">{{ $t("session.newSession") }} <span class="font-normal text-fg-muted">· {{ instanceName }}</span></h2>
        <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label='$t("session.close")' @click="emit('close')"><X :size="16" /></button>
      </header>

      <div class="space-y-4 px-5 py-4">
        <div v-if="pending" data-test="ns-pending" class="rounded-lg bg-info/10 px-3 py-3 text-xs text-info">
          {{ $t("session.creating") }}
        </div>
        <div v-else-if="loading" class="py-6 text-center text-sm text-fg-muted">{{ $t("session.loadingOptions") }}</div>
        <template v-else>
          <div class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("session.source") }}</span>
            <div class="flex gap-1">
              <button type="button" data-test="ns-source-new"
                      class="flex-1 rounded px-2 py-1 text-xs"
                      :class="sessionSource === 'new' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                      @click="sessionSource = 'new'">{{ $t("session.newSession") }}</button>
              <button type="button" data-test="ns-source-native"
                      class="flex-1 rounded px-2 py-1 text-xs"
                      :class="sessionSource === 'native' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                      @click="sessionSource = 'native'">{{ $t("session.nativeSession") }}</button>
            </div>
          </div>

          <label class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("session.sessionAlias") }} <span class="font-normal text-fg-muted">{{ $t("session.optional") }}</span></span>
            <input v-model="alias" data-test="ns-alias" :placeholder="aliasPlaceholder"
                   class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                   @keydown.enter="submit" />
          </label>

          <div class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("session.agent") }}</span>
            <SelectMenu v-model="agentValue" :groups="agentGroups" data-test="ns-agent" :aria-label='$t("session.agent")' :placeholder='$t("session.selectAgent")' />
          </div>

          <div class="block">
            <div class="mb-1 flex items-center justify-between">
              <span class="text-xs font-medium text-fg-muted">{{ $t("session.workspace") }}</span>
              <div v-if="sessionSource === 'new'" class="flex gap-1">
                <button type="button" data-test="ns-ws-mode-existing"
                        class="rounded px-2 py-0.5 text-xs"
                        :class="wsMode === 'existing' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                        @click="wsMode = 'existing'">{{ $t("session.existing") }}</button>
                <button type="button" data-test="ns-ws-mode-path"
                        class="rounded px-2 py-0.5 text-xs"
                        :class="wsMode === 'path' ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                        @click="wsMode = 'path'">{{ $t("session.newPath") }}</button>
              </div>
            </div>
            <SelectMenu v-if="wsMode === 'existing'" v-model="workspaceSel" :groups="workspaceGroups" data-test="ns-workspace" :aria-label='$t("session.workspace")' :placeholder='$t("session.selectWorkspace")' />
            <input v-else v-model="workspacePath" data-test="ns-ws-path" :placeholder='$t("session.pathPlaceholder")'
                   class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
          </div>

          <!-- Model override (fresh sessions only). Editable: pick a suggested model or
               type any id. Blank/"default" keeps the agent's default model. Native attach
               resumes under the rollout's recorded model, so the field is hidden there. -->
          <div v-if="sessionSource === 'new'" class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("session.model") }} <span class="font-normal text-fg-muted">{{ $t("session.optional") }}</span></span>
            <div ref="modelBoxEl" class="relative">
              <input v-model="model" data-test="ns-model" placeholder="default" autocomplete="off"
                     class="w-full rounded-lg border border-border bg-bg py-2 pl-3 pr-9 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                     @focus="openModel" @input="openModel" @keydown="onModelKeydown" />
              <button type="button" tabindex="-1" :aria-label='$t("session.toggleModelList")'
                      class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-fg-muted hover:text-fg"
                      @click="modelOpen ? closeModel() : openModel()">
                <ChevronDown :size="16" class="transition-transform" :class="modelOpen ? 'rotate-180' : ''" />
              </button>
              <ul v-if="modelOpen && filteredModelOptions.length" data-test="ns-model-list"
                  class="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-raised py-1 shadow-xl">
                <li v-for="(opt, i) in filteredModelOptions" :key="opt"
                    class="flex cursor-pointer items-center justify-between px-3 py-1.5 text-sm"
                    :class="i === modelHighlight ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-fg/5'"
                    @mousedown.prevent="pickModel(opt)" @mouseenter="modelHighlight = i">
                  <span class="truncate">{{ opt }}</span>
                  <span v-if="opt === 'default'" class="ml-2 shrink-0 text-xs text-fg-muted">{{ $t("session.agentDefault") }}</span>
                </li>
              </ul>
            </div>
          </div>

          <!-- Native attach: pick an existing acpx-owned rollout for the chosen agent + workspace. -->
          <div v-if="sessionSource === 'native'" class="block">
            <span class="mb-1 block text-xs font-medium text-fg-muted">{{ $t("session.nativeSession") }}</span>
            <!-- Loading: animated spinner + shimmering skeleton rows (the list can take a while). -->
            <div v-if="nativeLoading" data-test="ns-native-loading" class="space-y-1.5">
              <div class="flex items-center gap-2 text-xs text-fg-muted">
                <Loader2 :size="13" class="animate-spin motion-reduce:animate-none text-accent" />
                {{ $t("session.listingNative") }}
              </div>
              <div v-for="n in 3" :key="n" class="h-7 animate-pulse rounded-lg bg-fg/5 motion-reduce:animate-none" :style="{ width: `${92 - n * 12}%` }" />
            </div>
            <SelectMenu v-else-if="nativeSessions.length" v-model="nativeSel" :groups="nativeGroups"
                        data-test="ns-native" :aria-label='$t("session.nativeSession")' :placeholder='$t("session.selectNative")' />
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
              {{ $t("session.noNativeSessions") }}
            </p>
          </div>

          <p v-if="error" data-test="ns-error" class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{{ error }}</p>
        </template>
      </div>

      <footer class="flex justify-end gap-2 border-t border-border px-5 py-3">
        <template v-if="pending">
          <button data-test="ns-pending-close"
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
                  @click="emit('created', submittedAlias); emit('close')">{{ $t("common.ok") }}</button>
        </template>
        <template v-else>
          <button class="rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-fg/5" @click="emit('close')">{{ $t("common.cancel") }}</button>
          <button data-test="ns-create" :disabled="!canSubmit"
                  class="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white enabled:hover:bg-accent-hover disabled:opacity-40"
                  @click="submit">{{ submitting ? $t("session.creatingButton") : $t("session.create") }}</button>
        </template>
      </footer>
    </div>
  </div>
  </Teleport>
</template>
