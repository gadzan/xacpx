<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { LogOut } from "lucide-vue-next";
import { api } from "../api/client";
import { useAuthStore } from "../stores/auth";
import { useThemeStore } from "../stores/theme";
import { useLocaleStore } from "../stores/locale";
import { useI18n } from "vue-i18n";
import { SUPPORTED_LOCALES } from "../i18n";
import { confirm } from "../lib/use-confirm";
import { useInstancesStore, type InstanceView } from "../stores/instances";
import {
  pushSupported,
  fetchVapidPublicKey,
  enableDesktopNotifications,
  disableDesktopNotifications,
  subscriptionMatchesKey,
  getExistingSubscription,
  isDesktopNotificationsEnabled,
} from "../lib/web-push";
const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();
const locale = useLocaleStore();
const { t } = useI18n();
const instances = useInstancesStore();
const localeLabels: Record<string, string> = { en: "English", "zh-CN": "中文" };
const retention = ref<{ days: number; maxPerSession: number } | null>(null);
const pairing = ref("");
const pairingName = ref("");
const relay = ref<{ current: string; latest: string | null; updateAvailable: boolean } | null>(null);
/** Per-instance in-flight guard for the automatic-collaboration switch. */
const routerBusy = ref<Record<string, boolean>>({});
/** Per-instance failure text from the last switch attempt; cleared on retry. */
const routerError = ref<Record<string, string>>({});

onMounted(async () => {
  try {
    const cfg = await api.get<{ historyRetention: { days: number; maxPerSession: number } }>("/api/config");
    retention.value = cfg.historyRetention;
  } catch { /* leave null; UI shows a dash */ }
  try {
    relay.value = await api.get<{ current: string; latest: string | null; updateAvailable: boolean }>("/api/version");
  } catch { /* leave null; relay section shows a dash */ }
  try {
    await instances.loadInstances();
  } catch { /* leave the section empty; it renders no rows */ }
  // The switch state is instance-side, not hub-side: read it per instance so the
  // toggle shows the daemon's resolved availability rather than a guess.
  for (const inst of instances.instances) void instances.loadRouterAvailability(inst.id);
});

/** The daemon's four-status availability, never a boolean. */
function routerStatusLabel(id: string): string {
  const state = instances.routerAvailabilityFor(id);
  if (state.status === "loading") return t("settings.autoCollabChecking");
  if (state.status === "ready") return t("settings.autoCollabOn");
  if (state.status === "disabled-by-config") return t("settings.autoCollabOff");
  return t("settings.autoCollabUnavailable", { reason: state.reason.message, path: state.configPath });
}

async function toggleRouter(inst: InstanceView): Promise<void> {
  if (routerBusy.value[inst.id]) return;
  const next = instances.routerAvailabilityFor(inst.id).status !== "ready";
  routerBusy.value = { ...routerBusy.value, [inst.id]: true };
  try {
    await instances.setConversationRouterEnabled(inst.id, next);
    routerError.value = Object.fromEntries(Object.entries(routerError.value).filter(([key]) => key !== inst.id));
  } catch (error) {
    // The daemon answers with the reason (e.g. command not configured); show it
    // and re-read so the toggle converges to the persisted truth.
    routerError.value = {
      ...routerError.value,
      [inst.id]: error instanceof Error ? error.message : String(error),
    };
    await instances.loadRouterAvailability(inst.id).catch(() => {});
  } finally {
    routerBusy.value = { ...routerBusy.value, [inst.id]: false };
  }
}

async function genPairing() {
  const r = await api.post<{ token: string }>("/api/instances/pairing-token", { name: pairingName.value });
  pairing.value = r.token;
}

async function onLogout() {
  const ok = await confirm({
    title: t("settings.signOutTitle"),
    message: t("settings.signOutBody"),
    confirmLabel: t("settings.signOut"),
    tone: "default",
  });
  if (!ok) return;
  await auth.logout();
  router.push({ name: "login" });
}

