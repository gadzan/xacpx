import { defineStore } from "pinia";
import { ref } from "vue";
import type { AgentCommandDto, WebServerEvent } from "@ganglion/xacpx-relay-protocol";

export interface ConversationCommandKey {
  instanceId: string;
  conversationId: string;
  topicId: string;
  botId: string;
}

export function conversationCommandKey(key: ConversationCommandKey): string {
  return `${key.instanceId}\0${key.conversationId}\0${key.topicId}\0${key.botId}`;
}

/**
 * Latest adapter slash advertisement for one Bot runtime on one Topic.
 * Ordinary session command caches do not store these rows.
 */
export const useConversationCommandsStore = defineStore("conversation-commands", () => {
  const byKey = ref<Record<string, AgentCommandDto[]>>({});

  function commandsFor(key: ConversationCommandKey): AgentCommandDto[] {
    return byKey.value[conversationCommandKey(key)] ?? [];
  }

  function remember(key: ConversationCommandKey, commands: AgentCommandDto[]): void {
    byKey.value = { ...byKey.value, [conversationCommandKey(key)]: commands.map((command) => ({ ...command })) };
  }

  function clearInstance(instanceId: string): void {
    const prefix = `${instanceId}\0`;
    const next: Record<string, AgentCommandDto[]> = {};
    for (const [key, commands] of Object.entries(byKey.value)) {
      if (!key.startsWith(prefix)) next[key] = commands;
    }
    byKey.value = next;
  }

  function replaceInstance(instanceId: string, rows: Array<Omit<ConversationCommandKey, "instanceId"> & { commands: AgentCommandDto[] }>): void {
    const prefix = `${instanceId}\0`;
    const next: Record<string, AgentCommandDto[]> = {};
    for (const [key, commands] of Object.entries(byKey.value)) {
      if (!key.startsWith(prefix)) next[key] = commands;
    }
    for (const row of rows) {
      next[conversationCommandKey({ instanceId, ...row })] = row.commands.map((command) => ({ ...command }));
    }
    byKey.value = next;
  }

  function ingest(event: WebServerEvent): void {
    if (event.kind === "instance-status" && !event.online) {
      clearInstance(event.instanceId);
      return;
    }
    if (event.kind === "state-snapshot") {
      replaceInstance(event.instanceId, event.conversationCommands ?? []);
      return;
    }
    if (event.kind !== "control-event") return;
    const body = event.event;
    if (body.type !== "agent-commands" || !body.conversation?.botId) return;
    remember({
      instanceId: event.instanceId,
      conversationId: body.conversation.conversationId,
      topicId: body.conversation.topicId,
      botId: body.conversation.botId,
    }, body.commands);
  }

  return { commandsFor, remember, clearInstance, replaceInstance, ingest };
});
