<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "lucide-vue-next";
import { useInstancesStore } from "../stores/instances";
import WorkspacesManager from "./WorkspacesManager.vue";
import AgentsManager from "./AgentsManager.vue";

const props = defineProps<{ instanceId: string; instanceName: string }>();
const emit = defineEmits<{ close: [] }>();
const store = useInstancesStore();
const { t } = useI18n();

const coreVersion = computed(() => store.byId(props.instanceId)?.coreVersion ?? null);

const loading = ref(true);
type Tab = "general" | "workspaces" | "agents";
const tab = ref<Tab>("general");

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

// Accessibility: trap focus inside the dialog, close on Esc, and restore focus to
// whatever was focused before the dialog opened.
const dialogEl = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function focusables(): HTMLElement[] {
  return dialogEl.value ? Array.from(dialogEl.value.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") { e.preventDefault(); emit("close"); return; }
  if (e.key !== "Tab") return;
  const els = focusables();
  if (els.length === 0) return;
  const first = els[0], last = els[els.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
}

onMounted(async () => {
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.addEventListener("keydown", onKeydown);
  void nextTick(() => { (focusables()[0] ?? dialogEl.value)?.focus(); });
  try {
    await store.loadFormOptions(props.instanceId);
  } catch {
    // best-effort: managers degrade to empty lists if options fail to load
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  previouslyFocused?.focus?.();
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
        <nav class="flex shrink-0 gap-1 border-b border-border px-3 pt-2" role="tablist">
          <button v-for="tb in (['general','workspaces','agents'] as const)" :key="tb"
                  :data-test="`tab-${tb}`" role="tab" :aria-selected="tab === tb"
                  class="rounded-t px-3 py-1.5 text-sm font-medium transition-colors"
                  :class="tab === tb ? 'border-b-2 border-accent text-fg' : 'text-fg-muted hover:text-fg'"
                  @click="tab = tb">
            {{ tb === 'general' ? $t('instance.tabGeneral') : tb === 'workspaces' ? $t('workspaces.title') : $t('agents.title') }}
          </button>
        </nav>
        <div class="flex-1 overflow-y-auto p-5">
          <div v-if="tab === 'general'" class="space-y-6">
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
            <section class="space-y-1">
              <h3 class="text-sm font-semibold uppercase text-fg-muted">{{ $t("instance.versionLabel") }}</h3>
              <p class="text-sm text-fg-muted" data-test="instance-version">
                {{ coreVersion ? $t("instance.coreVersion", { version: coreVersion }) : $t("instance.coreVersionUnknown") }}
              </p>
            </section>
          </div>
          <div v-else-if="tab === 'workspaces'"><WorkspacesManager :instance-id="instanceId" /></div>
          <div v-else-if="tab === 'agents'"><AgentsManager :instance-id="instanceId" /></div>
        </div>
      </template>
    </div>
  </div>
  </Teleport>
</template>
