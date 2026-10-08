import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { guardReadOnlyClientMessage, guardReadOnlyAgentMessage, wrapReadOnlyAgentArgv } from "../../../src/adapters/conversation-effect-policy";

const rpc = (method: string, params: object = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
test("batched or malformed frames cannot bypass per-capability filtering", () => {
  for (const frame of [null, [], [rpc("session/new")], "raw", 42]) {
    expect(() => guardReadOnlyClientMessage(frame as never)).toThrow();
    expect(() => guardReadOnlyAgentMessage(frame as never)).toThrow();
  }
});
test("read-only ACP creation and load replace all caller capabilities with the pinned SDK ceiling", () => {
  for (const method of ["session/new", "session/load"]) {
    const decision = guardReadOnlyClientMessage(rpc(method, { cwd: "/workspace", sessionId: "old",
      mcpServers: [{ command: "evil" }], _meta: { claudeCode: { options: { tools: ["Bash"], hooks: { evil: true } } } } }));
    expect("forward" in decision).toBe(true);
    if (!("forward" in decision)) throw new Error("expected forwarding");
    const options = decision.forward.params._meta.claudeCode.options;
    expect(options.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(options.disallowedTools).toEqual(["mcp__*"]);
    expect(options.extraArgs).toEqual({ bare: null, "disable-slash-commands": null, restricted: null });
    expect(options.hooks).toBeUndefined();
    expect(decision.forward.params.mcpServers).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.allowDangerouslySkipPermissions).toBe(false);
  }
  expect(guardReadOnlyClientMessage(rpc("initialize", { clientCapabilities: { terminal: true, fs: { writeTextFile: true } } })))
    .toMatchObject({ forward: { params: { clientCapabilities: { terminal: false, fs: { writeTextFile: false } } } } });
});

for (const method of ["fs/write_text_file", "terminal/create", "terminal/output", "terminal/wait_for_exit",
  "terminal/kill", "terminal/release", "extension/execute", "elicitation/create"]) {
  test(`independent ACP capability ${method} cannot bypass the native tool ceiling`, () => {
    expect(guardReadOnlyAgentMessage(rpc(method))).toMatchObject({ reply: { id: 1, error: { code: -32601 } } });
  });
}
const forbiddenNotifications = ["fs/write_text_file", "terminal/create", "terminal/output", "terminal/wait_for_exit",
  "terminal/kill", "terminal/release", "session/request_permission", "extension/execute", "_custom/execute",
  "elicitation/create", "terminal/future_method"];
for (const method of forbiddenNotifications) {
  test("no-id Agent method " + method + " is dropped without a reply", () => {
    expect(guardReadOnlyAgentMessage({ jsonrpc: "2.0", method, params: { sessionId: "s1" } }))
      .toEqual({ drop: true });
  });
}

test("only supported Agent notifications are forwarded and RPC responses remain intact", () => {
  const update = { jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reading" } },
  }, _meta: { trace: "preserved" } };
  expect(guardReadOnlyAgentMessage(update)).toEqual({ forward: update });
  expect(guardReadOnlyAgentMessage({ jsonrpc: "2.0", method: "fs/read_text_file", params: { path: "/workspace/file.txt" } }))
    .toEqual({ drop: true });
  expect(guardReadOnlyAgentMessage(rpc("session/update", update.params))).toMatchObject({ reply: { id: 1, error: { code: -32601 } } });
  for (const response of [{ jsonrpc: "2.0", id: 0, result: { contents: "read" } },
    { jsonrpc: "2.0", id: "request", error: { code: -32000, message: "failed" } }]) {
    expect(guardReadOnlyAgentMessage(response)).toEqual({ forward: response });
  }
});

