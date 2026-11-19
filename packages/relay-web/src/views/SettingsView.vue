<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowLeft, Info, LogOut, Plus } from "lucide-vue-next";
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
import UiButton from "../components/UiButton.vue";
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
    // The off path is "the switch is visibly on". App intent written without a
    // granted permission still reads Off, so that tap must ask again rather than
    // silently disable a preference the user never saw enabled.
    if (notifSwitchOn.value) {
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

// A switch means "this preference is on". It is on only when BOTH the browser
// permission is granted and the app intent is enabled — an app flag alone must
// never paint a success the browser will not honour.
const notifSwitchOn = computed(() =>
  notifState.value === "subscribed"
  && typeof Notification !== "undefined"
  && Notification.permission === "granted",
);
/** Unsupported has no switch at all; server-disabled cannot be turned on. */
const notifSwitchShown = computed(() => notifState.value !== "unsupported");

const notifStateLabel = computed(() => ({
  unsupported: t("settings.notifUnsupported"),
  "server-disabled": t("settings.notifServerDisabled"),
  denied: t("settings.notifDenied"),
  idle: t("settings.notifOff"),
  subscribed: notifSwitchOn.value ? t("settings.notifOn") : t("settings.notifOff"),
}[notifState.value]));

/** The explanations that used to stack under the notification row, now behind one ⓘ. */
const notifHint = computed(() => {
  const parts: string[] = [];
  if (notifState.value === "denied") parts.push(t("settings.notifDeniedHint"));
  if (isIos) parts.push(t("settings.notifIosHint"));
  return parts.join(" ");
});

/** Switch activation. Off means "stop app notifications" — never claim the
 *  browser permission was revoked. On runs inside this click, so the permission
 *  prompt is user-gesture initiated. A denied permission is re-probed first: the
 *  user may have unblocked the site in browser settings since the last read. */
async function onNotifSwitch(): Promise<void> {
  if (notifBusy.value) return;
  if (notifState.value === "unsupported" || notifState.value === "server-disabled") return;
  if (notifState.value === "denied") {
    await probeNotifications();
    if (notifState.value === "denied" || notifState.value === "unsupported") return;
    // The permission now grants what the switch was missing, so this tap already
    // means "on"; falling through would run the off branch and undo the preference.
    if (notifSwitchOn.value) return;
  }
  await toggleNotifications();
}

// Browser permission can change outside this page (site settings, OS prompt in
// another tab). Re-probe on that change so a denied row recovers without a reload.
let permissionStatus: PermissionStatus | null = null;
function onPermissionChange(): void { void probeNotifications(); }

void onMounted(async () => {
  await probeNotifications();
  try {
    permissionStatus = (await navigator.permissions?.query({ name: "notifications" })) ?? null;
    permissionStatus?.addEventListener("change", onPermissionChange);
  } catch { /* older browsers: no query support, no live re-probe */ }
});
onBeforeUnmount(() => {
  permissionStatus?.removeEventListener("change", onPermissionChange);
  permissionStatus = null;
});
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
      <!-- Segmented control: a 32px rail whose selected pill is 28px (2px inset,
           same arithmetic as the sidebar track). On a coarse pointer the button
           grows to a 44px hit box, but the paint stays on the 28px pill — the
           44 never gets a background and never covers the neighbouring row. -->
      <section data-test="theme-setting" class="flex min-h-11 flex-wrap items-center justify-between gap-3 px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.appearance") }}</h2>
        <div class="inline-flex h-8 items-center gap-0.5 rounded-btn bg-bg p-0.5">
          <button
            data-test="theme-dark"
            class="group flex h-7 items-center justify-center rounded-sm text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
            :aria-pressed="theme.mode === 'dark'"
            @click="theme.set('dark')"
          >
            <span class="grid h-7 place-items-center rounded-sm px-3"
                  :class="theme.mode === 'dark' ? 'bg-accent-soft text-accent-text' : 'text-fg-muted group-hover:bg-fg/5'">{{ $t("settings.dark") }}</span>
          </button>
          <button
            data-test="theme-light"
            class="group flex h-7 items-center justify-center rounded-sm text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
            :aria-pressed="theme.mode === 'light'"
            @click="theme.set('light')"
          >
            <span class="grid h-7 place-items-center rounded-sm px-3"
                  :class="theme.mode === 'light' ? 'bg-accent-soft text-accent-text' : 'text-fg-muted group-hover:bg-fg/5'">{{ $t("settings.light") }}</span>
          </button>
        </div>
      </section>

      <section data-test="language-setting" class="flex min-h-11 flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.language") }}</h2>
        <div class="inline-flex h-8 items-center gap-0.5 rounded-btn bg-bg p-0.5">
          <button
            v-for="loc in SUPPORTED_LOCALES"
            :key="loc"
            :data-test="`lang-${loc}`"
            class="group flex h-7 items-center justify-center rounded-sm text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
            :aria-pressed="locale.locale === loc"
            @click="locale.set(loc)"
          >
            <span class="grid h-7 place-items-center rounded-sm px-3"
                  :class="locale.locale === loc ? 'bg-accent-soft text-accent-text' : 'text-fg-muted group-hover:bg-fg/5'">{{ localeLabels[loc] }}</span>
          </button>
        </div>
      </section>

      <section class="flex min-h-11 items-center justify-between gap-3 border-t border-hairline px-4 py-2">
        <h2 class="text-sm font-medium text-fg">{{ $t("settings.addInstance") }}</h2>
        <!-- Light text action: the 44px target is transport, not paint. -->
        <button type="button" data-test="open-add-instance"
                class="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-sm px-2 text-sm font-medium text-accent-text transition-colors hover:bg-accent-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                @click="showAddInstance = true">
          <Plus :size="14" class="shrink-0" />
          {{ $t("settings.addInstance") }}
        </button>
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
          <!-- The state text carries the honesty: Off/On is the app preference,
               Denied/Unsupported explain why a tap cannot turn it on. Turning the
               switch off stops app notifications and never claims the browser
               permission was revoked. -->
          <span data-test="notif-state" class="text-sm text-fg-muted">{{ notifStateLabel }}</span>
          <button
            v-if="notifSwitchShown"
            type="button"
            role="switch"
            data-test="notif-toggle"
            :aria-checked="notifSwitchOn"
            :aria-label="$t('settings.notifTitle')"
            :aria-busy="notifBusy"
            :disabled="notifBusy || notifState === 'server-disabled'"
            class="relative grid h-11 w-11 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed"
            @click="onNotifSwitch"
          >
            <!-- 44x26 visual inside a 44x44 transparent hit disc. -->
            <span class="relative block h-[26px] w-[44px] rounded-full transition-colors duration-150 ease-ui motion-reduce:transition-none"
                  :class="[notifSwitchOn ? 'bg-accent' : 'bg-fill-track', notifBusy || notifState === 'denied' ? 'opacity-60' : '']">
              <span class="absolute top-[3px] block h-5 w-5 rounded-full bg-raised shadow-press transition-[left] duration-150 ease-ui motion-reduce:transition-none"
                    :class="notifSwitchOn ? 'left-[21px]' : 'left-[3px]'" />
            </span>
          </button>
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
