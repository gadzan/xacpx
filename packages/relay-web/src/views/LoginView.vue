<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const router = useRouter();
const token = ref("");
const pending = ref(false);

async function submit() {
  if (pending.value) return;
  pending.value = true;
  try {
    if (await auth.login(token.value)) router.replace("/");
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flex h-screen items-center justify-center bg-slate-100">
    <form class="w-80 space-y-3 rounded-lg bg-white p-6 shadow" @submit.prevent="submit">
      <h1 class="text-lg font-semibold">xacpx relay</h1>
      <label for="access-token" class="sr-only">Access token</label>
      <input id="access-token" v-model="token" type="password" autocomplete="off" aria-describedby="token-hint"
             class="w-full rounded border px-3 py-2 disabled:opacity-50" placeholder="Access token" :disabled="pending" />
      <p id="token-hint" class="text-sm text-slate-500">Paste the access token from <code>xacpx-relay user new</code>.</p>
      <p v-if="auth.error" class="text-sm text-red-600">{{ auth.error }}</p>
      <button class="w-full rounded bg-slate-800 px-3 py-2 text-white disabled:opacity-50" type="submit" :disabled="pending">
        {{ pending ? "Signing in…" : "Sign in" }}
      </button>
    </form>
  </div>
</template>
