<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const router = useRouter();
const token = ref("");
const pending = ref(false);
const revealed = ref(false);
const copied = ref(false);

// The CLI command that mints an access token on the host. Literal (not localized)
// because it is a command the user types verbatim.
const ADD_TOKEN_CMD = "xacpx-relay add token";

async function submit() {
  if (pending.value) return;
  pending.value = true;
  try {
    if (await auth.login(token.value)) router.replace("/");
  } finally {
    pending.value = false;
  }
}

async function copyCommand() {
  try {
    await navigator.clipboard?.writeText(ADD_TOKEN_CMD);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1200);
  } catch {
    // Clipboard unavailable (insecure context / permissions) — non-fatal.
  }
}
</script>

<template>
  <div class="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4">
    <!-- ambient depth: a faint brand glow + a vignetted grid, purely decorative -->
    <div aria-hidden="true" class="login-glow"></div>
    <div aria-hidden="true" class="login-grid"></div>

    <form
      data-test="login-window"
      class="relative w-[22rem] max-w-full overflow-hidden rounded-2xl border border-border bg-surface font-mono shadow-e3"
      @submit.prevent="submit"
    >
      <!-- window chrome -->
      <div class="relative flex items-center border-b border-border bg-raised px-3.5 py-2.5">
        <div aria-hidden="true" class="flex gap-[7px]">
          <span class="h-[11px] w-[11px] rounded-full opacity-90" style="background:#ff5f56"></span>
          <span class="h-[11px] w-[11px] rounded-full opacity-90" style="background:#ffbd2e"></span>
          <span class="h-[11px] w-[11px] rounded-full opacity-90" style="background:#27c93f"></span>
        </div>
        <div class="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5 text-xs text-fg-muted">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="loginBrandX" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
                <stop stop-color="#4F9BF5" />
                <stop offset="1" stop-color="#69D689" />
              </linearGradient>
            </defs>
            <path d="M5 5 L19 19 M19 5 L5 19" stroke="url(#loginBrandX)" stroke-width="3.4" stroke-linecap="round" />
          </svg>
          xacpx-relay — {{ $t("login.window") }}
        </div>
      </div>

      <!-- body -->
      <div class="px-4 pb-5 pt-4">
        <!-- command hint + copy -->
        <div class="flex items-center gap-2">
          <p class="flex-1 text-[12.5px] text-fg"><span class="select-none text-run">$</span> {{ ADD_TOKEN_CMD }}</p>
          <button
            type="button"
            data-test="copy-command"
            :title="$t('login.copyCommand')"
            :aria-label="$t('login.copyCommand')"
            class="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-bg"
            :class="copied ? 'text-run' : 'text-fg-muted hover:text-fg'"
            @click="copyCommand"
          >
            <svg v-if="!copied" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
        </div>
        <p id="login-hint" class="mb-5 mt-1 text-[11.5px] leading-relaxed text-fg-muted">{{ $t("login.runHint") }}</p>

        <!-- prompt label -->
        <div aria-hidden="true" class="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
          <span class="text-run">▸</span> access-token
        </div>

        <!-- token input -->
        <div class="relative">
          <input
            id="access-token"
            v-model="token"
            data-test="token-input"
            :type="revealed ? 'text' : 'password'"
            :placeholder="$t('login.tokenPlaceholder')"
            :aria-label="$t('login.tokenLabel')"
            aria-describedby="login-hint"
            autocomplete="off"
            :disabled="pending"
            class="login-input w-full rounded-lg border border-border bg-bg py-2.5 pl-3 pr-10 text-sm tracking-[0.05em] text-fg placeholder:tracking-normal placeholder:text-fg-muted disabled:opacity-50"
          />
          <button
            type="button"
            data-test="toggle-visibility"
            :title="$t('login.toggleVisibility')"
            :aria-label="$t('login.toggleVisibility')"
            :aria-pressed="revealed"
            class="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface hover:text-fg"
            @click="revealed = !revealed"
          >
            <svg v-if="!revealed" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9.9 4.2A11 11 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6A13 13 0 0 0 2 11s3.5 7 10 7a11 11 0 0 0 3.4-.5M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </svg>
          </button>
        </div>

        <!-- error -->
        <p v-if="auth.error" data-test="login-error" role="alert" class="mt-3 flex items-start gap-1.5 text-xs text-danger">
          <span class="font-bold">!</span><span>{{ auth.error }}</span>
        </p>

        <!-- submit: bracketed-prompt primary action -->
        <button
          type="submit"
          data-test="signin"
          :disabled="pending"
          class="login-btn group mt-5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-semibold text-fg transition-colors hover:bg-run/10 hover:text-run disabled:cursor-default disabled:text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted"
        >
          <span class="login-arrow group-hover:translate-x-0.5" :class="pending ? 'text-fg-muted' : 'text-run'">▸</span>
          <span>{{ pending ? $t("login.signingIn") : $t("login.signIn") }}</span>
          <span v-if="!pending" class="ml-auto text-[11px] text-fg-muted">⏎ enter</span>
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.login-glow {
  position: absolute;
  width: 32rem;
  height: 26rem;
  border-radius: 9999px;
  filter: blur(90px);
  opacity: 0.16;
  pointer-events: none;
  background:
    radial-gradient(circle at 35% 35%, #4f9bf5, transparent 60%),
    radial-gradient(circle at 65% 65%, #69d689, transparent 60%);
}
.login-grid {
  position: absolute;
  inset: 0;
  opacity: 0.45;
  pointer-events: none;
  background-image:
    linear-gradient(rgb(128 140 160 / 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgb(128 140 160 / 0.05) 1px, transparent 1px);
  background-size: 30px 30px;
  -webkit-mask-image: radial-gradient(circle at center, #000 25%, transparent 72%);
  mask-image: radial-gradient(circle at center, #000 25%, transparent 72%);
}
/* Green (run) focus ring for the login surface, overriding the global accent ring. */
.login-input:focus-visible,
.login-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--c-surface)), 0 0 0 4px rgb(var(--c-run));
}
.login-input:focus-visible {
  border-color: transparent;
}
.login-arrow {
  transition: transform 0.12s ease;
}
@media (prefers-reduced-motion: reduce) {
  .login-arrow {
    transition: none;
  }
}
</style>
