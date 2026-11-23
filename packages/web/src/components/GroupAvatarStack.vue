<script setup lang="ts">
import { computed, useId } from "vue";
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

/** Sub-avatar diameter, as a share of the container. Wide enough that
 *  neighbours press into each other: four 0.6 cells at 31%/69% overlap by 0.22
 *  of the container on both axes, so the collage reads as a stack rather than a
 *  tiled grid. */
const SUB_RATIO = 0.6;

/** Eligible cells in the caller's order, deduped by id: a member listed twice
 *  still draws once. A disabled or retired member takes no work, so it takes no
 *  cell; the label still counts it. */
const eligible = computed(() => {
  const seen = new Set<string>();
  const members: BotSummaryDto[] = [];
  for (const bot of props.bots) {
    if (bot.enabled === false || bot.retired === true || seen.has(bot.id)) continue;
    seen.add(bot.id);
    members.push(bot);
  }
  return members;
});

/** Four cells is the ceiling at every container size, so a four-member group
 *  draws four cells in the sidebar and in the top bar alike; a fifth member
 *  turns the collage into three cells plus a count. Nothing sorts the members,
 *  so the collage cannot reshuffle while the transcript moves. */
const shown = computed(() => (eligible.value.length <= 4 ? eligible.value : eligible.value.slice(0, 3)));

/** The overflow marker counts the eligible members that did not fit. */
const overflow = computed(() => {
  const hidden = eligible.value.length - shown.value.length;
  if (hidden <= 0) return "";
  return hidden >= 100 ? "99+" : `+${hidden}`;
});

const LAYOUTS: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[34, 34], [66, 66]],
  3: [[30, 30], [70, 30], [50, 70]],
  4: [[31, 31], [69, 31], [31, 69], [69, 69]],
};
/** With an overflow marker the three cells take the top row and the bottom
 *  left, so the marker owns the bottom-right quadrant alone. */
const OVERFLOW_LAYOUT: Array<[number, number]> = [[31, 31], [69, 31], [31, 69]];
const layout = computed(() => (overflow.value ? OVERFLOW_LAYOUT : LAYOUTS[shown.value.length] ?? LAYOUTS[3]!));

/** A lone member fills the container; the rest are sub-avatars. */
const subSize = computed(() => (shown.value.length === 1 ? props.size : Math.round(props.size * SUB_RATIO)));

/** The outline follows each avatar's own opaque shape: the filter dilates
 *  the item's alpha and paints the grown edge in the backdrop colour, so an
 *  overlapping member reads as cut out of the one below. */
const outlineId = `group-avatar-outline-${useId()}`;
const outlineWidth = computed(() => (props.size <= 36 ? 1 : 1.5));
const outlineFilter = `url(#${outlineId})`;

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
    filter: outlineFilter,
  };
}

/** The marker is sized down for a three-character label, which would
 *  otherwise overflow its quadrant. */
const markerStyle = computed(() => ({
  left: "79.5%",
  top: "72%",
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
      <svg class="absolute h-0 w-0" aria-hidden="true" focusable="false">
        <filter :id="outlineId" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB" data-test="group-avatar-outline">
          <feMorphology in="SourceAlpha" operator="dilate" :radius="outlineWidth" result="grown" />
          <feFlood style="flood-color: var(--avatar-ring)" />
          <feComposite in2="grown" operator="in" result="outline" />
          <feMerge>
            <feMergeNode in="outline" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </svg>
      <span
        v-for="(bot, index) in shown"
        :key="bot.id"
        class="group-avatar-item absolute grid place-items-center"
        :style="itemStyle(index)"
        aria-hidden="true"
        data-test="group-avatar-item"
        :data-bot-id="bot.id"
      >
        <BotAvatar :avatar="bot.avatar" :driver="driverFor(bot)" :name="bot.name" :size="subSize" static aria-hidden="true" />
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
