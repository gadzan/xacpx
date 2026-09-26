<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Expand, Maximize, Minimize, Monitor, Shrink, X } from "lucide-vue-next";
import { useDesktopStore } from "../stores/desktop";

const props = withDefaults(
  defineProps<{ instanceId: string; instanceName?: string; active?: boolean }>(),
  { instanceName: "", active: true },
);
defineEmits<{ close: [] }>();

const { t } = useI18n();
const desktops = useDesktopStore();
const host = ref<HTMLDivElement | null>(null);
const password = ref("");
const showPassword = ref(false);
const session = computed(() => desktops.viewFor(props.instanceId));
/** Fullscreen state of the desktop container (design §14 v1 UI). */
const fullscreen = ref(false);

/**
 * Protocol/connector error codes → i18n keys. Unmapped codes fall back to the
 * server's own message so a new hub code still shows something useful.
 */
const DESKTOP_ERROR_I18N_KEYS: Record<string, string> = {
  "desktop-disabled": "desktop.disabled",
  "desktop-offline": "desktop.offline",
  "instance-offline": "desktop.offline",
  "events-offline": "desktop.offline",
  "desktop-busy": "desktop.busy",
  "desktop-rfb-unavailable": "desktop.rfbUnavailable",
  "desktop-not-rfb": "desktop.notRfb",
  "desktop-auth-unsupported": "desktop.authUnsupported",
  "desktop-stream-timeout": "desktop.streamTimeout",
  "desktop-auth-unsupported-ard": "desktop.authUnsupported",
};

const statusLabel = computed(() => {
  const s = session.value.status;
  if (s === "opening") return "desktop.statusOpening";
  if (s === "auth-required") return "desktop.statusAuth";
  if (s === "connecting") return "desktop.statusConnecting";
  if (s === "open") return "desktop.statusOpen";
  if (s === "closed") return "desktop.statusClosed";
  if (s === "error") return session.value.lastErrorCode ? DESKTOP_ERROR_I18N_KEYS[session.value.lastErrorCode] ?? "desktop.statusError" : "desktop.statusError";
  return "desktop.statusIdle";
});
/** Final error banner copy: translated protocol code + the server's detail. */
const errorDetail = computed(() => {
  const s = session.value;
  if (s.status !== "error") return "";
  const key = s.lastErrorCode ? DESKTOP_ERROR_I18N_KEYS[s.lastErrorCode] : undefined;
  return key ? t(key) : s.lastErrorCode ?? "";
});

async function open(): Promise<void> {
  password.value = "";
  showPassword.value = false;
  try {
    // The mounted [data-test=desktop-host] div is noVNC's render target:
    // without it the framebuffer lands in a detached div and the tab stays black.
    await desktops.open(props.instanceId, {}, { target: host.value });
  } catch {
    /* store holds the error code for render */
  }
}

function submitPassword(): void {
  if (!password.value) return;
  desktops.sendCredentials(props.instanceId, password.value);
  password.value = "";
  showPassword.value = false;
}

function toggleFit(): void {
  desktops.setFit(props.instanceId, !session.value.fit);
}

/** Fullscreen over the whole viewport (design §14 v1 UI). */
async function toggleFullscreen(): Promise<void> {
  const el = host.value?.closest("[data-test='desktop-center']") as HTMLElement | null;
  if (!el) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen();
  } catch {
    /* denied / unsupported: leave the button state in sync below */
  }
}

// Track the browser's own fullscreen state (Esc, F11, OS gestures) so the
// button never lies about the current mode.
function onFullscreenChange(): void {
  fullscreen.value = document.fullscreenElement !== null;
}

function reconnect(): void {
  desktops.close(props.instanceId);
  void open();
}

onMounted(() => {
  // Attach the noVNC target after mount: the store opens the control RPC
  // immediately, then the client binds to this host element.
  void open();
  document.addEventListener("fullscreenchange", onFullscreenChange);
});
watch(() => props.instanceId, () => {
  desktops.close(props.instanceId);
  void open();
});
onBeforeUnmount(() => {
  desktops.close(props.instanceId);
  document.removeEventListener("fullscreenchange", onFullscreenChange);
});
</script>

<template>
  <div class="flex h-full flex-col bg-bg" data-test="desktop-center">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <Monitor :size="15" class="shrink-0 text-fg-muted" />
      <span class="min-w-0 truncate text-[12.5px] text-fg">{{ props.instanceName || props.instanceId }}</span>
      <span data-test="desktop-status" class="shrink-0 text-[11px] text-fg-muted">{{ $t(statusLabel) }}</span>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button data-test="desktop-fit-toggle"
                type="button"
                :aria-label="$t(session.fit ? 'desktop.fit' : 'desktop.actual')"
                :title="$t(session.fit ? 'desktop.fit' : 'desktop.actual')"
                class="grid h-7 w-7 place-items-center rounded transition-colors"
                :class="session.fit ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-raised hover:text-fg'"
                @click="toggleFit">
          <Minimize v-if="session.fit" :size="15" />
          <Maximize v-else :size="15" />
        </button>
        <button data-test="desktop-fullscreen-toggle"
                type="button"
                :aria-label="$t(fullscreen ? 'desktop.exitFullscreen' : 'desktop.fullscreen')"
                :title="$t(fullscreen ? 'desktop.exitFullscreen' : 'desktop.fullscreen')"
                class="grid h-7 w-7 place-items-center rounded transition-colors"
                :class="fullscreen ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-raised hover:text-fg'"
                @click="toggleFullscreen">
          <Shrink v-if="fullscreen" :size="15" />
          <Expand v-else :size="15" />
        </button>
        <button data-test="desktop-close"
                type="button"
                :aria-label="$t('desktop.disconnect')"
                :title="$t('desktop.disconnect')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="$emit('close')">
          <X :size="15" />
        </button>
      </div>
    </div>

    <div v-if="session.status === 'error'" class="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-fg-muted" data-test="desktop-error">
      <span data-test="desktop-error-code" class="shrink-0">{{ errorDetail }}</span><span v-if="session.lastErrorMessage"> — {{ session.lastErrorMessage }}</span>
      <button type="button" class="ml-2 underline" @click="reconnect">{{ $t("desktop.reconnect") }}</button>
    </div>
    <div v-else-if="session.status === 'closed'" class="shrink-0 border-b border-border bg-surface px-3 py-2 text-[12px] text-fg-muted" data-test="desktop-closed">
      {{ $t("desktop.statusClosed") }}
      <button type="button" class="ml-2 underline" @click="reconnect">{{ $t("desktop.reconnect") }}</button>
    </div>

    <div ref="host" data-test="desktop-host" class="relative min-h-0 flex-1 overflow-hidden bg-black"></div>

    <div v-if="session.status === 'auth-required' || showPassword"
         class="absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-border bg-surface/95 px-3 py-2 backdrop-blur-md"
         data-test="desktop-password-bar">
      <input v-model="password"
             data-test="desktop-password"
             type="password"
             autocomplete="off"
             :placeholder="$t('desktop.passwordPlaceholder')"
             class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[13px] text-fg outline-none focus:border-accent"
             @keydown.enter.prevent="submitPassword" />
      <button data-test="desktop-password-submit"
              type="button"
              :disabled="!password"
              class="shrink-0 rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-40"
              @click="submitPassword">{{ $t("desktop.connect") }}</button>
    </div>
  </div>
</template>
