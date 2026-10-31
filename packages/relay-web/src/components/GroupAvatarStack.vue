<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Users } from "lucide-vue-next";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import BotAvatar from "./BotAvatar.vue";
import { useInstancesStore } from "../stores/instances";

const props = defineProps<{
  /** The group's members, as the caller knows them. */
  bots: BotSummaryDto[];
  /** The container size in px. */
  size: number;
  /** The members' instance, which maps each agent name to the driver the
   *  default avatar draws. */
  instanceId?: string | null;
  /** The group name, for the accessible label. */
  name: string;
  /** The TOTAL member count, disabled ones included. */
  totalCount: number;
  /** How many members are disabled or retired. */
  disabledCount: number;
  /** The lead member, drawn first. */
  leadBotId?: string;
  /** Member ids by most recent activity, newest first. */
  activityBotIds?: string[];
  /** The row already states the name and the count, so the collage stays silent. */
  decorative?: boolean;
}>();

const { t } = useI18n();
const instancesStore = useInstancesStore();

/** The same driver lookup the transcript and the sidebar use, so a member
 *  without an avatar draws the same default avatar in all three. */
function driverFor(bot: BotSummaryDto): string | undefined {
  const inst = props.instanceId ? instancesStore.byId(props.instanceId) : undefined;
  return inst?.agents.find((a) => a.name === bot.agent)?.driver;
}

/** Sub-avatar diameter, as a share of the container. */
const SUB_RATIO = 0.59;
// A disabled or retired member takes no work, so it has no place in the collage.
const eligible = computed(() => props.bots.filter((b) => b.enabled !== false && b.retired !== true));

// Up to four members fit the 2x2 grid; the small top bar only fits three.
const maxShown = computed(() => (props.size >= 36 ? 4 : 3));

// The lead first, then the most recently active members. The sort is stable,
// so members nobody spoke for keep the order the caller passed them in.
const ordered = computed(() => {
  const activityRank = new Map<string, number>();
  for (const id of props.activityBotIds ?? []) {
    if (!activityRank.has(id)) activityRank.set(id, activityRank.size);
  }
  return [...eligible.value].sort((a, b) => {
    const leadA = props.leadBotId === a.id ? 0 : 1;
    const leadB = props.leadBotId === b.id ? 0 : 1;
    if (leadA !== leadB) return leadA - leadB;
    return (activityRank.get(a.id) ?? Infinity) - (activityRank.get(b.id) ?? Infinity);
  });
});

const shown = computed(() => (ordered.value.length <= maxShown.value ? ordered.value : ordered.value.slice(0, 3)));

/** The overflow marker counts the eligible members that did not fit. */
const overflow = computed(() => {
  const hidden = ordered.value.length - shown.value.length;
  if (hidden <= 0) return "";
  return hidden >= 100 ? "99+" : `+${hidden}`;
});

const LAYOUTS: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[31, 31], [69, 69]],
  3: [[29, 29], [71, 29], [50, 71]],
  4: [[29, 29], [71, 29], [29, 71], [71, 71]],
};
const layout = computed(() => LAYOUTS[shown.value.length] ?? LAYOUTS[3]!);

/** A lone member fills the container; the rest are sub-avatars. */
const subSize = computed(() => (shown.value.length === 1 ? props.size : Math.round(props.size * SUB_RATIO)));

/** Each member is outlined along its own shape in the backdrop colour, so an
 *  overlapping member reads as cut out of the one below. Thinner on the small
 *  sizes, where a wider edge turns ragged. */
const outlineWidth = computed(() => (props.size <= 36 ? 1 : 1.5));
const outlineShadow = computed(() => {
  const w = outlineWidth.value, ring = "var(--avatar-ring)";
  return `drop-shadow(${w}px 0 0 ${ring}) drop-shadow(-${w}px 0 0 ${ring}) drop-shadow(0 ${w}px 0 ${ring}) drop-shadow(0 -${w}px 0 ${ring})`;
});

const containerStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
}));

function itemStyle(index: number) {
  const [x, y] = layout.value[index] ?? [50, 50];
  return {
    left: `${x}%`,
    top: `${y}%`,
    width: `${subSize.value}px`,
    height: `${subSize.value}px`,
  };
}

/** The marker is sized down for a three-character label, which would
 *  otherwise overflow its quadrant. */
const markerStyle = computed(() => ({
  left: "79.5%",
  top: "72%",
  filter: outlineShadow.value,
  fontSize: `${Math.round(props.size * (overflow.value.length === 3 ? 0.29 : 0.38))}px`,
}));

const fallbackIconSize = computed(() => Math.round(props.size * 0.44));

const label = computed(() => {
  const count = t("group.header.members", props.totalCount);
  const disabled = props.disabledCount > 0 ? t("group.avatar.disabled", { count: props.disabledCount }) : "";
  return `${props.name} · ${count}${disabled}`;
});
</script>

<template>
  <span
    class="group-avatar-stack relative inline-block shrink-0 align-middle"
    :style="containerStyle"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : label"
    :aria-hidden="decorative ? 'true' : undefined"
    data-test="group-avatar-stack"
  >
    <!-- No eligible member: the group still has an identity, so it keeps the
         plain group glyph rather than an empty collage. -->
    <span v-if="!eligible.length" class="grid h-full w-full place-items-center rounded-lg bg-accent-soft text-accent">
      <Users :size="fallbackIconSize" aria-hidden="true" />
    </span>
    <template v-else>
      <span
        v-for="(bot, index) in shown"
        :key="bot.id"
        class="group-avatar-item absolute grid place-items-center"
        :style="itemStyle(index)"
        aria-hidden="true"
        data-test="group-avatar-item"
        :data-bot-id="bot.id"
      >
        <BotAvatar :avatar="bot.avatar" :driver="driverFor(bot)" :name="bot.name" :size="subSize" :outline="outlineWidth" static aria-hidden="true" />
      </span>
      <span
        v-if="overflow"
        class="group-avatar-more absolute grid place-items-center font-extrabold leading-none tracking-[-0.04em] text-fg-muted"
        :style="markerStyle"
        aria-hidden="true"
        data-test="group-avatar-more"
      >{{ overflow }}</span>
    </template>
  </span>
</template>
<style scoped>
.group-avatar-item, .group-avatar-more { transform: translate(-50%, -50%); }
/* The outline takes the colour of the backdrop it sits on. The caller
   overrides it for a different backdrop. */
.group-avatar-stack { --avatar-ring: rgb(var(--c-bg)); }
</style>