test("the guard process drops forbidden notifications without replying or blocking subsequent RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-policy-guard-"));
  const fixture = join(dir, "agent.mjs");
  writeFileSync(fixture, [
    'import { createInterface } from "node:readline";',
    'const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");',
    'const replies = [];',
    'const input = createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.method === "session/prompt") {',
    '    for (const method of ' + JSON.stringify([...forbiddenNotifications, "fs/read_text_file"]) + ') {',
    '      send({ method, params: { sessionId: "s1", path: "/workspace/file.txt", content: "modified" } });',
    '    }',
    '    send({ method: "session/update", params: { sessionId: "s1", update: {',
    '      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "read-only progress" }',
    '    } } });',
    '    send({ id: 11, method: "fs/write_text_file", params: {} });',
    '    send({ id: 12, method: "session/request_permission", params: { options: [] } });',
    '    send({ id: 13, method: "fs/read_text_file", params: { sessionId: "s1", path: "/workspace/file.txt" } });',
    '    send({ id: 14, method: "_custom/execute", params: {} });',
    '  } else {',
    '    replies.push(message);',
    '    if (replies.length === 4) send({ id: 100, result: { stopReason: "end_turn", replies } });',
    '  }',
    '});',
  ].join("\n"));
  const argv = wrapReadOnlyAgentArgv([process.execPath, fixture]);
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const messages: Array<Record<string, any>> = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.method === "fs/read_text_file" && message.id === 13) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 13, result: { content: "unchanged" } }) + "\n");
    }
    if (message.id === 100) child.stdin.end();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error("guard did not finish: " + stderr)); }, 5_000);
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error("guard exited " + code + ": " + stderr)));
      child.stdin.write(JSON.stringify({ ...rpc("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "read" }] }), id: 100 }) + "\n");
    });
    expect(messages.map(({ method, id }) => method ?? id)).toEqual(["session/update", "fs/read_text_file", 100]);
    const replies = messages.at(-1)!.result.replies as Array<Record<string, any>>;
    expect(replies).toHaveLength(4);
    expect(replies.find(({ id }) => id === 11)).toMatchObject({ error: { code: -32601 } });
    expect(replies.find(({ id }) => id === 12)).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    expect(replies.find(({ id }) => id === 13)).toMatchObject({ result: { content: "unchanged" } });
    expect(replies.find(({ id }) => id === 14)).toMatchObject({ error: { code: -32601 } });
    expect(stderr).toBe("");
  } finally {
    clearTimeout(timer); output.close(); child.kill(); rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

test("permission approval never opens the read-only ceiling", () => {
  expect(guardReadOnlyAgentMessage(rpc("session/request_permission", { options: [{ optionId: "write", kind: "allow_always" }] })))
    .toMatchObject({ reply: { result: { outcome: { outcome: "cancelled" } } } });
  expect(guardReadOnlyAgentMessage(rpc("fs/read_text_file"))).toHaveProperty("forward");
});
test("advertised capabilities route real acpx cold recovery through guarded load while retaining terminal evidence", () => {
  const decision = guardReadOnlyAgentMessage({ jsonrpc: "2.0", id: 1, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, fork: {}, subagents: {} },
      promptCapabilities: { image: true }, mcpCapabilities: { http: true }, providers: {} },
    authMethods: [{ id: "terminal-auth" }], _meta: { terminalEvidence: true },
  } });
  expect(decision).toMatchObject({ forward: { result: { agentCapabilities: { loadSession: true }, authMethods: [], _meta: { terminalEvidence: true } } } });
  if (!("forward" in decision)) throw new Error("expected initialize forwarding");
  expect(decision.forward.result.agentCapabilities.sessionCapabilities).toBeUndefined();
  expect(decision.forward.result.agentCapabilities.providers).toBeUndefined();
  expect(decision.forward.result.agentCapabilities.promptCapabilities.image).toBeUndefined();
});
for (const message of [rpc("session/set_mode", { modeId: "bypassPermissions" }),
  rpc("session/set_config_option", { configId: "mode", value: "acceptEdits" }),
  rpc("session/fork"), rpc("_custom/execute"),
  rpc("session/prompt", { prompt: [{ type: "text", text: "  /plugin install evil" }] }),
  rpc("session/prompt", { prompt: [{ type: "resource_link", uri: "file:///evil" }] })]) {
  test(`mode/command/extension escalation is blocked: ${JSON.stringify(message)}`, () => {
    expect(guardReadOnlyClientMessage(message)).toHaveProperty("reply");
  });
}
