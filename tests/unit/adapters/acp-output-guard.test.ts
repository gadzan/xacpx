import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  ACP_OUTPUT_GUARD_TRUNCATION_MARKER,
  AcpOutputGuardError,
  SAFE_ACP_LINE_CHARS,
  buildAcpAgentSpawnSpec,
  guardAcpStdoutLine,
  pumpAcpStdout,
  resolveAcpOutputGuardEntry,
} from "../../../src/adapters/acp-output-guard";

function sessionUpdate(update: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update,
    },
  });
}

function parsedLines(lines: string[]): Array<Record<string, any>> {
  return lines.map((line) => JSON.parse(line) as Record<string, any>);
}

test("small ACP stdout lines are passed through byte-for-byte as strings", () => {
  const line = '{"jsonrpc":"2.0","method":"session/update","params":{}}';

  expect(guardAcpStdoutLine(line)).toEqual([line]);
  expect(guardAcpStdoutLine("adapter diagnostic")).toEqual(["adapter diagnostic"]);
});

test("the bundled launch identity points at the published adapters entry", () => {
  const moduleUrl = process.platform === "win32"
    ? "file:///C:/opt/xacpx/dist/cli.js"
    : "file:///opt/xacpx/dist/cli.js";
  const expected = process.platform === "win32"
    ? "C:\\opt\\xacpx\\dist\\adapters\\acp-output-guard-main.js"
    : "/opt/xacpx/dist/adapters/acp-output-guard-main.js";
  expect(resolveAcpOutputGuardEntry(moduleUrl)).toBe(expected);
});

test("oversized agent messages are split without losing text or metadata", () => {
  const text = "x".repeat(15 * 1024 * 1024);
  const line = sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "message-1",
    content: { type: "text", text },
    _meta: { provider: "test" },
  });

  const output = guardAcpStdoutLine(line);
  const messages = parsedLines(output);
  const pieces = messages.map((message) => message.params.update.content.text).join("");

  expect(output.length).toBeGreaterThan(1);
  expect(pieces).toBe(text);
  expect(messages.every((message) => JSON.stringify(message).length <= SAFE_ACP_LINE_CHARS)).toBe(true);
  expect(messages.every((message) => message.params.update.messageId === "message-1")).toBe(true);
  expect(messages.every((message) => message.params.update._meta.provider === "test")).toBe(true);
});

test("text splitting never cuts a surrogate pair", () => {
  const text = "a😀b😀c";
  const line = sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  });

  const output = guardAcpStdoutLine(line, { safeSerializedLimit: 256, textChunkChars: 3 });
  const messages = parsedLines(output);

  expect(messages.map((message) => message.params.update.content.text).join("")).toBe(text);
  expect(output.join("\n")).not.toContain("�");
});

test("oversized tool payloads retain metadata and bound raw output and meta", () => {
  const outputText = "head\n" + "o".repeat(20 * 1024 * 1024) + "\nTAIL-MARKER";
  const line = sessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    parentToolCallId: "parent-1",
    status: "completed",
    kind: "execute",
    title: "Run command",
    locations: [{ path: "src/main.ts" }],
    rawOutput: { stdout: outputText },
    _meta: {
      claudeCode: { toolName: "Bash", toolResponse: "m".repeat(20 * 1024 * 1024) },
      routing: "keep-me",
    },
  });

  const output = guardAcpStdoutLine(line);
  const message = parsedLines(output)[0]!;
  const update = message.params.update;

  expect(output).toHaveLength(1);
  expect(JSON.stringify(message).length).toBeLessThanOrEqual(SAFE_ACP_LINE_CHARS);
  expect(update).toMatchObject({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    parentToolCallId: "parent-1",
    status: "completed",
    kind: "execute",
    title: "Run command",
  });
  expect(update.locations).toEqual([{ path: "src/main.ts" }]);
  expect(update.rawOutput.stdout).toContain("TAIL-MARKER");
  expect(update.rawOutput.stdout).toContain(ACP_OUTPUT_GUARD_TRUNCATION_MARKER);
  expect(update._meta.claudeCode.toolResponse.length).toBeLessThanOrEqual(64 * 1024);
  expect(update._meta.routing).toBe("keep-me");
});

