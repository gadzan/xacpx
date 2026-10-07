import { expect, test } from "bun:test";
import { guardReadOnlyClientMessage, guardReadOnlyAgentMessage } from "../../../src/adapters/conversation-effect-policy";

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
test("permission approval never opens the read-only ceiling", () => {
  expect(guardReadOnlyAgentMessage(rpc("session/request_permission", { options: [{ optionId: "write", kind: "allow_always" }] })))
    .toMatchObject({ reply: { result: { outcome: { outcome: "cancelled" } } } });
  expect(guardReadOnlyAgentMessage(rpc("fs/read_text_file"))).toHaveProperty("forward");
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