type NotifState = "unsupported" | "server-disabled" | "denied" | "idle" | "subscribed";
const notifState = ref<NotifState>("idle");
const notifBusy = ref(false);
let vapidKey: string | null = null;
async function probeNotifications(): Promise<void> {
  // Capability boundary first: no Notification API at all -> unsupported, never toggleable.
  if (typeof Notification === "undefined") {
    notifState.value = "unsupported";
    return;
  }
  if (Notification.permission === "denied") {
    notifState.value = "denied";
    return;
  }
  // Master switch status is purely user-intent driven
  notifState.value = isDesktopNotificationsEnabled() ? "subscribed" : "idle";

  if (!pushSupported()) return;
  try {
    const key = await fetchVapidPublicKey();
    if (!key) return;
    vapidKey = key;
    const sub = await getExistingSubscription();
    // If user has enabled notifications and a key exists, reconcile subscription
    if (sub && isDesktopNotificationsEnabled() && !subscriptionMatchesKey(sub, key)) {
      await enableDesktopNotifications(key).catch(() => {});
    }
  } catch { /* best-effort background push probe */ }
}

const isIos = typeof navigator !== "undefined" && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1)
);

async function toggleNotifications(): Promise<void> {
  if (notifBusy.value) return;
  notifBusy.value = true;
  try {
    if (notifState.value === "subscribed" || isDesktopNotificationsEnabled()) {
      await disableDesktopNotifications();
      notifState.value = "idle";
    } else {
      await enableDesktopNotifications(vapidKey);
      notifState.value = "subscribed";
    }
  } catch (err) {
    if (err instanceof Error && err.message === "permission-denied") {
      notifState.value = "denied";
      return;
    }
    // Web Push transport failed AFTER intent may already have been written true.
    // Always re-read the single source of truth instead of leaving stale UI.
    notifState.value = isDesktopNotificationsEnabled() ? "subscribed" : "idle";
  } finally {
    notifBusy.value = false;
  }
}

const notifStateLabel = computed(() => ({
  unsupported: t("settings.notifUnsupported"),
  "server-disabled": t("settings.notifServerDisabled"),
  denied: t("settings.notifDenied"),
  idle: t("settings.notifOff"),
  subscribed: t("settings.notifOn"),
}[notifState.value]));

void onMounted(() => { void probeNotifications(); });
</script>

