<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAuthStore } from "../stores/auth";
import { useRuntimeStore } from "../stores/runtime";
import { forgetToken, readRememberedToken, rememberToken } from "../lib/login-token";

const auth = useAuthStore();
const runtime = useRuntimeStore();
const localMode = computed(() => runtime.loaded && runtime.config.hostMode === "local");
const router = useRouter();
const { t, te } = useI18n();
const token = ref(readRememberedToken());
const remember = ref(token.value !== "");
watch(remember, (on) => { if (!on) forgetToken(); });
const pending = ref(false);
const revealed = ref(false);
const copied = ref(false);

// The CLI command that mints an access token on the host. Literal (not localized)
// because it is a command the user types verbatim.
const ADD_TOKEN_CMD = "xacpx-relay add token";

// The store records an error CODE (an ApiError code, or "request-failed" when
// the request never produced one). Translate the code; fall back to the generic
// message when the server sends one we have no string for.
const errorText = computed(() => {
  const code = auth.error;
  if (!code) return "";
  if (localMode.value && code === "invalid-token") return t("login.localInvalid");
  const key = `login.errors.${code}`;
  return te(key) ? t(key) : t("login.errors.fallback");
});

async function submit() {
  if (pending.value) return;
  pending.value = true;
  try {
    if (!(await auth.login(token.value))) return;
    if (remember.value) rememberToken(token.value);
    router.replace("/");
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

    <div class="relative flex w-[23rem] max-w-full flex-col items-center">
      <!-- Brand lockup: the gradient mark is the product's identity, so it is the one
           saturated element on the page. Everything below stays neutral. -->
      <div class="mb-6 flex flex-col items-center gap-2.5">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="loginBrandX" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
              <stop style="stop-color: rgb(var(--c-accent))" />
              <stop offset=".55" style="stop-color: rgb(var(--c-info))" />
              <stop offset="1" style="stop-color: rgb(var(--c-run-bright))" />
            </linearGradient>
          </defs>
          <path d="M5.5 5.5 L18.5 18.5 M18.5 5.5 L5.5 18.5" stroke="url(#loginBrandX)" stroke-width="4" stroke-linecap="round" />
        </svg>
        <div class="flex flex-col items-center gap-1.5">
          <h1 class="text-base font-semibold tracking-tight text-fg">{{ localMode ? $t("login.localTitle") : "xacpx relay" }}</h1>
          <p class="text-xs text-fg-muted">{{ localMode ? $t("login.localSubtitle") : $t("login.subtitle") }}</p>
        </div>
      </div>

      <form
        data-test="login-window"
        class="relative w-full rounded-card bg-surface p-6 shadow-card ring-1 ring-hairline-strong"
        @submit.prevent="submit"
      >
        <!-- Setup hint: what to do on the host, with the command it names. -->
        <div v-if="!localMode" class="mb-5 rounded-input bg-surface-2 p-3">
          <p class="mb-2 text-xs font-medium text-fg">{{ $t("login.setupHeading") }}</p>
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{{ ADD_TOKEN_CMD }}</code>
            <button
              type="button"
              data-test="copy-command"
              :title="$t('login.copyCommand')"
              :aria-label="$t('login.copyCommand')"
              class="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              @click="copyCommand"
            >
              <svg v-if="!copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </button>
          </div>
          <p id="login-hint" class="mt-2 text-xs leading-relaxed text-fg-muted">{{ $t("login.runHint") }}</p>
        </div>
        <p v-else id="login-hint" class="mb-5 text-xs leading-relaxed text-fg-muted">{{ $t("login.localRunHint") }}</p>

        <label for="access-token" class="mb-2 block text-xs font-medium text-fg">{{ $t("login.tokenLabel") }}</label>

        <!-- token input -->
        <div class="relative">
          <input
            id="access-token"
            v-model="token"
            data-test="token-input"
            :type="revealed ? 'text' : 'password'"
            :placeholder="$t('login.tokenPlaceholder')"
            aria-describedby="login-hint"
            autocomplete="off"
            :disabled="pending"
            class="w-full rounded-input bg-bg py-2.5 pl-3 pr-11 font-mono text-sm tracking-[0.05em] text-fg ring-1 ring-hairline placeholder:font-sans placeholder:tracking-normal placeholder:text-fg-muted transition-shadow focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          />
          <button
            type="button"
            data-test="toggle-visibility"
            :title="$t('login.toggleVisibility')"
            :aria-label="$t('login.toggleVisibility')"
            :aria-pressed="revealed"
            class="absolute right-1 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-sm text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            @click="revealed = !revealed"
          >
            <svg v-if="!revealed" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9.9 4.2A11 11 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-1.7 2.7M6.6 6.6A13 13 0 0 0 2 11s3.5 7 10 7a11 11 0 0 0 3.4-.5M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" />
            </svg>
          </button>
        </div>

        <label class="mt-3 flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
          <input
            v-model="remember"
            data-test="remember-token"
            type="checkbox"
            class="accent-accent"
            :disabled="pending"
          />
          {{ $t("login.remember") }}
        </label>

        <!-- error -->
        <p v-if="auth.error" data-test="login-error" role="alert" class="mt-3 flex items-start gap-1.5 rounded-input bg-danger/10 px-2.5 py-2 text-xs leading-relaxed text-danger-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="mt-0.5 shrink-0" aria-hidden="true">
            <circle cx="12" cy="12" r="10" /><path d="M12 7v6M12 17h.01" />
          </svg>
          <span>{{ errorText }}</span>
        </p>

        <button
          type="submit"
          data-test="signin"
          :disabled="pending"
          class="mt-5 flex w-full items-center justify-center gap-2 rounded-input bg-accent px-3 py-2.5 text-sm font-semibold text-on-accent shadow-press transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50"
        >
          <svg v-if="pending" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" class="animate-spin" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.2-8.6" />
          </svg>
          <span>{{ pending ? $t("login.signingIn") : $t("login.signIn") }}</span>
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-glow {
  position: absolute;
  width: 32rem;
  height: 26rem;
  border-radius: 9999px;
  filter: blur(90px);
  opacity: 0.08;
  pointer-events: none;
  background:
    radial-gradient(circle at 35% 35%, #4f9bf5, transparent 60%),
    radial-gradient(circle at 65% 65%, #69d689, transparent 60%);
}
.login-grid {
  position: absolute;
  inset: 0;
  opacity: 0.225;
  pointer-events: none;
  background-image:
    linear-gradient(rgb(128 140 160 / 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgb(128 140 160 / 0.05) 1px, transparent 1px);
  background-size: 30px 30px;
  -webkit-mask-image: radial-gradient(circle at center, #000 25%, transparent 72%);
  mask-image: radial-gradient(circle at center, #000 25%, transparent 72%);
}
/* Focus rings come from the global 2px solid accent rule in style.css; the
   login surface no longer overrides them now that the primary action is
   accent-filled rather than green. */
</style>
