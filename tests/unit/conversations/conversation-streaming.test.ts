import { expect, test } from "bun:test";
import type { AppConfig, ReplyMode } from "../../../src/config/types";
import { CommandRouter } from "../../../src/commands/command-router";
import { ConsoleAgent } from "../../../src/console-agent";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type LogicalSessionOwner } from "../../../src/state/types";
import { AcpxBridgeTransport } from "../../../src/transport/acpx-bridge/acpx-bridge-transport";

function config(replyMode: ReplyMode): AppConfig {
  return {
    transport: { type: "acpx-bridge", command: "acpx", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 1024, maxFiles: 2, retentionDays: 1 },
    channel: { type: "weixin", replyMode },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    agents: { codex: { driver: "codex" } },
    workspaces: { backend: { cwd: "/tmp/backend" } },
  };
}

for (const kind of ["bot-direct", "group-member"] as const) {
  for (const replyMode of ["verbose", "final", "stream"] as const) {
    test(`${kind} preserves token chunks and the durable reply with global ${replyMode} mode`, async () => {
      const appConfig = config(replyMode);
      const state = createEmptyState();
      const alias = kind === "bot-direct" ? "brt_bind_test" : "brt_group_bind_test";
      const owner: LogicalSessionOwner = {
        kind, bindingId: "bind_test", botId: "bot_test", conversationId: "conversation_test", topicId: "topic_test",
      };
      state.sessions[alias] = {
        alias, owner, agent: "codex", workspace: "backend", transport_session: "backend:owned",
        logical_session_id: "logical_test", transport_engine: "runtime",
        created_at: "2026-01-01T00:00:00.000Z", last_used_at: "2026-01-01T00:00:00.000Z",
      };
      const sessions = new SessionService(appConfig, { save: async () => {}, saveNow: async () => {} }, state);
      const chunks = ["你好", "，我", "是", "「", "资", "深", "开发", "」。\n\n", "| 列 |\n", "| --- |\n", "| 值 |"];
      const expected = chunks.join("");
      const bridgeModes: unknown[] = [];
      const transport = new AcpxBridgeTransport({
        async request<T>(method, params, onEvent): Promise<T> {
          if (method === "hasSession") return { exists: true } as T;
          if (method === "prompt") {
            bridgeModes.push(params.replyMode);
            for (const text of chunks) onEvent?.({ type: "prompt.segment", text });
            return { text: expected } as T;
          }
          throw new Error(`unexpected bridge request: ${method}`);
        },
      });
      const events = createControlEventBus();
      const captured: ControlEvent[] = [];
      events.subscribe((event) => captured.push(event));
      const runner = new SessionTurnRunner({
        agent: new ConsoleAgent(new CommandRouter(sessions, transport, appConfig)),
        sessions, events, uploadStore: { root: "/tmp/uploads" },
      } as never);

      const result = await runner.run({
        chatKey: "bot:conversation_test:topic_test", sessionAlias: alias, text: "hi", senderId: "human",
        turnOrigin: "human",
        conversation: {
          conversationId: "conversation_test", topicId: "topic_test", botId: "bot_test",
          runId: "run_test", memberTurnId: "mturn_test",
        },
      }, new AbortController().signal);

      expect(bridgeModes).toEqual(["stream"]);
      expect(captured.filter((event) => event.type === "turn-output").map((event) => event.chunk)).toEqual(chunks);
      expect(captured.find((event) => event.type === "turn-finished")).toMatchObject({ ok: true, text: expected });
      expect(result).toMatchObject({ ok: true, text: expected });
    });
  }
}
