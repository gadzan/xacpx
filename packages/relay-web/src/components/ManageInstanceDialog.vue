<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "lucide-vue-next";
import type { ConversationRouterUpdatePayload, JevUpdatePayload } from "@ganglion/xacpx-relay-protocol";
import { useInstancesStore } from "../stores/instances";
import { useModalA11y } from "../lib/use-modal-a11y";
import WorkspacesManager from "./WorkspacesManager.vue";
import AgentsManager from "./AgentsManager.vue";

const props = defineProps<{ instanceId: string; instanceName: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useInstancesStore();
const { t, te } = useI18n();

const coreVersion = computed(() => store.byId(props.instanceId)?.coreVersion ?? null);

// Sidebar grouping mode for THIS instance (view preference, localStorage-backed).
const GROUP_MODES = ["instance", "workspace", "agent"] as const;
const groupMode = computed(() => store.groupModeFor(props.instanceId));
function pickGroupMode(mode: (typeof GROUP_MODES)[number]): void {
  store.setGroupMode(props.instanceId, mode);
}

const loading = ref(true);
type Tab = "general" | "workspaces" | "agents";
const TABS = ["general", "workspaces", "agents"] as const;
const tab = ref<Tab>("general");

// Roving-tabindex arrow-key navigation across the tablist (Left/Right wrap, Home/End
// jump to the ends). Moving selection also moves focus to the newly selected tab.
function onTabKeydown(e: KeyboardEvent): void {
  const idx = TABS.indexOf(tab.value);
  let next = idx;
  if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
  else if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = TABS.length - 1;
  else return;
  e.preventDefault();
  tab.value = TABS[next];
  void nextTick(() => {
    dialogEl.value?.querySelector<HTMLElement>(`#tab-${TABS[next]}`)?.focus();
  });
}

// Seed the editable name from the prop. The dialog header binds to this local ref
// (not the static prop) so the title updates live the moment a rename succeeds.
const name = ref(props.instanceName);
const renameError = ref("");
const renaming = ref(false);

async function saveName(): Promise<void> {
  const next = name.value.trim();
  if (!next || renaming.value) return;
  renaming.value = true; renameError.value = "";
  try {
    await store.renameInstance(props.instanceId, next);
    name.value = next;
  } catch (e) {
    renameError.value = e instanceof Error ? e.message : t("instance.renameFailed");
  } finally {
    renaming.value = false;
  }
}

// Accessibility (shared composable): trap focus inside the dialog, close on Esc, and
// restore focus to whatever was focused before the dialog opened.
const dialogEl = ref<HTMLElement | null>(null);
useModalA11y(dialogEl, () => emit("close"));

// Automatic collaboration. One panel model per instance from the store; the switch
// reads the persisted `config.enabled`, never the resolved availability, because
// intent and resolution are different facts.
const panel = computed(() => store.routerPanelFor(props.instanceId));
const routerConfig = computed(() => (panel.value.phase === "editable" ? panel.value.config : null));
const routerEnabled = computed(() => routerConfig.value?.enabled ?? false);
const routerEditable = computed(() => panel.value.phase === "editable");
const routerSaving = computed(() => panel.value.phase === "editable" && panel.value.save.kind === "saving");
const routerErrorText = computed(() => {
  const state = panel.value;
  return state.phase === "editable" && state.save.kind === "failed" ? state.save.message : "";
});
const instanceOnline = computed(() => store.byId(props.instanceId)?.online ?? false);

const routerStatus = computed(() => {
  const state = panel.value;
  if (state.phase === "loading") return t("instance.autoCollabChecking");
  const availability = state.availability;
  if (availability.status === "ready") return t("instance.autoCollabOn");
  if (availability.status === "disabled-by-config") return t("instance.autoCollabOff");
  // Every other status (`unsupported`, `failed`) reads as one fixed sentence: the
  // daemon's reason text and config path are implementation detail, not product copy.
  return t("instance.autoCollabFailed");
});

/** For `unsupported`/`failed`, a localized per-code explanation with an actionable
 *  hint, plus the daemon's raw message as secondary detail. */
const routerReason = computed<{ explain: string; detail: string } | null>(() => {
  const state = panel.value;
  if (state.phase === "loading") return null;
  const availability = state.availability;
  if (availability.status !== "unsupported" && availability.status !== "failed") return null;
  const { code, message } = availability.reason;
  const key = `instance.autoCollabReason.${code}`;
  return { explain: te(key) ? t(key) : t("instance.autoCollabReason.unknown"), detail: message };
});

const routerHint = computed(() => {
  const state = panel.value;
  return state.phase === "read-only" && state.notice ? t(state.notice) : t("instance.autoCollabBody");
});

/** One write path for the switch. The store keeps the panel's config untouched when
 *  the RPC throws, so the switch and the daemon's message survive. */
async function writeRouter(patch: ConversationRouterUpdatePayload): Promise<void> {
  store.setRouterSaveState(props.instanceId, { kind: "saving" });
  try {
    await store.saveRouterPanel(props.instanceId, patch);
  } catch (error) {
    store.setRouterSaveState(props.instanceId, {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function toggleRouter(): Promise<void> {
  const config = routerConfig.value;
  if (!config || routerSaving.value) return;
  await writeRouter({ enabled: !config.enabled });
}

// Jev routing settings. The API key never reaches the dashboard: the panel's
// `keyMasked` is the only preview, and the key input is a write-only draft —
// typing replaces, the clear button removes, saving with an empty draft keeps.
const jevPanel = computed(() => store.jevPanelFor(props.instanceId));
const jevSettings = computed(() => (jevPanel.value.phase === "editable" ? jevPanel.value.settings : null));
const jevEditable = computed(() => jevPanel.value.phase === "editable");
const jevUpgradeNotice = computed(() =>
  jevPanel.value.phase === "read-only" && jevPanel.value.notice ? jevPanel.value.notice : "");
const jevSaving = computed(() =>
  jevPanel.value.phase === "editable" && jevPanel.value.save.kind === "saving");
const jevErrorText = computed(() => {
  const state = jevPanel.value;
  return state.phase === "editable" && state.save.kind === "failed" ? state.save.message : "";
});
const jevTestView = computed(() => {
  const state = jevPanel.value;
  if (state.phase !== "editable") return null;
  if (state.test.kind === "testing") return { kind: "testing" as const };
  if (state.test.kind === "ok") {
    return { kind: "ok" as const, text: t("instance.jevTest.ok", { ms: state.test.latencyMs }) };
  }
  if (state.test.kind === "failed") {
    const key = `instance.jevTest.${state.test.code}`;
    return {
      kind: "failed" as const,
      ok: false,
      text: te(key) ? t(key) : t("instance.jevTest.unknown"),
      detail: state.test.message,
    };
  }
  return null;
});

const jevEndpoint = ref("");
const jevProxy = ref("");
const jevSeededEndpoint = ref("");
const jevSeededProxy = ref("");
const jevKeyDraft = ref("");
const jevKeyCleared = ref(false);
let jevSeeded = false;

// Seed the drafts once per panel arrival. A re-read (e.g. the
// conversation-router-changed event a Jev save itself emits) must not clobber
// what the user is typing, so only the first editable landing seeds. The
// seeded values double as the dirty baseline: Save patches only what changed.
watch(jevSettings, (settings) => {
  if (!settings) {
    jevSeeded = false;
    return;
  }
  if (jevSeeded) return;
  jevSeeded = true;
  jevSeededEndpoint.value = settings.endpoint;
  jevSeededProxy.value = settings.proxyUrl ?? "";
  jevEndpoint.value = settings.endpoint;
  jevProxy.value = settings.proxyUrl ?? "";
  jevKeyDraft.value = "";
  jevKeyCleared.value = false;
});

function clearJevKey(): void {
  jevKeyDraft.value = "";
  jevKeyCleared.value = true;
}

/** Build the patch from the drafts against the seeded baseline: an untouched
 *  field is omitted (kept), an edited field is sent, and an emptied proxy
 *  clears the override so Jev falls back to the daemon process env. */
function jevPatch(): JevUpdatePayload {
  const endpoint = jevEndpoint.value.trim();
  const proxy = jevProxy.value.trim();
  return {
    ...(endpoint !== jevSeededEndpoint.value && endpoint.length > 0 ? { endpoint } : {}),
    ...(proxy !== jevSeededProxy.value ? { proxyUrl: proxy.length > 0 ? proxy : null } : {}),
    ...(jevKeyDraft.value.trim().length > 0
      ? { apiKey: jevKeyDraft.value.trim() }
      : jevKeyCleared.value
        ? { apiKey: null }
        : {}),
  };
}

async function saveJev(): Promise<void> {
  if (jevSaving.value) return;
  store.setJevSaveState(props.instanceId, { kind: "saving" });
  try {
    await store.saveJevSettings(props.instanceId, jevPatch());
    jevKeyDraft.value = "";
    jevKeyCleared.value = false;
    // Back to idle so a second save (key now, proxy later) stays possible.
    store.setJevSaveState(props.instanceId, { kind: "idle" });
  } catch (error) {
    store.setJevSaveState(props.instanceId, {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function testJev(): Promise<void> {
  const draft = jevKeyDraft.value.trim();
  try {
    // A draft key is tested unsaved; an empty draft tests whatever is stored.
    await store.testJevConnection(props.instanceId, draft.length > 0 ? draft : undefined);
  } catch {
    // The store already recorded the failure state for the banner.
  }
}

onMounted(async () => {
  // The router panel carries its own loading phase, so it must not gate the tab body.
  void store.loadRouterPanel(props.instanceId);
  void store.loadJevSettings(props.instanceId);
  try {
    await store.loadFormOptions(props.instanceId);
  } catch {
    // best-effort: managers degrade to empty lists if options fail to load
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!-- Teleport to body: the mobile instance drawer uses `transform`, which would
       otherwise trap this fixed overlay inside the narrow off-canvas drawer. -->
  <Teleport to="body">
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @click.self="emit('close')">
    <div ref="dialogEl" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="manage-instance-title"
         class="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-border bg-raised shadow-xl focus:outline-none" data-test="manage-instance-dialog">
      <header class="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
        <h2 id="manage-instance-title" class="truncate text-sm font-semibold text-fg">{{ $t("instance.manageTitle", { name }) }}</h2>
        <button class="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg" :aria-label="$t('instance.close')" @click="emit('close')"><X :size="16" /></button>
      </header>
      <div v-if="loading" class="py-6 text-center text-sm text-fg-muted">{{ $t("instance.dialogLoading") }}</div>
      <template v-else>
        <!-- Tab strip: General / Workspaces / Agents — Agents is always one click away. -->
        <nav class="flex shrink-0 gap-1 border-b border-border px-3 pt-2" role="tablist" @keydown="onTabKeydown">
          <button v-for="tb in (['general','workspaces','agents'] as const)" :key="tb"
                  :id="`tab-${tb}`" :data-test="`tab-${tb}`" role="tab" :aria-selected="tab === tb"
                  :aria-controls="`tabpanel-${tb}`" :tabindex="tab === tb ? 0 : -1"
                  class="rounded-t px-3 py-1.5 text-sm font-medium transition-colors"
                  :class="tab === tb ? 'border-b-2 border-accent text-fg' : 'text-fg-muted hover:text-fg'"
                  @click="tab = tb">
            {{ tb === 'general' ? $t('instance.tabGeneral') : tb === 'workspaces' ? $t('workspaces.title') : $t('agents.title') }}
          </button>
        </nav>
        <div class="flex-1 overflow-y-auto p-5">
          <div v-if="tab === 'general'" id="tabpanel-general" role="tabpanel" aria-labelledby="tab-general" class="space-y-6">
            <section class="space-y-3">
              <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.nameLabel") }}</h3>
              <p v-if="renameError" data-test="rename-error" class="rounded bg-danger/10 px-3 py-2 text-sm text-danger">{{ renameError }}</p>
              <div class="flex gap-2">
                <input v-model="name" data-test="rename-name" :placeholder="$t('instance.renamePlaceholder')"
                       class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                       @keyup.enter="saveName" />
                <button data-test="rename-save" class="shrink-0 rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
                        :disabled="renaming || !name.trim()" @click="saveName">{{ renaming ? $t("instance.renameSaving") : $t("instance.renameSave") }}</button>
              </div>
            </section>
            <section class="space-y-2">
              <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.groupModeLabel") }}</h3>
              <div class="flex gap-1" role="radiogroup" :aria-label="$t('instance.groupModeLabel')">
                <button v-for="m in GROUP_MODES" :key="m" type="button" role="radio"
                        :aria-checked="groupMode === m" :data-test="`group-mode-${m}`"
                        class="flex-1 rounded px-2 py-1.5 text-xs"
                        :class="groupMode === m ? 'bg-accent text-white' : 'bg-bg border border-border text-fg-muted hover:bg-fg/5'"
                        @click="pickGroupMode(m)">
                  {{ m === 'instance' ? $t('instance.groupModeInstance') : m === 'workspace' ? $t('instance.groupModeWorkspace') : $t('instance.groupModeAgent') }}
                </button>
              </div>
              <p class="text-xs text-fg-muted">{{ $t("instance.groupModeHint") }}</p>
            </section>
            <section class="space-y-2">
              <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.autoCollabTitle") }}</h3>
              <div class="flex items-center gap-3">
                <button v-if="panel.phase !== 'read-only'" data-test="router-toggle" type="button" role="switch"
                        :aria-checked="routerEnabled"
                        :aria-label="routerEnabled ? $t('instance.autoCollabDisable') : $t('instance.autoCollabEnable')"
                        :disabled="!routerEditable || routerSaving || !instanceOnline"
                        class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        :class="routerEnabled ? 'border-accent bg-accent' : 'border-border bg-bg'"
                        @click="toggleRouter">
                  <span class="pointer-events-none inline-block h-5 w-5 rounded-full shadow-e1 transition-transform"
                        :class="routerEnabled ? 'translate-x-5 bg-white' : 'translate-x-0.5 bg-fg-muted'" />
                </button>
                <p data-test="router-status" class="text-sm text-fg-muted">{{ routerStatus }}</p>
              </div>
              <div v-if="routerReason" data-test="router-reason" class="space-y-1 rounded bg-fg/5 px-3 py-2">
                <p data-test="router-reason-explain" class="text-xs text-fg">{{ routerReason.explain }}</p>
                <p v-if="routerReason.detail" data-test="router-reason-detail" class="break-words font-mono text-xs text-fg-muted">{{ routerReason.detail }}</p>
              </div>
              <p data-test="router-hint" class="text-xs text-fg-muted">{{ routerHint }}</p>
              <p v-if="routerErrorText" data-test="router-error" class="text-xs text-error">{{ routerErrorText }}</p>
            </section>
            <!-- Jev routing settings: the brain behind automatic collaboration.
                 Instance-scoped, stored daemon-side, key never displayed. -->
            <section v-if="jevEditable" data-test="jev-settings" class="space-y-2">
              <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.jevTitle") }}</h3>
              <p class="text-xs text-fg-muted">{{ $t("instance.jevBody") }}</p>
              <div class="space-y-1">
                <label class="block text-xs font-medium text-fg-muted" for="jev-endpoint">{{ $t("instance.jevEndpoint") }}</label>
                <input id="jev-endpoint" v-model="jevEndpoint" data-test="jev-endpoint" type="url" inputmode="url"
                       placeholder="https://api.typesafe.ai/v1/systemone"
                       class="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
              </div>
              <div class="space-y-1">
                <label class="block text-xs font-medium text-fg-muted" for="jev-key">{{ $t("instance.jevApiKey") }}</label>
                <div class="flex gap-2">
                  <input id="jev-key" v-model="jevKeyDraft" data-test="jev-api-key" type="password" autocomplete="new-password"
                         :placeholder="jevSettings?.keyMasked ?? $t('instance.jevApiKeyEmpty')"
                         class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                  <button v-if="jevSettings?.keyConfigured" data-test="jev-api-key-clear" type="button"
                          class="shrink-0 rounded border border-border px-2 py-1 text-xs text-fg-muted hover:bg-fg/5 hover:text-fg"
                          @click="clearJevKey">{{ $t("instance.jevApiKeyClear") }}</button>
                </div>
                <p v-if="jevSettings?.keyConfigured && !jevKeyCleared" data-test="jev-api-key-masked" class="text-xs text-fg-muted">
                  {{ $t("instance.jevApiKeyMasked", { masked: jevSettings.keyMasked ?? "" }) }}
                </p>
                <p v-else-if="jevKeyCleared" data-test="jev-api-key-cleared" class="text-xs text-fg-muted">
                  {{ $t("instance.jevApiKeyWillClear") }}
                </p>
              </div>
              <div class="space-y-1">
                <label class="block text-xs font-medium text-fg-muted" for="jev-proxy">{{ $t("instance.jevProxy") }}</label>
                <input id="jev-proxy" v-model="jevProxy" data-test="jev-proxy" type="url" inputmode="url"
                       placeholder="http://127.0.0.1:8080"
                       class="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-xs text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
                <p class="text-xs text-fg-muted">{{ $t("instance.jevProxyHint") }}</p>
              </div>
              <div class="space-y-1">
                <span class="block text-xs font-medium text-fg-muted">{{ $t("instance.jevModel") }}</span>
                <p data-test="jev-model" class="font-mono text-xs text-fg">{{ jevSettings?.model }}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button data-test="jev-save" type="button"
                        class="rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover disabled:opacity-50"
                        :disabled="jevSaving || !instanceOnline" @click="saveJev">
                  {{ jevSaving ? $t("instance.jevSaving") : $t("instance.jevSave") }}
                </button>
                <button data-test="jev-test" type="button"
                        class="rounded border border-border px-3 py-1.5 text-xs text-fg hover:bg-fg/5 disabled:opacity-50"
                        :disabled="jevPanel.phase !== 'editable' || jevPanel.test.kind === 'testing' || !instanceOnline"
                        @click="testJev">{{ $t("instance.jevTestButton") }}</button>
                <span v-if="jevTestView" data-test="jev-test-result" class="text-xs"
                      :class="jevTestView.kind === 'ok' ? 'text-success' : jevTestView.kind === 'failed' ? 'text-error' : 'text-fg-muted'">
                  {{ jevTestView.kind === 'testing' ? $t("instance.jevTesting") : jevTestView.text }}
                </span>
              </div>
              <p v-if="jevTestView?.kind === 'failed' && jevTestView.detail" data-test="jev-test-detail" class="break-words font-mono text-xs text-fg-muted">{{ jevTestView.detail }}</p>
              <p v-if="jevErrorText" data-test="jev-error" class="text-xs text-error">{{ jevErrorText }}</p>
            </section>
            <p v-else-if="jevUpgradeNotice" data-test="jev-upgrade-notice" class="text-xs text-fg-muted">{{ $t(jevUpgradeNotice) }}</p>
            <section class="space-y-1">
              <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.versionLabel") }}</h3>
              <p class="text-sm text-fg-muted" data-test="instance-version">
                {{ coreVersion ? $t("instance.coreVersion", { version: coreVersion }) : $t("instance.coreVersionUnknown") }}
              </p>
            </section>
          </div>
          <div v-else-if="tab === 'workspaces'" id="tabpanel-workspaces" role="tabpanel" aria-labelledby="tab-workspaces"><WorkspacesManager :instance-id="instanceId" /></div>
          <div v-else-if="tab === 'agents'" id="tabpanel-agents" role="tabpanel" aria-labelledby="tab-agents"><AgentsManager :instance-id="instanceId" /></div>
        </div>
      </template>
    </div>
  </div>
  </Teleport>
</template>
