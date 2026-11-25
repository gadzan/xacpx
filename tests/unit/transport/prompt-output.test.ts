import { expect, test } from "bun:test";

import { getPromptText, normalizeCommandError } from "../../../src/transport/prompt-output";

function messageChunk(text: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function toolCall(title: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "abc",
      update: { sessionUpdate: "tool_call", title },
    },
  });
}

test("concatenates agent message chunks split by an interleaved tool call", () => {
  // Regression: a tool call mid-answer used to fragment the reply so only the
  // trailing fragment survived (delegated-worker resultText corruption).
  expect(
    getPromptText({
      code: 0,
      stdout: [
        messageChunk("I am opencode. Working directory: /repo.\nFiles: "),
        toolCall("List directory"),
        messageChunk("`AGENTS.md`, `README.md`, `package.json`."),
      ].join("\n"),
      stderr: "",
    }),
  ).toBe(
    "I am opencode. Working directory: /repo.\nFiles: `AGENTS.md`, `README.md`, `package.json`.",
  );
});

test("a non-JSON line in the stream does not truncate the agent message", () => {
  expect(
    getPromptText({
      code: 0,
      stdout: [
        messageChunk("Part one. "),
        "warning: some non-json log noise",
        messageChunk("Part two."),
      ].join("\n"),
      stderr: "",
    }),
  ).toBe("Part one. Part two.");
});

test("extracts the full agent reply when prompt exits non-zero without a structured error", () => {
  expect(
    getPromptText({
      code: 1,
      stdout: [
        messageChunk("先做检查。"),
        toolCall("Read file"),
        messageChunk("让我更新任务状态并继续执行测试验证。"),
      ].join("\n"),
      stderr: "",
    }),
  ).toBe("先做检查。让我更新任务状态并继续执行测试验证。");
});

test("prefers error.data.message over error.message when more specific", () => {
  const stdout = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    error: {
      code: -32603,
      message: "Internal error",
      data: {
        message: "stream disconnected before completion: error sending request for url (http://127.0.0.1:4010/responses)",
        codex_error_info: "other",
      },
    },
  });

  try {
    getPromptText({ code: 1, stdout, stderr: "" });
  } catch (err: any) {
    expect(err.message).toBe(
      "stream disconnected before completion: error sending request for url (http://127.0.0.1:4010/responses)",
    );
  }
});

test("uses error.message when error.data.message is identical", () => {
  const stdout = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -1, message: "Resource not found", data: { message: "Resource not found" } },
  });

  expect(normalizeCommandError({ stdout, stderr: "" })).toBe("Resource not found");
});

test("uses error.message when error.data.message is absent", () => {
  const stdout = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error" },
  });

  try {
    getPromptText({ code: 1, stdout, stderr: "" });
  } catch (err: any) {
    expect(err.message).toBe("Internal error");
  }
});

test("surfaces the ACP data.details reason instead of the generic message", () => {
  // omp reports the real cause in data.details while the outer message is a
  // blanket "Internal error". Only showing the outer one hides the answer.
  const stderr = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    error: {
      code: -32603,
      message: "Internal error",
      data: { details: "ACP session not found: 01a1aed8-579e-72a6-8047-bb2d1e6b47ee" },
    },
  });
  expect(normalizeCommandError({ stdout: "", stderr }))
    .toBe("ACP session not found: 01a1aed8-579e-72a6-8047-bb2d1e6b47ee");
});

test("keeps preferring data.message over data.details when both are present", () => {
  const stderr = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32602,
      message: "Internal error",
      data: { message: "Invalid params: cwd", details: "stack trace here" },
    },
  });
  expect(normalizeCommandError({ stdout: "", stderr })).toBe("Invalid params: cwd");
});

test("falls back to data.details when data.message is empty", () => {
  const stderr = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32603, message: "Internal error", data: { message: "", details: "agent crashed" } },
  });
  expect(normalizeCommandError({ stdout: "", stderr })).toBe("agent crashed");
});
