<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { BotSummaryDto } from "@ganglion/xacpx-relay-protocol";
import { useGroupsStore } from "../stores/groups";
import { useDirectBotsStore } from "../stores/direct-bots";
import { useInstancesStore } from "../stores/instances";
import { countDisabledGroupMembers, presentGroupMembers, type GroupMemberRow } from "../lib/group-members";
import GroupMemberDialog from "./GroupMemberDialog.vue";
import GroupMemberList from "./GroupMemberList.vue";
import MobileSheet from "./MobileSheet.vue";
import { useIsMobile } from "../lib/use-dropdown";

/**
 * The Group's membership view.
 *
 * It lists every member of the Group with its name, role and state. A
 * disabled member is a member: it stays in this list (it is only excluded
 * from the avatar collage), and the accessible name says how many members
 * are disabled, so the count is never carried by the picture alone.
 *
 * Two surfaces, one content: below lg it is a bottom sheet (MobileSheet),
 * from lg it is a centred dialog like the app's other overlays. Each surface
 * owns its own modal layer, so exactly one is registered at a time and
 * Escape and the mobile back gesture close this panel and nothing else.
 */
const groupsStore = useGroupsStore();
const directBotsStore = useDirectBotsStore();
const instancesStore = useInstancesStore();
const { t } = useI18n();

const emit = defineEmits<{
  close: [];
}>();

const group = computed(() => groupsStore.currentGroup);
const bots = computed<BotSummaryDto[]>(() => {
  const instId = groupsStore.instanceId;
  if (!instId) return [];
  return directBotsStore.botsByInstance[instId] ?? [];
});

function driverFor(botId: string): string | undefined {
  const instId = groupsStore.instanceId;
  if (!instId) return undefined;
  const inst = instancesStore.byId(instId);
  const agent = bots.value.find((bot) => bot.id === botId)?.agent;
  return inst?.agents.find((a) => a.name === agent)?.driver;
}

const rows = computed<GroupMemberRow[]>(() => {
  const current = group.value;
  if (!current) return [];
  return presentGroupMembers({
    botIds: current.botIds,
    leadBotId: current.leadBotId,
    bots: bots.value,
    driverFor,
  });
});

const disabledCount = computed(() => countDisabledGroupMembers(rows.value));

/** The accessible name: the Group, its member count, and how many are disabled. */
const label = computed(() => {
  const title = group.value?.title ?? t("group.nav.title");
  const suffix = disabledCount.value > 0 ? t("group.panel.disabledSuffix", { count: disabledCount.value }) : "";
  return t("group.panel.label", { title, count: rows.value.length, disabled: suffix });
});

const isMobile = useIsMobile();
</script>

<template>
  <!-- Below lg: the same content in a bottom sheet. Exactly one surface is
       mounted at a time, so exactly one modal layer is registered. -->
  <MobileSheet v-if="isMobile" :title="label" test-id="group-member-sheet" @close="emit('close')">
    <GroupMemberList :rows="rows" />
  </MobileSheet>

  <!-- From lg: a centred dialog, like the app's other overlays. -->
  <GroupMemberDialog v-if="!isMobile" :rows="rows" :label="label" @close="emit('close')" />
</template>
