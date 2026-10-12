<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Expand, Maximize, Minimize, Monitor, Shrink, X } from "lucide-vue-next";
import { parseDesktopCredential } from "@ganglion/xacpx-relay-protocol";
import { useDesktopStore } from "../stores/desktop";
import { desktopErrorKey } from "../lib/desktop-error-i18n";

const props = withDefaults(
  defineProps<{ instanceId: string; instanceName?: string; active?: boolean }>(),
  { instanceName: "", active: true },
);
defineEmits<{ close: [] }>();

const { t } = useI18n();
const desktops = useDesktopStore();
const host = ref<HTMLDivElement | null>(null);
const username = ref("");
const password = ref("");
const session = computed(() => desktops.viewFor(props.instanceId));
const macosPrompt = computed(() => {
  const s = session.value;
  return s.status === "auth-required" && s.prompt.kind === "macos-account" ? s.prompt : null;
});
const vncPrompt = computed(() => {
  const s = session.value;
  return s.status === "auth-required" && s.prompt.kind === "vnc-password";
});
const accountReady = computed(() =>
  parseDesktopCredential({ kind: "ard", username: username.value, password: password.value }) !== null);
watch(() => {
  const s = session.value;
  if (s.status !== "auth-required" || s.prompt.kind !== "macos-account") return null;
  return s.ardUsername ?? "";
}, (name) => {
  if (name !== null) username.value = name;
});
/** Fullscreen state of the desktop container (design §14 v1 UI). */
const fullscreen = ref(false);

const statusLabel = computed(() => {
  const current = session.value;
  if (current.status === "opening") return "desktop.statusOpening";
  if (current.status === "auth-required") {
    return current.prompt.kind === "macos-account" ? "desktop.statusMacos" : "desktop.statusAuth";
  }
  if (current.status === "connecting") return "desktop.statusConnecting";
  if (current.status === "open") return "desktop.statusOpen";
  if (current.status === "closed") return "desktop.statusClosed";
  if (current.status === "error") return desktopErrorKey(current.lastErrorCode) ?? "desktop.statusError";
  return "desktop.statusIdle";
});
/** Final error banner copy: translated protocol code + the server's detail. */
const errorDetail = computed(() => {
  const s = session.value;
  if (s.status !== "error") return "";
  return desktopErrorKey(s.lastErrorCode) ? t(desktopErrorKey(s.lastErrorCode)!) : s.lastErrorCode ?? "";
});
/**
 * Why a `closed` row closed. Retryable prepare failures keep their reason on
 * the row, so a row that is closed because the instance went offline (or the
 * open timed out) must show that reason rather than the bare
 * `desktop.statusClosed` copy. A plain viewer-initiated close carries no
 * `lastErrorCode`, so it keeps the generic message.
 */
const closedDetail = computed(() => {
  const s = session.value;
  if (s.lastErrorCode === undefined) return "";
  const key = desktopErrorKey(s.lastErrorCode);
  if (key) return t(key);
  return s.lastErrorMessage ? s.lastErrorCode : "";
});

async function open(): Promise<void> {
  password.value = "";
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
}

function submitAccount(): void {
  if (!accountReady.value) return;
  desktops.signIn(props.instanceId, { username: username.value, password: password.value });
  password.value = "";
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
  password.value = "";
  desktops.reconnect(props.instanceId);
}

onMounted(() => {
  // Attach the noVNC target after mount: the store opens the control RPC
  // immediately, then the client binds to this host element.
  void open();
  document.addEventListener("fullscreenchange", onFullscreenChange);
});
// The callback's `props.instanceId` is already the NEW value, so closing it
// would tear down the instance we are about to open and leak the old one's RFB
// connection + hub stream. Take the previous value from the watch args.
watch(() => props.instanceId, (_next, prev) => {
  if (prev) desktops.close(prev);
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
      {{ closedDetail || $t("desktop.statusClosed") }}
      <button type="button" class="ml-2 underline" @click="reconnect">{{ $t("desktop.reconnect") }}</button>
    </div>

    <div ref="host" data-test="desktop-host" class="relative min-h-0 flex-1 overflow-hidden bg-black"></div>

    <form v-if="macosPrompt"
          data-test="desktop-macos-signin"
          class="absolute inset-0 z-20 grid place-items-center bg-bg/80"
          @submit.prevent="submitAccount">
      <div class="w-72 space-y-2 rounded-lg border border-border bg-surface p-4">
        <p class="text-[13px] text-fg">{{ $t("desktop.macosSignInTitle", { name: props.instanceName || props.instanceId }) }}</p>
        <p class="text-[11.5px] text-fg-muted">{{ $t("desktop.macosSignInHint") }}</p>
        <input v-model="username"
               data-test="desktop-macos-account"
               autocomplete="off"
               autocapitalize="off"
               spellcheck="false"
               :placeholder="$t('desktop.macosAccountName')"
               class="w-full rounded border border-border bg-bg px-2 py-1 text-[13px] text-fg outline-none focus:border-accent" />
        <input v-model="password"
               data-test="desktop-macos-password"
               type="password"
               autocomplete="off"
               :placeholder="$t('desktop.macosPassword')"
               class="w-full rounded border border-border bg-bg px-2 py-1 text-[13px] text-fg outline-none focus:border-accent" />
        <p v-if="macosPrompt.rejected" data-test="desktop-macos-rejected" class="text-[11.5px] text-danger">
          {{ $t("desktop.macosRejected") }}
        </p>
        <button data-test="desktop-macos-submit"
                type="submit"
                :disabled="!accountReady"
                class="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white disabled:opacity-40">
          {{ $t("desktop.connect") }}
        </button>
      </div>
    </form>

    <div v-if="vncPrompt"
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