<template>
  <!-- Standalone full-screen route (no shared safe-area header like the dashboard has),
       so apply the notch/home-indicator insets here. body is already bg-bg, so the area
       behind the notch stays dark. -->
  <div class="mx-auto max-w-2xl px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(1.5rem+env(safe-area-inset-top))]">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-lg font-semibold text-fg">{{ $t("settings.title") }}</h1>
      <router-link to="/" class="text-sm text-fg-muted hover:underline">{{ $t("common.back") }}</router-link>
    </header>

    <section data-test="theme-setting" class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.appearance") }}</h2>
      <div class="space-y-3">
        <div class="inline-flex gap-1 rounded-lg border border-border bg-bg p-1">
          <button
            data-test="theme-dark"
            class="rounded-md px-3 py-1 text-sm"
            :class="theme.mode === 'dark' ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-fg/5'"
            @click="theme.set('dark')"
          >{{ $t("settings.dark") }}</button>
          <button
            data-test="theme-light"
            class="rounded-md px-3 py-1 text-sm"
            :class="theme.mode === 'light' ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-fg/5'"
            @click="theme.set('light')"
          >{{ $t("settings.light") }}</button>
        </div>
        <div data-test="language-setting" class="flex items-center gap-2">
          <span class="text-sm text-fg-muted">{{ $t("settings.language") }}</span>
          <div class="inline-flex gap-1 rounded-lg border border-border bg-bg p-1">
            <button
              v-for="loc in SUPPORTED_LOCALES"
              :key="loc"
              :data-test="`lang-${loc}`"
              class="rounded-md px-3 py-1 text-sm"
              :class="locale.locale === loc ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-fg/5'"
              @click="locale.set(loc)"
            >{{ localeLabels[loc] }}</button>
          </div>
        </div>
      </div>
    </section>

    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.addInstance") }}</h2>
      <div class="flex gap-2">
        <input v-model="pairingName" :placeholder='$t("settings.instanceNamePlaceholder")' class="flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <button data-test="gen-pairing" class="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover" @click="genPairing">{{ $t("settings.generateToken") }}</button>
      </div>
      <div v-if="pairing" class="mt-2 rounded bg-bg border border-border p-2 text-xs text-fg">
        <div>{{ $t("settings.runOnHost") }}</div>
        <code class="block break-all">xacpx channel add relay --url &lt;this-relay-ws-url&gt; --token {{ pairing }}</code>
      </div>
    </section>

    <section class="mb-8" data-test="auto-collab-setting">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.autoCollabTitle") }}</h2>
      <p class="text-sm text-fg-muted">{{ $t("settings.autoCollabBody") }}</p>
      <div v-for="inst in instances.instances" :key="inst.id" class="mt-3 flex flex-wrap items-center gap-3" :data-test="`auto-collab-row-${inst.id}`">
        <span class="text-sm text-fg">{{ inst.name }}</span>
        <span data-test="auto-collab-state" class="text-sm text-fg-muted">{{ routerStatusLabel(inst.id) }}</span>
        <button
          data-test="auto-collab-toggle"
          class="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          :disabled="routerBusy[inst.id] || !inst.online || instances.routerAvailabilityFor(inst.id).status === 'loading'"
          @click="toggleRouter(inst)"
        >{{ instances.routerAvailabilityFor(inst.id).status === "ready" ? $t("settings.autoCollabDisable") : $t("settings.autoCollabEnable") }}</button>
        <p v-if="routerError[inst.id]" data-test="auto-collab-error" class="w-full text-xs text-error">
          {{ $t("settings.autoCollabFailed", { message: routerError[inst.id] }) }}
        </p>
      </div>
    </section>

    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.retentionTitle") }}</h2>
      <p class="text-sm text-fg-muted" data-test="retention-body">
        {{ $t("settings.retentionBody", { max: retention?.maxPerSession ?? "—", days: retention?.days ?? "—" }) }}
      </p>
    </section>

    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.relayTitle") }}</h2>
      <p class="text-sm text-fg-muted" data-test="relay-version">
        {{ $t("settings.relayVersion", { version: relay?.current ?? "—" }) }}
      </p>
      <p v-if="relay?.latest && relay.updateAvailable" class="mt-1 text-sm text-accent" data-test="relay-update">
        {{ $t("settings.relayUpdateAvailable", { latest: relay?.latest }) }}
      </p>
    </section>

    <section class="mb-8" data-test="notif-setting">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.notifTitle") }}</h2>
      <div class="flex items-center gap-3">
        <span data-test="notif-state" class="text-sm text-fg-muted">{{ notifStateLabel }}</span>
        <button
          v-if="notifState === 'subscribed' || notifState === 'idle' || notifState === 'server-disabled'"
          data-test="notif-toggle"
          :disabled="notifBusy"
          class="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          @click="toggleNotifications"
        >{{ notifState === "subscribed" ? $t("settings.notifDisable") : $t("settings.notifEnable") }}</button>
      </div>
      <p v-if="notifState === 'denied'" class="mt-1 text-xs text-fg-muted">{{ $t("settings.notifDeniedHint") }}</p>
      <p v-if="isIos" class="mt-1 text-xs text-fg-muted" data-test="notif-ios-hint">{{ $t("settings.notifIosHint") }}</p>
    </section>
    <section>
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.account") }}</h2>
      <button
        data-test="logout"
        class="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm text-fg-muted transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
        @click="onLogout"
      >
        <LogOut :size="15" />{{ $t("settings.signOut") }}
      </button>
    </section>
  </div>
</template>
