<script lang="ts">
const textSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
</script>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BotAvatarConfig, CharacterAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import AgentIcon from "./AgentIcon.vue";
import type { BotAvatarState } from "../lib/bot-avatar-state";
import { avatarClock } from "../lib/bot-avatar/clock";
import { avatarHasLoop, avatarTransition, sampleAvatar, sampleTransition, shouldCelebrate, AVATAR_TRANSITION_SECONDS, type AvatarPointer, type AvatarTransition } from "../lib/bot-avatar/core";
import { bodyPath } from "../lib/bot-avatar/geometry";

const props = withDefaults(defineProps<{
  avatar?: BotAvatarConfig; driver?: string | null; name?: string; size?: number; state?: BotAvatarState;
  static?: boolean; disabled?: boolean; retired?: boolean; activityKey?: string; follow?: boolean; preview?: boolean; observedCompletion?: boolean;
}>(), { size: 24, state: "idle", static: false, disabled: false, retired: false, follow: false, preview: false, observedCompletion: false });
const { t } = useI18n();
const root = ref<HTMLElement>();
const maskId = `bot-avatar-${useId().replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const character = computed(() => props.avatar?.kind === "character" ? props.avatar : undefined);
const state = computed<BotAvatarState>(() => props.retired ? "retired" : props.state);
const label = computed(() => [props.name, t(`bot.avatar.states.${state.value}`)].filter(Boolean).join(" · "));
const text = computed(() => {
  if (props.avatar?.kind !== "text") return "";
  let value = "", count = 0;
  for (const { segment } of textSegmenter.segment(props.avatar.value)) {
    value += segment;
    if (++count === 2) break;
  }
  return value;
});
const reduced = ref(false), visible = ref(false), pageVisible = ref(true);
const pose = shallowRef(character.value ? sampleAvatar({ config: character.value, state: state.value, motion: false }, 0) : undefined);
const radii = computed(() => pose.value?.radii);
const stretchX = computed(() => pose.value?.sx ?? 1), stretchY = computed(() => pose.value?.sy ?? 1);
const channels = computed(() => pose.value?.color);
const path = computed(() => radii.value ? bodyPath(radii.value, stretchX.value, stretchY.value) : "");
const color = computed(() => channels.value ? `rgb(${channels.value.map(Math.round).join(" ")})` : "");
// White eyes on every body except creme, whose near-white body needs ink eyes. Fixed
// colours, independent of the theme: the avatar is the one coloured graphic in the UI.
const eyeFill = computed(() => character.value?.color === "creme" ? "#0A0A0C" : "#FFFFFF");
// The body has no outline, except a faint hairline for the two bodies that would vanish
// into the page: creme on the light theme, encre on the dark one (theme comes from the
// root `.dark` class, see the style block).
const hairline = computed(() => character.value?.color === "creme" || character.value?.color === "encre" ? character.value.color : undefined);
const indicator = computed(() => ({ waiting: "!", failed: "!", indeterminate: "?", offline: "−", retired: "×", cancelled: "−" } as Partial<Record<BotAvatarState, string>>)[state.value]);
let mounted = false, active = true, time = 0;
let initialPreviewCompletion = props.preview && state.value === "completed";
let transition: AvatarTransition | undefined;
let pointer: AvatarPointer | undefined;
let unsubscribe: (() => void) | undefined;
let observer: IntersectionObserver | undefined;
let media: MediaQueryList | undefined;
let listening = false, pointerListening = false;
const resourceEligible = computed(() => !!character.value && !props.static && character.value.motion === "auto"
  && state.value !== "offline" && state.value !== "retired"
  && (!props.disabled || state.value === "working" || state.value === "streaming" || state.value === "waiting"));
const motionAllowed = computed(() => resourceEligible.value && !reduced.value);

function frame(elapsed: number) {
  time += elapsed;
  if (transition) pose.value = sampleTransition(transition, time, pointer);
  if (!transition || (!avatarHasLoop(state.value) && time - transition.start >= AVATAR_TRANSITION_SECONDS)) reconcile();
}
function pointerMove(event: PointerEvent) {
  if (event.pointerType !== "mouse" || !root.value) { pointer = undefined; return; }
  const rect = root.value.getBoundingClientRect();
  pointer = { x: Math.max(-1, Math.min(1, (event.clientX - rect.left - rect.width / 2) / (rect.width / 2))), y: Math.max(-1, Math.min(1, (rect.top + rect.height / 2 - event.clientY) / (rect.height / 2))) };
}
function clearPointer() { pointer = undefined; }
function releasePointer() {
  if (!pointerListening || !root.value) return;
  root.value.removeEventListener("pointermove", pointerMove);
  root.value.removeEventListener("pointerleave", clearPointer);
  root.value.removeEventListener("pointerup", clearPointer);
  root.value.removeEventListener("pointercancel", clearPointer);
  pointerListening = false;
  pointer = undefined;
}
function reconcile() {
  const running = mounted && active && visible.value && pageVisible.value && motionAllowed.value;
  const needsFrames = running && (avatarHasLoop(state.value) || !!transition && time - transition.start < AVATAR_TRANSITION_SECONDS);
  if (needsFrames && !unsubscribe) unsubscribe = avatarClock.subscribe(frame);
  else if (!needsFrames && unsubscribe) { unsubscribe(); unsubscribe = undefined; }
  if (needsFrames && props.follow && !pointerListening && root.value) {
    root.value.addEventListener("pointermove", pointerMove);
    root.value.addEventListener("pointerleave", clearPointer);
    root.value.addEventListener("pointerup", clearPointer);
    root.value.addEventListener("pointercancel", clearPointer);
    pointerListening = true;
  } else if (!needsFrames || !props.follow) releasePointer();
}
function resetPose(celebrate = false) {
  const config: CharacterAvatarConfig | undefined = character.value;
  if (!config) { pose.value = undefined; transition = undefined; reconcile(); return; }
  const target = { config, state: state.value, motion: motionAllowed.value, celebrate };
  if (motionAllowed.value && visible.value && pageVisible.value && pose.value) transition = avatarTransition(pose.value, target, time);
  else {
    pose.value = sampleAvatar({ ...target, motion: false, celebrate: false }, 0);
    transition = motionAllowed.value && avatarHasLoop(state.value) ? avatarTransition(pose.value, { ...target, celebrate: false }, time) : undefined;
  }
  reconcile();
}
function mediaChange() {
  reduced.value = media?.matches ?? false;
  resetPose();
}
function visibilityChange() {
  pageVisible.value = document.visibilityState !== "hidden";
  if (!pageVisible.value) {
    releasePointer();
    if (transition?.target.celebrate) transition = avatarTransition(pose.value!, { ...transition.target, celebrate: false }, time);
  }
  reconcile();
}
function releaseResources() {
  unsubscribe?.(); unsubscribe = undefined;
  observer?.disconnect(); observer = undefined;
  media?.removeEventListener("change", mediaChange); media = undefined;
  if (listening) document.removeEventListener("visibilitychange", visibilityChange);
  listening = false;
  releasePointer();
}
function configureResources() {
  releaseResources();
  if (!mounted || !active || !resourceEligible.value) {
    visible.value = false;
    resetPose();
    return;
  }
  pageVisible.value = document.visibilityState !== "hidden";
  if (typeof window.matchMedia === "function") {
    media = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.value = media.matches;
    media.addEventListener("change", mediaChange);
  }
  document.addEventListener("visibilitychange", visibilityChange);
  listening = true;
  visible.value = typeof IntersectionObserver === "undefined";
  if (typeof IntersectionObserver !== "undefined" && root.value) {
    observer = new IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.target === root.value);
      if (!entry) return;
      visible.value = entry.isIntersecting;
      if (entry.isIntersecting && initialPreviewCompletion) {
        initialPreviewCompletion = false;
        resetPose(props.preview && state.value === "completed" && motionAllowed.value && pageVisible.value);
      }
      if (!entry.isIntersecting && transition?.target.celebrate) transition = avatarTransition(pose.value!, { ...transition.target, celebrate: false }, time);
      reconcile();
    });
    observer.observe(root.value);
  }
  const celebrate = visible.value && pageVisible.value && motionAllowed.value && initialPreviewCompletion;
  if (visible.value) initialPreviewCompletion = false;
  resetPose(celebrate);
}
watch(resourceEligible, () => { if (mounted) configureResources(); });
watch(() => [character.value?.shape, character.value?.color, character.value?.expression, state.value, props.activityKey, props.disabled, props.observedCompletion] as const, (next, previous) => {
  const rekey = next[4] !== previous[4];
  if (rekey) { time = 0; pointer = undefined; }
  const celebrate = visible.value && pageVisible.value && motionAllowed.value
    && (props.preview && next[3] === "completed" && (rekey || previous[3] !== "completed")
      || props.observedCompletion && !rekey && shouldCelebrate(previous[3], next[3], previous[4], next[4]));
  resetPose(celebrate);
});
watch(() => props.follow, reconcile);
onMounted(() => { mounted = true; configureResources(); });
onActivated(() => { active = true; if (mounted) configureResources(); });
onDeactivated(() => { active = false; releaseResources(); });
onBeforeUnmount(() => { mounted = false; releaseResources(); });
</script>

<template>
  <span ref="root" data-test="bot-avatar" :data-state="state" :data-avatar-kind="avatar?.kind || 'default'"
    class="bot-avatar" role="img" :aria-label="label" :title="avatar?.kind === 'text' ? avatar.value : label"
    :style="{ width: `${size}px`, height: `${size}px` }">
    <AgentIcon v-if="!avatar" :driver="driver" :size="size" aria-hidden="true" />
    <span v-else-if="avatar.kind === 'text'" class="bot-avatar-text" aria-hidden="true">{{ text }}</span>
    <svg v-else-if="pose" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">
      <defs><clipPath :id="maskId"><path :d="path" /></clipPath></defs>
      <circle v-if="pose.ring" r="44" fill="none" stroke="rgb(var(--c-accent))" stroke-width="3" :opacity="pose.ring" />
      <path class="bot-avatar-body" :d="path" :fill="color" :data-hairline="hairline" />
      <g :clip-path="`url(#${maskId})`">
        <rect v-for="(eye, index) in pose.eyes" :key="index" :x="-eye.w / 2" :y="-eye.h / 2" :width="eye.w" :height="eye.h" :rx="Math.min(eye.w, eye.h) / 2"
          :transform="`matrix(${eye.a} ${eye.b} ${eye.c} ${eye.d} ${eye.x} ${eye.y})`"
          :fill="eyeFill" />
      </g>
    </svg>
    <span v-if="indicator" class="bot-avatar-indicator" aria-hidden="true">{{ indicator }}</span>
  </span>
</template>

<style scoped>
.bot-avatar { display: inline-grid; position: relative; place-items: center; flex-shrink: 0; vertical-align: middle; isolation: isolate; }
.bot-avatar > svg { display: block; width: 100%; height: 100%; overflow: visible; }
.bot-avatar-text { width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; font-size: 0.8em; line-height: 1; color: rgb(var(--c-fg)); }
.bot-avatar-indicator { position: absolute; right: -2px; bottom: -2px; display: grid; place-items: center; min-width: 0.8em; height: 0.8em; padding: 1px; border-radius: 50%; box-shadow: 0 0 0 2px rgb(var(--c-bg)); background: rgb(var(--c-surface)); color: rgb(var(--c-fg)); font-size: 11px; font-weight: 800; line-height: 1; }
/* Low-contrast exceptions (creme ≈1.15:1 on the light bg, encre ≈1.08:1 on the dark bg):
   the only bodies that keep a faint hairline, so they do not disappear. */
:global(html:not(.dark) .bot-avatar-body[data-hairline="creme"]) { stroke: rgb(var(--c-fg)); stroke-opacity: 0.12; stroke-width: 1.5; }
:global(html.dark .bot-avatar-body[data-hairline="encre"]) { stroke: #FFFFFF; stroke-opacity: 0.12; stroke-width: 1.5; }
.bot-avatar[data-state="waiting"] .bot-avatar-indicator { color: rgb(var(--c-warn)); }
.bot-avatar[data-state="failed"] .bot-avatar-indicator { color: rgb(var(--c-danger)); }
</style>
