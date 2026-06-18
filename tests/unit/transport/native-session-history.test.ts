import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapAcpxMessagesToHistory, readNativeSessionHistory } from "../../../src/transport/native-session-history";

test("maps acpx User/Agent messages into neutral history (text, reasoning, tool)", () => {
  const messages = [
    { User: { id: "u1", content: [{ Text: "summarize the repo" }] } },
    {
      Agent: {
        content: [
          { Thinking: { text: "let me look" } },
          { ToolUse: { id: "t1", name: "Read File", input: { path: "a.ts" }, raw_input: "{}", is_input_complete: true } },
          { Text: "Done — it's a CLI." },
        ],
        tool_results: { t1: { tool_use_id: "t1", tool_name: "Read File", is_error: false, content: { Text: "export const x" } } },
      },
    },
    "Resume",
  ];
  const history = mapAcpxMessagesToHistory(messages);
  expect(history.map((m) => m.role)).toEqual(["user", "agent"]); // Resume dropped
  expect(history[0]).toEqual({ role: "user", text: "summarize the repo" });
  const agent = history[1]!;
  expect(agent.text).toBe("Done — it's a CLI.");
  expect(agent.parts?.map((p) => p.kind)).toEqual(["reasoning", "tool", "text"]);
  const tool = agent.parts!.find((p) => p.kind === "tool") as Extract<NonNullable<typeof agent.parts>[number], { kind: "tool" }>;
  expect(tool.tool).toMatchObject({ toolCallId: "t1", toolName: "Read File", kind: "read", status: "success" });
  expect(tool.tool.rawOutput).toBe("export const x");
});

test("a failed tool result maps to error status", () => {
  const history = mapAcpxMessagesToHistory([
    { Agent: { content: [{ ToolUse: { id: "t9", name: "Bash" } }], tool_results: { t9: { is_error: true, output: "boom" } } } },
  ]);
  const tool = history[0]!.parts!.find((p) => p.kind === "tool") as { kind: "tool"; tool: { status: string; kind: string } };
  expect(tool.tool.status).toBe("error");
  expect(tool.tool.kind).toBe("execute");
});

test("non-array / junk input yields empty history without throwing", () => {
  expect(mapAcpxMessagesToHistory(null)).toEqual([]);
  expect(mapAcpxMessagesToHistory({})).toEqual([]);
  expect(mapAcpxMessagesToHistory([42, "Resume", { Unknown: 1 }])).toEqual([]);
});

test("readNativeSessionHistory reads the record file via the index, picking the richest match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acpx-sessions-"));
  // Two records share the acp_session_id: the empty fresh attach stub + the real source.
  writeFileSync(join(dir, "stub.json"), JSON.stringify({ acpSessionId: "ses_X", messages: [] }));
  writeFileSync(join(dir, "src.json"), JSON.stringify({ acpSessionId: "ses_X", messages: [{ User: { id: "u", content: [{ Text: "hi" }] } }] }));
  writeFileSync(join(dir, "index.json"), JSON.stringify({
    schema: "acpx.session-index.v1",
    entries: [
      { file: "stub.json", acpSessionId: "ses_X", agentCommand: "opencode acp" },
      { file: "src.json", acpSessionId: "ses_X", agentCommand: "opencode acp" },
      { file: "other.json", acpSessionId: "ses_Y", agentCommand: "opencode acp" },
    ],
  }));

  const history = await readNativeSessionHistory({ agentSessionId: "ses_X", agentCommand: "opencode acp", sessionsDir: dir });
  expect(history).toEqual([{ role: "user", text: "hi" }]); // the non-empty source wins over the stub
});

test("readNativeSessionHistory returns [] when nothing matches or the dir is missing", async () => {
  expect(await readNativeSessionHistory({ agentSessionId: "nope", sessionsDir: "/no/such/dir" })).toEqual([]);
});
