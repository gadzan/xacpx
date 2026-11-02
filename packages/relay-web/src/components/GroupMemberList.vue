<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { BotAvatarConfig } from "@ganglion/xacpx-relay-protocol";
import BotAvatar from "./BotAvatar.vue";

/**
 * The member rows of the Group member panel.
 *
 * Display only: the panel owns the roster, this component owns the row
 * markup, so the mobile sheet and the desktop dialog render the same list
 * without duplicating it. A row is a compact list row (48px), never a
 * conversation row.
 *
 * `state`:
 *   · enabled  — a member that takes new work.
 *   · disabled — still a member, but it takes no new work until it is enabled
 *     again; the reason is spelled out under the name.
 *   · removed  — the Bot is gone (or was never in the catalog): kept in the
 *     list because the Group still names it, and it can take no work.
 *   · unknown  — the catalog has not confirmed the Bot yet, so no state is
 *     claimed.
 */
const props = defineProps<{
  rows: {
    botId: string;
    name: string;
    role?: string;
    avatar?: BotAvatarConfig;
    driver?: string;
    isLead: boolean;
    state: "enabled" | "disabled" | "removed" | "unknown";
  }[];
}>();

const { t } = useI18n();

function stateLabel(state: (typeof props.rows)[number]["state"]): string {
  if (state === "enabled") return t("bot.status.enabled");
  if (state === "disabled") return t("bot.status.disabled");
  if (state === "removed") return t("group.panel.removed");
  return "";
}
</script>

<template>
  <ul data-test="group-member-list" class="space-y-px">
    <li
      v-for="row in props.rows"
      :key="row.botId"
      data-test="group-member-row"
      :data-bot-id="row.botId"
      :data-state="row.state"
      class="flex min-h-12 items-center gap-3 px-3 py-2"
    >
      <span
        class="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2"
        aria-hidden="true"
      >
        <BotAvatar
          :avatar="row.avatar"
          :driver="row.driver"
          :name="row.name"
          :size="24"
          static
          :disabled="row.state === 'disabled'"
          :retired="row.state === 'removed'"
        />
      </span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="flex min-w-0 items-center gap-1.5">
          <span
            data-test="group-member-name"
            class="truncate text-sm font-medium"
            :class="row.state === 'enabled' ? 'text-fg' : 'text-fg-muted'"
          >{{ row.name }}</span>
          <span
            v-if="row.isLead"
            data-test="group-member-lead"
            class="shrink-0 rounded-sm bg-accent-soft px-1 py-px text-[10px] font-medium text-accent-text"
          >{{ $t("group.panel.lead") }}</span>
        </span>
        <span v-if="row.role" data-test="group-member-role" class="truncate text-xs text-fg-muted">{{ row.role }}</span>
        <span
          v-if="row.state === 'disabled'"
          data-test="group-member-disabled-reason"
          class="truncate text-xs text-warn-overlay"
        >{{ $t("group.panel.disabledReason") }}</span>
      </span>
      <span
        v-if="row.state !== 'unknown'"
        data-test="group-member-state"
        class="flex shrink-0 items-center gap-1.5 text-xs"
        :class="row.state === 'enabled' ? 'text-fg' : 'text-fg-muted'"
      >
        <span
          class="h-1.5 w-1.5 rounded-full"
          :class="row.state === 'enabled' ? 'bg-run' : 'bg-fg-muted'"
          aria-hidden="true"
        />
        {{ stateLabel(row.state) }}
      </span>
    </li>
  </ul>
</template>
