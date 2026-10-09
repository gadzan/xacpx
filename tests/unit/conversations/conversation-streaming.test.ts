import { expect, test } from "bun:test";
import type { AppConfig, ReplyMode } from "../../../src/config/types";
import { CommandRouter } from "../../../src/commands/command-router";
import { ConsoleAgent } from "../../../src/console-agent";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { SessionService } from "../../../src/sessions/session-service";
import { createEmptyState, type LogicalSessionOwner } from "../../../src/state/types";
import { AcpxBridgeTransport } from "../../../src/transport/acpx-bridge/acpx-bridge-transport";

type BotSessionKind = "bot-direct" | "group-member";

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

async function runReply(input: {
  kind: BotSessionKind;
  replyMode: ReplyMode;
  chunks: string[];
  finalText: string;
  groupExecutionToken?: string;
}) {
  const { kind, replyMode, chunks, finalText, groupExecutionToken } = input;
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
  const bridgeParams: Record<string, unknown>[] = [];
  const transport = new AcpxBridgeTransport({
    async request<T>(method, params, onEvent): Promise<T> {
      if (method === "hasSession") return { exists: true } as T;
      if (method === "prompt") {
        bridgeParams.push(params);
        for (const text of chunks) onEvent?.({ type: "prompt.segment", text });
        return { text: finalText } as T;
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
    turnOrigin: groupExecutionToken ? "orchestration" : "human",
    ...(groupExecutionToken ? { groupExecutionToken, boundSessionAlias: alias } : {}),
    conversation: {
      conversationId: "conversation_test", topicId: "topic_test", botId: "bot_test",
      runId: "run_test", memberTurnId: "mturn_test",
    },
  }, new AbortController().signal);

  return { result, captured, bridgeParams };
}

function expectReply(outcome: Awaited<ReturnType<typeof runReply>>, chunks: string[], expected: string) {
  expect(outcome.bridgeParams.map((params) => params.replyMode)).toEqual(["stream"]);
  expect(outcome.captured.filter((event) => event.type === "turn-output").map((event) => event.chunk)).toEqual(chunks);
  expect(outcome.captured.find((event) => event.type === "turn-finished")).toMatchObject({ ok: true, text: expected });
  expect(outcome.result).toMatchObject({ ok: true, text: expected });
}

const tokenChunks = ["你好", "，我", "是", "「", "资", "深", "开发", "」。\n\n", "| 列 |\n", "| --- |\n", "| 值 |"];

for (const kind of ["bot-direct", "group-member"] as const) {
  for (const replyMode of ["verbose", "final", "stream"] as const) {
    test(`${kind} preserves token chunks and the durable reply with global ${replyMode} mode`, async () => {
      const expected = tokenChunks.join("");
      const outcome = await runReply({ kind, replyMode, chunks: tokenChunks, finalText: expected });
      expectReply(outcome, tokenChunks, expected);
    });

    test(`${kind} completes a partially streamed reply with global ${replyMode} mode`, async () => {
      const chunks = ["你", "好"];
      const suffix = "世界\n\n第二段。";
      const expected = chunks.join("") + suffix;
      const outcome = await runReply({ kind, replyMode, chunks, finalText: expected });
      expectReply(outcome, [...chunks, suffix], expected);
    });
  }

  for (const fixture of [
    {
      name: "preserves the missing Markdown suffix verbatim",
      chunks: ["| 列 |", " 值 |\n"],
      finalText: "| 列 | 值 |\n| --- | --- |\n| 中文 | 世界 |\n",
      suffix: "| --- | --- |\n| 中文 | 世界 |\n",
    },
    {
      name: "does not replay a shorter final response",
      chunks: ["你好", "世界"], finalText: "你好", suffix: "",
    },
    {
      name: "does not guess a trailing delta from a nonmatching settled response",
      chunks: ["你好"], finalText: "世界", suffix: "",
    },
    {
      name: "preserves streamed text when the final response is empty",
      chunks: ["你好", "世界"], finalText: "", suffix: "",
    },
  ]) {
    test(`${kind} ${fixture.name}`, async () => {
      const { chunks, finalText, suffix } = fixture;
      const outcome = await runReply({ kind, replyMode: "verbose", chunks, finalText });
      expectReply(outcome, suffix ? [...chunks, suffix] : chunks, chunks.join("") + suffix);
    });
  }

  for (const chunks of [[], [""]] as string[][]) {
    test(`${kind} preserves a final-only reply with ${chunks.length} empty segments`, async () => {
      const finalText = "仅在结束时返回的回复。\n\n第二段。";
      const outcome = await runReply({ kind, replyMode: "final", chunks, finalText });
      expectReply(outcome, [finalText], finalText);
    });
  }

  test(`${kind} settles an empty provider reply without inventing output`, async () => {
    const outcome = await runReply({ kind, replyMode: "verbose", chunks: [], finalText: "" });
    expectReply(outcome, [], "");
  });
}

for (const replyMode of ["verbose", "final", "stream"] as const) {
  test(`trusted Group execution token preserves streaming and the final suffix with global ${replyMode} mode`, async () => {
    const expected = tokenChunks.join("");
    const chunks = tokenChunks.slice(0, -1);
    const suffix = tokenChunks.at(-1)!;
    const groupExecutionToken = "private-group-execution-test";
    const outcome = await runReply({ kind: "group-member", replyMode, chunks, finalText: expected, groupExecutionToken });
    expectReply(outcome, [...chunks, suffix], expected);
    expect(outcome.bridgeParams[0]).toMatchObject({
      mcpCoordinatorSession: groupExecutionToken, mcpSourceHandle: groupExecutionToken,
    });
    expect(JSON.stringify(outcome.captured)).not.toContain(groupExecutionToken);
  });
}
