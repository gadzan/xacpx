<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ApiError, api } from "../api/client";
import { useAuthStore } from "../stores/auth";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const code = typeof route.params.code === "string" ? route.params.code : "";

type State = "idle" | "pending" | "success" | "error";
const state = ref<State>(code ? "idle" : "error");
const errorKey = ref(code ? "" : "invite.errorInvalid");
const token = ref("");
const username = ref("");
const copied = ref(false);
const signingIn = ref(false);

// Redeem strictly on click — never on mount: link previews and crawlers
// fetching the URL must not burn the single-use code.
async function redeem() {
  if (state.value === "pending") return;
  state.value = "pending";
  try {
    const res = await api.post<{ token: string; username: string }>("/api/invites/redeem", { code });
    token.value = res.token;
    username.value = res.username;
    state.value = "success";
  } catch (e) {
    errorKey.value =
      e instanceof ApiError && e.code === "invalid-code" ? "invite.errorInvalid"
      : e instanceof ApiError && e.code === "too-many-attempts" ? "invite.errorRateLimited"
      : "invite.errorGeneric";
    state.value = "error";
  }
}

async function copyToken() {
  try {
    await navigator.clipboard?.writeText(token.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1200);
  } catch {
    // Clipboard unavailable (insecure context / permissions) — non-fatal.
  }
}

async function signIn() {
  if (signingIn.value) return;
  signingIn.value = true;
  try {
    if (await auth.login(token.value)) router.replace("/");
  } finally {
    signingIn.value = false;
  }
}
</script>

<template>
  <div class="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4">
    <div aria-hidden="true" class="invite-glow"></div>
    <div aria-hidden="true" class="invite-grid"></div>

    <div
      data-test="invite-window"
      class="relative w-[24rem] max-w-full overflow-hidden rounded-2xl border border-border bg-surface font-mono shadow-e3"
    >
      <!-- window chrome -->
      <div class="relative flex items-center border-b border-border bg-raised px-3.5 py-2.5">
        <div aria-hidden="true" class="flex gap-[7px]">
          <span class="h-[11px] w-[11px] rounded-full opacity-90" style="background:#ff5f56"></span>
          <span class="h-[11px] w-[11px] rounded-full opacity-90" style="background:#ffbd2e"></span>
          <span class="h-[11px] w-[11px] rounded-full opacity-90" style="background:#27c93f"></span>
        </div>
        <div class="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-1.5 text-xs text-fg-muted">
          xacpx-relay — {{ $t("invite.window") }}
        </div>
      </div>

      <!-- body -->
      <div class="px-4 pb-5 pt-4">
        <!-- error state -->
        <template v-if="state === 'error'">
          <p data-test="invite-error" role="alert" class="flex items-start gap-1.5 text-sm text-danger">
            <span class="font-bold">!</span><span>{{ $t(errorKey) }}</span>
          </p>
          <RouterLink
            to="/login"
            data-test="back-to-login"
            class="mt-4 inline-block text-xs text-fg-muted underline hover:text-fg"
          >{{ $t("invite.backToLogin") }}</RouterLink>
        </template>

        <!-- success state: show the token exactly once -->
        <template v-else-if="state === 'success'">
          <p class="text-sm font-semibold text-fg">{{ username }}</p>
          <div aria-hidden="true" class="mb-2 mt-4 flex items-center gap-1.5 text-xs text-fg-muted">
            <span class="text-run">▸</span> {{ $t("invite.tokenLabel") }}
          </div>
          <div class="flex items-center gap-2">
            <code
              data-test="invite-token"
              class="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-bg px-3 py-2.5 text-[12.5px] tracking-[0.03em] text-fg"
            >{{ token }}</code>
            <button
              type="button"
              data-test="copy-token"
              :title="$t('invite.copyToken')"
              :aria-label="$t('invite.copyToken')"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-bg"
              :class="copied ? 'text-run' : 'text-fg-muted hover:text-fg'"
              @click="copyToken"
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
          <p data-test="not-shown-again" class="mt-3 flex items-start gap-1.5 text-xs font-semibold text-warn">
            <span aria-hidden="true">⚠</span><span>{{ $t("invite.notShownAgain") }}</span>
          </p>
          <p class="mt-2 text-[11.5px] leading-relaxed text-fg-muted">{{ $t("invite.connectorHint") }}</p>

          <p v-if="auth.error" data-test="signin-error" role="alert" class="mt-3 flex items-start gap-1.5 text-xs text-danger">
            <span class="font-bold">!</span><span>{{ auth.error }}</span>
          </p>

          <button
            type="button"
            data-test="signin"
            :disabled="signingIn"
            class="invite-btn group mt-5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-semibold text-fg transition-colors hover:bg-run/10 hover:text-run disabled:cursor-default disabled:text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            @click="signIn"
          >
            <span class="group-hover:translate-x-0.5" :class="signingIn ? 'text-fg-muted' : 'text-run'">▸</span>
            <span>{{ $t("invite.signIn") }}</span>
          </button>
        </template>

        <!-- idle / pending state -->
        <template v-else>
          <p class="text-sm font-semibold text-fg">{{ $t("invite.heading") }}</p>
          <p class="mt-2 text-[11.5px] leading-relaxed text-fg-muted">{{ $t("invite.explainer") }}</p>
          <button
            type="button"
            data-test="redeem"
            :disabled="state === 'pending'"
            class="invite-btn group mt-5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-semibold text-fg transition-colors hover:bg-run/10 hover:text-run disabled:cursor-default disabled:text-fg-muted disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            @click="redeem"
          >
            <span class="group-hover:translate-x-0.5" :class="state === 'pending' ? 'text-fg-muted' : 'text-run'">▸</span>
            <span>{{ state === "pending" ? $t("invite.redeeming") : $t("invite.redeem") }}</span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.invite-glow {
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
.invite-grid {
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
.invite-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px rgb(var(--c-surface)), 0 0 0 4px rgb(var(--c-run));
}
</style>
