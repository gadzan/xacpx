import { expect, test } from "bun:test";
import type { MessageRecordDto, ToolStepDto } from "../../../../../packages/relay-protocol/src/index";
import { compactHistoryMessage } from "../../../../../packages/relay/src/http/compact-history";

const base: MessageRecordDto = {
  id: 1,
  instanceId: "i1",
  sessionAlias: "s",
  direction: "out",
  text: "done",
  createdAt: "t",
};

const readStep: ToolStepDto = {
  toolCallId: "t1",
  toolName: "Read",
  kind: "read",
  status: "success",
  title: "a.ts",
  detail: { type: "read", path: "a.ts", preview: "const x = 1;\n".repeat(40) },
};

test("leaves a text-only row unchanged", () => {
  expect(compactHistoryMessage(base)).toEqual(base);
});

test("leaves startedAt in place (compact must not drop the live-slot timestamp)", () => {
  const row: MessageRecordDto = { ...base, startedAt: 1_700_000_000_000 };
  expect(compactHistoryMessage(row).startedAt).toBe(1_700_000_000_000);
});

test("keeps startedAt when stripping heavy tool details", () => {
  const row: MessageRecordDto = {
    ...base,
    startedAt: 42,
    structured: {
      parts: [{ type: "tool", step: readStep }],
    },
  };
  const compact = compactHistoryMessage(row);
  expect(compact.startedAt).toBe(42);
  expect(compact.structured?.compact).toBe(true);
});

test("drops duplicate toolSteps when parts already carry them and strips heavy detail", () => {
  const row: MessageRecordDto = {
    ...base,
    structured: {
      toolSteps: [readStep],
      parts: [
        { type: "text", text: "done" },
        { type: "tool", step: readStep },
      ],
    },
  };
  const compact = compactHistoryMessage(row);
  expect(compact.structured?.compact).toBe(true);
  expect(compact.structured?.toolSteps).toBeUndefined();
  const tool = compact.structured?.parts?.find((p) => p.type === "tool");
  expect(tool?.type === "tool" ? tool.step.detail : undefined).toEqual({ type: "read", path: "a.ts" });
  expect(row.structured?.toolSteps?.[0]?.detail).toEqual(readStep.detail);
});

test("strips command output on legacy toolSteps-only rows", () => {
  const row: MessageRecordDto = {
    ...base,
    structured: {
      toolSteps: [{
        toolCallId: "t1",
        toolName: "Bash",
        kind: "execute",
        status: "success",
        title: "npm test",
        detail: { type: "command", command: "npm test", output: "passed\n".repeat(20), exitCode: 0 },
      }],
    },
  };
  const compact = compactHistoryMessage(row);
  expect(compact.structured?.compact).toBe(true);
  expect(compact.structured?.toolSteps?.[0]?.detail).toEqual({
    type: "command",
    command: "npm test",
    exitCode: 0,
  });
});

test("keeps a short subagent output snippet for the collapsed card", () => {
  const row: MessageRecordDto = {
    ...base,
    structured: {
      parts: [{
        type: "tool",
        step: {
          toolCallId: "agent",
          toolName: "Agent",
          kind: "other",
          status: "success",
          title: "explore",
          isSubagent: true,
          detail: {
            type: "text",
            text: "Search the repo",
            output: `${"x".repeat(300)}\nfinal report line`,
          },
        },
      }],
    },
  };
  const compact = compactHistoryMessage(row);
  expect(compact.structured?.compact).toBe(true);
  const tool = compact.structured?.parts?.[0];
  expect(tool?.type === "tool" ? tool.step.detail : undefined).toEqual({
    type: "text",
    text: "Search the repo",
    output: "final report line",
  });
});

test("does not mark compact when parts exist but there is no heavy detail", () => {
  const light: ToolStepDto = {
    toolCallId: "t1",
    toolName: "Read",
    kind: "read",
    status: "success",
    title: "a.ts",
  };
  const row: MessageRecordDto = {
    ...base,
    structured: {
      toolSteps: [light],
      parts: [{ type: "tool", step: light }],
    },
  };
  const compact = compactHistoryMessage(row);
  expect(compact.structured?.compact).toBeUndefined();
  expect(compact.structured?.toolSteps).toBeUndefined();
  expect(compact.structured?.parts).toEqual([{ type: "tool", step: light }]);
});
