<script setup lang="ts">
/**
 * The one switch in the app: a 44x26 track inside a 44x44 transparent hit disc.
 * The knob keeps a 3px inset on both sides in both states — 44 - 2*3 - 20 = 18px
 * of travel — so the dot never drifts toward one edge as it toggles.
 *
 * The travel is a transform on a fixed `left: 3px`, not an animated `left`: the
 * knob is composited while it slides, so the toggle never re-lays-out the row
 * around it (a track whose left moves relayouts on every frame).
 */
const props = defineProps<{
  checked: boolean;
  /** Accessible name; the switch carries no visible text. */
  label: string;
  disabled?: boolean;
  busy?: boolean;
  /** Dims the control when a tap cannot change it for a reason other than `disabled`. */
  muted?: boolean;
  testId?: string;
}>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button type="button" role="switch" :data-test="props.testId" :aria-checked="props.checked"
          :aria-label="props.label" :aria-busy="props.busy" :disabled="props.disabled"
          class="relative grid h-11 w-11 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60"
          @click="$emit('toggle')">
    <span class="relative block h-[26px] w-[44px] rounded-full transition-colors duration-150 ease-ui motion-reduce:transition-none"
          :class="[props.checked ? 'bg-accent' : 'bg-fill-track', props.muted ? 'opacity-60' : '']">
      <span class="absolute left-[3px] top-[3px] block h-5 w-5 rounded-full bg-raised shadow-press transition-transform duration-150 ease-ui motion-reduce:transition-none"
            :class="props.checked ? 'translate-x-[18px]' : 'translate-x-0'" />
    </span>
  </button>
</template>
