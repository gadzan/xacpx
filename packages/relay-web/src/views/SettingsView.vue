<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowLeft, Info, LogOut } from "lucide-vue-next";
import { useRouter } from "vue-router";
import { api } from "../api/client";
import { useAuthStore } from "../stores/auth";
import { useThemeStore } from "../stores/theme";
import { useLocaleStore } from "../stores/locale";
import { useI18n } from "vue-i18n";
import { SUPPORTED_LOCALES } from "../i18n";
import { confirm } from "../lib/use-confirm";
import {
  pushSupported,
  fetchVapidPublicKey,
  enableDesktopNotifications,
  disableDesktopNotifications,
  subscriptionMatchesKey,
  getExistingSubscription,
  isDesktopNotificationsEnabled,
} from "../lib/web-push";
import AddInstanceDialog from "../components/AddInstanceDialog.vue";
import Tooltip from "../components/Tooltip.vue";
const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();
const locale = useLocaleStore();
const { t } = useI18n();
const localeLabels: Record<string, string> = { en: "English", "zh-CN": "中文" };
const retention = ref<{ days: number; maxPerSession: number } | null>(null);
const relay = ref<{ current: string; latest: string | null; updateAvailable: boolean } | null>(null);
const showAddInstance = ref(false);

onMounted(async () => {
  try {
    const cfg = await api.get<{ historyRetention: { days: number; maxPerSession: number } }>("/api/config");
    retention.value = cfg.historyRetention;
  } catch { /* leave null; UI shows a dash */ }
  try {
    relay.value = await api.get<{ current: string; latest: string | null; updateAvailable: boolean }>("/api/version");
  } catch { /* leave null; relay section shows a dash */ }
});

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

/** The explanations that used to stack under the notification row, now behind one ⓘ. */
const notifHint = computed(() => {
  const parts: string[] = [];
  if (notifState.value === "denied") parts.push(t("settings.notifDeniedHint"));
  if (isIos) parts.push(t("settings.notifIosHint"));
  return parts.join(" ");
});

void onMounted(() => { void probeNotifications(); });
</script>

