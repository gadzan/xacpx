<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api/client";
import { useAuthStore } from "../stores/auth";
import { useThemeStore } from "../stores/theme";

const auth = useAuthStore();
const theme = useThemeStore();
const retention = ref<{ days: number; maxPerSession: number } | null>(null);
const invite = ref("");
const pairing = ref("");
const pairingName = ref("");

onMounted(async () => {
  try {
    const cfg = await api.get<{ historyRetention: { days: number; maxPerSession: number } }>("/api/config");
    retention.value = cfg.historyRetention;
  } catch { /* leave null; UI shows a dash */ }
});

async function genInvite() {
  const r = await api.post<{ invite: string }>("/api/invites");
  invite.value = r.invite;
}

async function genPairing() {
  const r = await api.post<{ token: string }>("/api/instances/pairing-token", { name: pairingName.value });
  pairing.value = r.token;
}
</script>

<template>
  <div class="mx-auto max-w-2xl p-6">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-lg font-semibold text-fg">Settings</h1>
      <router-link to="/" class="text-sm text-fg-muted hover:underline">← Back</router-link>
    </header>

    <section data-test="theme-setting" class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">Appearance</h2>
      <div class="inline-flex gap-1 rounded-lg border border-border bg-bg p-1">
        <button
          data-test="theme-dark"
          class="rounded-md px-3 py-1 text-sm"
          :class="theme.mode === 'dark' ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-fg/5'"
          @click="theme.set('dark')"
        >Dark</button>
        <button
          data-test="theme-light"
          class="rounded-md px-3 py-1 text-sm"
          :class="theme.mode === 'light' ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-fg/5'"
          @click="theme.set('light')"
        >Light</button>
      </div>
    </section>

    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">Add an instance</h2>
      <div class="flex gap-2">
        <input v-model="pairingName" placeholder="instance name (optional)" class="flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <button data-test="gen-pairing" class="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover" @click="genPairing">Generate token</button>
      </div>
      <div v-if="pairing" class="mt-2 rounded bg-bg border border-border p-2 text-xs text-fg">
        <div>Run on the xacpx host:</div>
        <code class="block break-all">xacpx channel add relay --url &lt;this-relay-ws-url&gt; --token {{ pairing }}</code>
      </div>
    </section>

    <section v-if="auth.account?.role === 'admin'" data-test="invite-section" class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">Invite an account</h2>
      <button data-test="gen-invite" class="rounded bg-accent px-3 py-1 text-sm text-white hover:bg-accent-hover" @click="genInvite">Generate invite</button>
      <div v-if="invite" class="mt-2 rounded bg-bg border border-border p-2 text-xs text-fg break-all">Invite token: <code>{{ invite }}</code></div>
    </section>

    <section>
      <h2 class="mb-2 text-sm font-semibold uppercase text-fg-muted">History retention</h2>
      <p class="text-sm text-fg-muted">
        Keeps the newest <strong class="text-fg">{{ retention?.maxPerSession ?? "—" }}</strong> messages per session,
        for up to <strong class="text-fg">{{ retention?.days ?? "—" }}</strong> days. Configured server-side.
      </p>
    </section>
  </div>
</template>