test("deeply nested and wide payloads are bounded without overflowing the stack", () => {
  let nested: unknown = "payload";
  for (let index = 0; index < 150; index += 1) {
    nested = { [`level-${index}`]: nested };
  }
  const wide = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key-${index}`, "x".repeat(100)]));
  const output = guardAcpStdoutLine(sessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tool-2",
    rawInput: { nested, wide },
  }));

  expect(output).toHaveLength(1);
  expect(JSON.stringify(JSON.parse(output[0]!)).length).toBeLessThanOrEqual(SAFE_ACP_LINE_CHARS);
});

test("oversized non-JSON stdout fails closed instead of forwarding it", () => {
  expect(() => guardAcpStdoutLine("x".repeat(SAFE_ACP_LINE_CHARS + 1))).toThrow(AcpOutputGuardError);
});

test("stdio guard handles arbitrary child chunking and preserves exit status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-output-guard-test-"));
  try {
    const stubPath = join(dir, "stub-agent.js");
    writeFileSync(stubPath, `
      process.stdin.on("data", () => {
        const text = "x".repeat(12 * 1024 * 1024);
        const oversized = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        for (let i = 0; i < oversized.length; i += 17) process.stdout.write(oversized.slice(i, i + 17));
        process.stdout.write("\\n");
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } }) + "\\n");
        process.exit(0);
      });
    `);

    const guardEntry = join(process.cwd(), "src/adapters/acp-output-guard-main.ts");
    const child = spawn(process.execPath, [guardEntry, "--", process.execPath, stubPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write('{"jsonrpc":"2.0","id":0,"method":"prompt","params":{}}\n');
    child.stdin.end();

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const messages = parsedLines(result.stdout.trim().split("\n"));
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.slice(0, -1).map((message) => message.params.update.content.text).join("")).toBe("x".repeat(12 * 1024 * 1024));
    expect(messages.at(-1)?.params.update.content.text).toBe("done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("stdio pumping does not pull the next child chunk until the downstream write settles", async () => {
  const first = Buffer.from('{"jsonrpc":"2.0","id":1}\n');
  const second = Buffer.from('{"jsonrpc":"2.0","id":2}\n');
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writes: Buffer[] = [];
  let yielded = 0;

  async function* source(): AsyncGenerator<Buffer> {
    yielded += 1;
    yield first;
    yielded += 1;
    yield second;
  }

  const pumping = pumpAcpStdout(source(), async (line) => {
    writes.push(line);
    if (writes.length === 1) await firstWrite;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(writes).toHaveLength(1);
  expect(yielded).toBe(1);
  releaseFirst();
  await pumping;
  expect(writes).toHaveLength(2);
  expect(yielded).toBe(2);
});

test("Windows real executables keep exact argv while cmd launchers use an explicit cmd boundary", () => {
  const executable = buildAcpAgentSpawnSpec(
    ["C:\\Program Files\\agent.exe", "--arg", "a&b", "(quoted)"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );
  expect(executable).toEqual({
    command: "C:\\Program Files\\agent.exe",
    args: ["--arg", "a&b", "(quoted)"],
    shell: false,
  });

  const launcher = buildAcpAgentSpawnSpec(
    ["C:\\Program Files\\agent.cmd", "--arg", "a&b", "(quoted)"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );
  expect(launcher.command).toBe("C:\\Windows\\System32\\cmd.exe");
  expect(launcher.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
  expect(launcher.shell).toBe(false);
  expect(launcher.windowsVerbatimArguments).toBe(true);
  expect(launcher.args[4]).toBe('""C:\\Program Files\\agent.cmd" "--arg" "a&b" "(quoted)""');
});

test("Windows resolves bare PATH commands through PATHEXT before choosing the launcher", () => {
  const launcher = buildAcpAgentSpawnSpec(
    ["opencode", "acp"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
    { PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD;.BAT;.COM" },
    (path) => path === "C:\\Tools\\opencode.CMD",
  );

  expect(launcher).toEqual({
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", '""C:\\Tools\\opencode.CMD" "acp""'],
    shell: false,
    windowsVerbatimArguments: true,
  });

  const npxLauncher = buildAcpAgentSpawnSpec(
    ["npx", "-y", "@agentclientprotocol/codex-acp@1.1.9"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
    { PATH: "C:\\Node", PATHEXT: ".EXE;.CMD;.BAT;.COM" },
    (path) => path === "C:\\Node\\npx.CMD",
  );
  expect(npxLauncher).toEqual({
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", '""C:\\Node\\npx.CMD" "-y" "@agentclientprotocol/codex-acp@1.1.9""'],
    shell: false,
    windowsVerbatimArguments: true,
  });
});

test("Windows cmd launchers preserve percent, embedded quotes, and exclamation marks", () => {
  const launcher = buildAcpAgentSpawnSpec(
    ["C:\\Program Files\\agent.cmd", "--pattern", "%PATH%", 'a"b', "!value!"],
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
  );

  expect(launcher.args).toEqual([
    "/d",
    "/v:off",
    "/s",
    "/c",
    '""C:\\Program Files\\agent.cmd" "--pattern" "^%PATH^%" "a""b" "!value!""',
  ]);
});

test("Windows bare .cmd PATH launchers round-trip argv through the real cmd boundary", async () => {
  if (process.platform !== "win32") return;

  const dir = mkdtempSync(join(tmpdir(), "acp-output-guard-win-"));
  try {
    const argvProbe = join(dir, "argv-probe.cjs");
    const launcher = join(dir, "fake-agent.cmd");
    writeFileSync(argvProbe, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "%~dp0argv-probe.cjs" %*\r\n`);
    const env = {
      ...process.env,
      PATH: dir,
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    };
    const spec = buildAcpAgentSpawnSpec(
      ["fake-agent", "a&b", "(quoted)", "%PATH%", 'a"b', "!value!"],
      "win32",
      env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      env,
    );
    const child = spawn(spec.command, spec.args, { shell: false, env, stdio: ["ignore", "pipe", "pipe"] });
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`probe exited ${code}: ${stderr}`)));
    });
    expect(JSON.parse(output)).toEqual(["a&b", "(quoted)", "%PATH%", 'a"b', "!value!"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
