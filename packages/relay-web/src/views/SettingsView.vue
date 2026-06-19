<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { LogOut } from "lucide-vue-next";
import { api } from "../api/client";
import { useAuthStore } from "../stores/auth";
import { useThemeStore } from "../stores/theme";
import { confirm } from "../lib/use-confirm";
import { useLocaleStore } from "../stores/locale";
import { SUPPORTED_LOCALES } from "../i18n";
import { useI18n } from "vue-i18n";

const auth = useAuthStore();
const theme = useThemeStore();
const router = useRouter();
const locale = useLocaleStore();
const { t } = useI18n();
const localeLabels: Record<string, string> = { en: "English", "zh-CN": "中文" };
const retention = ref<{ days: number; maxPerSession: number } | null>(null);
const pairing = ref("");
const pairingName = ref("");

onMounted(async () => {
  try {
    const cfg = await api.get<{ historyRetention: { days: number; maxPerSession: number } }>("/api/config");
    retention.value = cfg.historyRetention;
  } catch { /* leave null; UI shows a dash */ }
});

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
</script>

<template>
  <div class="mx-auto max-w-2xl p-6">
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

    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">{{ $t("settings.retentionTitle") }}</h2>
      <p class="text-sm text-fg-muted" data-test="retention-body">
        {{ $t("settings.retentionBody", { max: retention?.maxPerSession ?? "—", days: retention?.days ?? "—" }) }}
      </p>
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
