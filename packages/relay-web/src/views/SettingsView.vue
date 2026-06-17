<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api/client";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
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
</script>

<template>
  <div class="mx-auto max-w-2xl p-6">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-lg font-semibold">Settings</h1>
      <router-link to="/" class="text-sm text-slate-500 hover:underline">← Back</router-link>
    </header>

    <section class="mb-8">
      <h2 class="mb-2 text-sm font-semibold uppercase text-slate-500">Add an instance</h2>
      <div class="flex gap-2">
        <input v-model="pairingName" placeholder="instance name (optional)" class="flex-1 rounded border px-2 py-1 text-sm" />
        <button data-test="gen-pairing" class="rounded bg-slate-700 px-3 py-1 text-sm text-white" @click="genPairing">Generate token</button>
      </div>
      <div v-if="pairing" class="mt-2 rounded bg-slate-100 p-2 text-xs">
        <div>Run on the xacpx host:</div>
        <code class="block break-all">xacpx channel add relay --url &lt;this-relay-ws-url&gt; --token {{ pairing }}</code>
      </div>
    </section>

    <section>
      <h2 class="mb-2 text-sm font-semibold uppercase text-slate-500">History retention</h2>
      <p class="text-sm text-slate-600">
        Keeps the newest <strong>{{ retention?.maxPerSession ?? "—" }}</strong> messages per session,
        for up to <strong>{{ retention?.days ?? "—" }}</strong> days. Configured server-side.
      </p>
    </section>
  </div>
</template>
