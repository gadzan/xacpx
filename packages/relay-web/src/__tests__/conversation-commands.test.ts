import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useConversationCommandsStore } from "../stores/conversation-commands";

describe("conversation slash advertisements", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("keeps a command list per topic and restores it from a reconnect snapshot", () => {
    const store = useConversationCommandsStore();
    store.ingest({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "agent-commands",
        chatKey: "relay:a",
        sessionAlias: "hidden",
        commands: [{ name: "compact", description: "Compact" }],
        conversation: {
          conversationId: "c1",
          topicId: "topic-a",
          botId: "bot-a",
          runId: "run-1",
          memberTurnId: "mt-1",
        },
      },
    });
    store.ingest({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "agent-commands",
        chatKey: "relay:a",
        sessionAlias: "hidden",
        commands: [{ name: "diff" }],
        conversation: {
          conversationId: "c1",
          topicId: "topic-b",
          botId: "bot-a",
          runId: "run-2",
          memberTurnId: "mt-2",
        },
      },
    });
    expect(store.commandsFor({
      instanceId: "i1", conversationId: "c1", topicId: "topic-a", botId: "bot-a",
    }).map((command) => command.name)).toEqual(["compact"]);
    expect(store.commandsFor({
      instanceId: "i1", conversationId: "c1", topicId: "topic-b", botId: "bot-a",
    }).map((command) => command.name)).toEqual(["diff"]);

    store.ingest({ kind: "instance-status", instanceId: "i1", online: false });
    expect(store.commandsFor({
      instanceId: "i1", conversationId: "c1", topicId: "topic-a", botId: "bot-a",
    })).toEqual([]);

    store.ingest({
      kind: "state-snapshot",
      instanceId: "i1",
      turns: [],
      usage: [],
      commands: [],
      conversationCommands: [{
        instanceId: "i1",
        conversationId: "c1",
        topicId: "topic-a",
        botId: "bot-a",
        commands: [{ name: "compact" }],
      }],
    });
    expect(store.commandsFor({
      instanceId: "i1", conversationId: "c1", topicId: "topic-a", botId: "bot-a",
    })).toEqual([{ name: "compact" }]);
    expect(store.commandsFor({
      instanceId: "i1", conversationId: "c1", topicId: "topic-b", botId: "bot-a",
    })).toEqual([]);
  });
});
