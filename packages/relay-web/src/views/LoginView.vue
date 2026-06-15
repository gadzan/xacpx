<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import BrandLogo from "../components/BrandLogo.vue";

const auth = useAuthStore();
const router = useRouter();
const username = ref("");
const password = ref("");

async function submit() {
  if (await auth.login(username.value, password.value)) router.replace("/");
}
</script>

<template>
  <div class="flex h-screen items-center justify-center bg-bg">
    <form class="w-80 space-y-3 rounded-lg border border-border bg-surface p-6 shadow-xl" @submit.prevent="submit">
      <div class="mb-2 flex justify-center">
        <BrandLogo />
      </div>
      <input v-model="username" class="w-full rounded border border-border bg-bg px-3 py-2 text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" placeholder="username" />
      <input v-model="password" type="password" class="w-full rounded border border-border bg-bg px-3 py-2 text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" placeholder="password" />
      <p v-if="auth.error" class="text-sm text-danger">{{ auth.error }}</p>
      <button class="w-full rounded bg-accent px-3 py-2 text-white hover:bg-accent-hover" type="submit">Sign in</button>
    </form>
  </div>
</template>
