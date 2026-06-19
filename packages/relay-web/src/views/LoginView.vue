<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import BrandLogo from "../components/BrandLogo.vue";

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
  <div class="flex h-screen items-center justify-center bg-bg">
    <form class="w-80 space-y-3 rounded-lg border border-border bg-surface p-6 shadow-xl" @submit.prevent="submit">
      <div class="mb-2 flex justify-center">
        <BrandLogo />
      </div>
      <label for="access-token" class="sr-only">{{ $t("login.tokenLabel") }}</label>
      <input id="access-token" v-model="token" type="password" autocomplete="off" aria-describedby="token-hint"
             class="w-full rounded border border-border bg-bg px-3 py-2 text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
             :placeholder="$t('login.tokenPlaceholder')" :disabled="pending" />
      <p id="token-hint" class="text-sm text-fg-muted">{{ $t("login.hintBefore") }}<code>xacpx-relay user new</code>{{ $t("login.hintAfter") }}</p>
      <p v-if="auth.error" class="text-sm text-danger">{{ auth.error }}</p>
      <button class="w-full rounded bg-accent px-3 py-2 text-white hover:bg-accent-hover disabled:opacity-50" type="submit" :disabled="pending">
        {{ pending ? $t("login.signingIn") : $t("login.signIn") }}
      </button>
    </form>
  </div>
</template>
