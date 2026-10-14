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

function record(acpxRecordId: string, acpSessionId: string, messages: unknown[]): string {
  return JSON.stringify({
    schema: "acpx.session.v1",
    acpx_record_id: acpxRecordId,
    acp_session_id: acpSessionId,
    agent_command: "opencode acp",
    cwd: "C:\\ws",
    name: "demo",
    created_at: "2026-10-01T00:00:00Z",
    last_used_at: "2026-10-02T00:00:00Z",
    last_seq: messages.length,
    updated_at: "2026-10-02T00:00:00Z",
    messages,
  });
}

test("readNativeSessionHistory discovers records by canonical scan without an index, picking the richest match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acpx-sessions-"));
  // Two records share the acp_session_id: the empty fresh attach stub + the real source.
  writeFileSync(join(dir, "stub.json"), record("stub", "ses_X", []));
  writeFileSync(join(dir, "src.json"), record("src", "ses_X", [{ User: { id: "u", content: [{ Text: "hi" }] } }]));

  const history = await readNativeSessionHistory({ agentSessionId: "ses_X", sessionsDir: dir });
  expect(history).toEqual([{ role: "user", text: "hi" }]); // the non-empty source wins over the stub
});

test("readNativeSessionHistory reports a diagnostic when nothing matches or the directory is unreadable", async () => {
  const diagnostics: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "acpx-sessions-"));
  writeFileSync(join(dir, "src.json"), record("src", "ses_X", [{ User: { id: "u", content: [{ Text: "hi" }] } }]));

  expect(await readNativeSessionHistory({
    agentSessionId: "ses_missing",
    sessionsDir: dir,
    onDiagnostic: (d) => diagnostics.push(d),
  })).toEqual([]);
  expect(diagnostics).toEqual([expect.stringContaining("no acpx record matches")]);

  diagnostics.length = 0;
  // A regular file is not a readable sessions directory (ENOTDIR) — the failure
  // MUST be observable, never silently identical to "no history".
  expect(await readNativeSessionHistory({
    agentSessionId: "ses_X",
    sessionsDir: join(dir, "src.json"),
    onDiagnostic: (d) => diagnostics.push(d),
  })).toEqual([]);
  expect(diagnostics.some((d) => d.includes("cannot read sessions directory"))).toBe(true);
  // The follow-on no-match line still reports the scan truth (0 records).
  expect(diagnostics.some((d) => d.includes("(0 record(s) scanned)"))).toBe(true);
});
