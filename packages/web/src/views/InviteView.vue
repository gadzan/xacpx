<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Check, Copy, TriangleAlert } from "lucide-vue-next";
import { ApiError, api } from "../api/client";
import { useAuthStore } from "../stores/auth";
import BrandLogo from "../components/BrandLogo.vue";

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

/** The one primary action on this page: the same sheen + button shadow recipe as
 *  UiButton's primary, written out because these CTAs carry their own layout. */
const PRIMARY =
  "flex w-full items-center justify-center gap-2 rounded-btn bg-accent bg-[linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0))] px-3 py-2 text-sm font-medium text-on-accent shadow-btn transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";
</script>

<template>
  <!-- One centred precision card, the same family as LoginView: no fake window
       chrome, no terminal cosplay. The invite code is still monospace because it
       IS a code — that is the only thing that stays machine-typed. -->
  <div class="relative flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4">
    <div aria-hidden="true" class="invite-glow"></div>

    <div
      data-test="invite-window"
      class="relative w-[24rem] max-w-full overflow-hidden rounded-card bg-surface p-6 shadow-card ring-1 ring-hairline-strong"
    >
      <div class="mb-4 flex items-center gap-2">
        <BrandLogo />
      </div>

      <!-- error state -->
      <template v-if="state === 'error'">
        <p data-test="invite-error" role="alert" class="flex items-start gap-2 rounded-lg border border-hairline bg-danger/[0.07] px-3 py-2 text-sm text-danger-text">
          <TriangleAlert :size="15" class="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{{ $t(errorKey) }}</span>
        </p>
        <RouterLink
          to="/login"
          data-test="back-to-login"
          class="mt-4 inline-block text-xs font-medium text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline"
        >{{ $t("invite.backToLogin") }}</RouterLink>
      </template>

      <!-- success state: show the token exactly once -->
      <template v-else-if="state === 'success'">
        <p class="text-sm font-semibold tracking-tight text-fg">{{ username }}</p>
        <p aria-hidden="true" class="mb-1.5 mt-4 text-xs font-medium text-fg-muted">{{ $t("invite.tokenLabel") }}</p>
        <div class="flex items-center gap-1.5">
          <code
            data-test="invite-token"
            class="min-w-0 flex-1 select-all break-all rounded-input ui-well px-3 py-2 font-mono text-ui tracking-[0.03em] text-fg"
          >{{ token }}</code>
          <button
            type="button"
            data-test="copy-token"
            :title="$t('invite.copyToken')"
            :aria-label="$t('invite.copyToken')"
            class="grid h-8 w-8 shrink-0 place-items-center rounded-btn border border-hairline bg-raised/75 shadow-btn-raised transition-colors hover:bg-raised dark:bg-white/[0.06] dark:hover:bg-white/[0.11]"
            :class="copied ? 'text-run' : 'text-fg-muted hover:text-fg'"
            @click="copyToken"
          >
            <Check v-if="copied" :size="15" aria-hidden="true" />
            <Copy v-else :size="15" aria-hidden="true" />
          </button>
        </div>
        <p data-test="not-shown-again" class="mt-3 flex items-start gap-1.5 text-xs font-medium text-warn">
          <TriangleAlert :size="13" class="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{{ $t("invite.notShownAgain") }}</span>
        </p>
        <p class="mt-2 text-xs leading-relaxed text-fg-muted">{{ $t("invite.connectorHint") }}</p>

        <p v-if="auth.error" data-test="signin-error" role="alert" class="mt-3 flex items-start gap-1.5 text-xs text-danger-text">
          <TriangleAlert :size="13" class="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{{ auth.error }}</span>
        </p>

        <button
          type="button"
          data-test="signin"
          :disabled="signingIn"
          :class="PRIMARY"
          class="mt-5"
          @click="signIn"
        >{{ $t("invite.signIn") }}</button>
      </template>

      <!-- idle / pending state -->
      <template v-else>
        <p class="text-sm font-semibold tracking-tight text-fg">{{ $t("invite.heading") }}</p>
        <p class="mt-1.5 text-xs leading-relaxed text-fg-muted">{{ $t("invite.explainer") }}</p>
        <button
          type="button"
          data-test="redeem"
          :disabled="state === 'pending'"
          :class="PRIMARY"
          class="mt-5"
          @click="redeem"
        >{{ state === "pending" ? $t("invite.redeeming") : $t("invite.redeem") }}</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* One soft brand wash behind the card. No grid, no fake terminal: the card is the
   subject, so the backdrop only has to keep the card from floating on flat grey. */
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
</style>