<template>
  <!-- Standalone full-screen route (no shared safe-area header like the dashboard has),
       so apply the notch/home-indicator insets here. body is already bg-bg, so the area
       behind the notch stays dark. One raised card, 44px rows, a hairline between
       them, and the same glass ← disc the conversation bars use. -->
  <div class="mx-auto max-w-2xl px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-[calc(1rem+env(safe-area-inset-top))]">
    <header class="mb-4 flex items-center gap-3 px-1">
      <router-link to="/" data-test="settings-back" :aria-label="$t('common.back')" :title="$t('common.back')"
                   class="glass-control grid h-11 w-11 shrink-0 place-items-center rounded-full text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <ArrowLeft :size="20" />
      </router-link>
      <h1 class="text-lg font-semibold text-fg">{{ $t("settings.title") }}</h1>
    </header>

    <div class="overflow-hidden rounded-card border border-hairline bg-raised">
      <section data-test="theme-setting" class="flex min-h-11 flex-wrap items-center justify-between gap-3 px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.appearance") }}</h2>
        <div class="inline-flex gap-1 rounded-btn bg-bg p-1">
          <button
            data-test="theme-dark"
            class="rounded-sm px-3 py-1 text-sm [@media(pointer:coarse)]:min-h-11"
            :class="theme.mode === 'dark' ? 'bg-accent-soft text-accent-text' : 'text-fg-muted hover:bg-fg/5'"
            @click="theme.set('dark')"
          >{{ $t("settings.dark") }}</button>
          <button
            data-test="theme-light"
            class="rounded-sm px-3 py-1 text-sm [@media(pointer:coarse)]:min-h-11"
            :class="theme.mode === 'light' ? 'bg-accent-soft text-accent-text' : 'text-fg-muted hover:bg-fg/5'"
            @click="theme.set('light')"
          >{{ $t("settings.light") }}</button>
        </div>
      </section>

      <section data-test="language-setting" class="flex min-h-11 flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.language") }}</h2>
        <div class="inline-flex gap-1 rounded-btn bg-bg p-1">
          <button
            v-for="loc in SUPPORTED_LOCALES"
            :key="loc"
            :data-test="`lang-${loc}`"
            class="rounded-sm px-3 py-1 text-sm [@media(pointer:coarse)]:min-h-11"
            :class="locale.locale === loc ? 'bg-accent-soft text-accent-text' : 'text-fg-muted hover:bg-fg/5'"
            @click="locale.set(loc)"
          >{{ localeLabels[loc] }}</button>
        </div>
      </section>

      <section class="flex min-h-11 items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.addInstance") }}</h2>
        <UiButton data-test="open-add-instance" @click="showAddInstance = true">
          {{ $t("settings.addInstance") }}
        </UiButton>
      </section>

      <section class="flex min-h-11 items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.retentionTitle") }}</h2>
        <div class="flex items-center gap-1.5">
          <p class="text-right text-sm text-fg-muted" data-test="retention-body">
            {{ $t("settings.retentionShort", { max: retention?.maxPerSession ?? "—", days: retention?.days ?? "—" }) }}
          </p>
          <Tooltip :text="$t('settings.retentionBody', { max: retention?.maxPerSession ?? '—', days: retention?.days ?? '—' })">
            <button type="button" data-test="retention-info" :aria-label="$t('settings.moreInfo')" :title="$t('settings.moreInfo')"
                    class="shrink-0 rounded-sm p-1 leading-[0] text-fg-muted hover:bg-fg/5 hover:text-fg [&_svg]:block [@media(pointer:coarse)]:grid [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:place-items-center [@media(pointer:coarse)]:p-0">
              <Info :size="14" />
            </button>
          </Tooltip>
        </div>
      </section>

      <section class="flex min-h-11 items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.relayTitle") }}</h2>
        <div class="text-right">
          <p class="text-sm text-fg-muted" data-test="relay-version">
            {{ $t("settings.relayVersion", { version: relay?.current ?? "—" }) }}
          </p>
          <p v-if="relay?.latest && relay.updateAvailable" class="text-xs text-accent-text" data-test="relay-update">
            {{ $t("settings.relayUpdateAvailable", { latest: relay?.latest }) }}
          </p>
        </div>
      </section>

      <section data-test="notif-setting" class="flex min-h-11 items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.notifTitle") }}</h2>
        <div class="flex items-center gap-1.5">
          <span data-test="notif-state" class="text-sm text-fg-muted">{{ notifStateLabel }}</span>
          <UiButton
            v-if="notifState === 'subscribed' || notifState === 'idle' || notifState === 'server-disabled'"
            data-test="notif-toggle"
            :disabled="notifBusy"
            @click="toggleNotifications"
          >{{ notifState === "subscribed" ? $t("settings.notifDisable") : $t("settings.notifEnable") }}</UiButton>
          <Tooltip v-if="notifHint" :text="notifHint">
            <button type="button" data-test="notif-info" :aria-label="$t('settings.moreInfo')" :title="$t('settings.moreInfo')"
                    class="shrink-0 rounded-sm p-1 leading-[0] text-fg-muted hover:bg-fg/5 hover:text-fg [&_svg]:block [@media(pointer:coarse)]:grid [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:place-items-center [@media(pointer:coarse)]:p-0">
              <Info :size="14" />
            </button>
          </Tooltip>
        </div>
      </section>

      <section class="flex min-h-11 items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.account") }}</h2>
        <UiButton variant="danger-ghost" data-test="logout" @click="onLogout">
          <LogOut :size="15" />{{ $t("settings.signOut") }}
        </UiButton>
      </section>
    </div>

    <AddInstanceDialog v-if="showAddInstance" @close="showAddInstance = false" />
  </div>
</template>
