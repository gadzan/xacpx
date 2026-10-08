import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ACP_OUTPUT_GUARD_TRUNCATION_MARKER, MAX_RAW_ACP_LINE_BYTES, SAFE_ACP_LINE_CHARS } from "../../../src/adapters/acp-output-guard";
import { wrapReadOnlyAgentArgv } from "../../../src/adapters/conversation-effect-policy";

type Rpc = Record<string, any>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const frame = (message: Rpc) => JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n";
const prompt = (text: string): Rpc => ({ id: 100, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text }] } });
const largeText = () => 'source 读🙂 "quoted" \\\n'.repeat(150_000) + "exact final suffix";

async function runGuard(agent: string, input: Iterable<string>, reply?: (message: Rpc) => Rpc | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-policy-io-"));
  // Verify the exact directory before recursive cleanup on Windows as well.
  const cleanupDir = resolve(dir);
  const fixture = join(dir, "agent.mjs");
  writeFileSync(fixture, [
    'import { createInterface } from "node:readline";',
    'import { createHash } from "node:crypto";',
    'const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");',
    'const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");',
    'createInterface({ input: process.stdin }).on("line", (line) => { const message = JSON.parse(line);',
    agent,
    '});',
  ].join("\n"));
  const argv = wrapReadOnlyAgentArgv([process.execPath, fixture]);
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const messages: Rpc[] = [], lines: string[] = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // Oversized input fails the guard and may close stdin before its writer ends.
  child.stdin.on("error", () => {});
  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    const message = JSON.parse(line); messages.push(message); lines.push(line);
    const response = reply?.(message);
    if (response) child.stdin.write(frame(response));
    if (message.id === 100) child.stdin.end();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = new Promise<number | null>((resolveClose, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error("guard did not finish: " + stderr)); }, 15_000);
      child.on("error", reject); child.on("close", resolveClose);
    });
    // Keep stdin open for file-read replies until the final prompt response.
    const writing = pipeline(Readable.from(input), child.stdin, { end: false }).catch((error: unknown) => error);
    const code = await closed; await writing;
    return { code, messages, lines, stderr };
  } finally {
    clearTimeout(timer); output.close(); child.kill();
    if (cleanupDir !== dir || !cleanupDir.startsWith(resolve(tmpdir()) + "\\") && !cleanupDir.startsWith(resolve(tmpdir()) + "/")) {
      throw new Error("unexpected guard fixture cleanup directory");
    }
    rmSync(cleanupDir, { recursive: true, force: true });
  }
}

test("read-only guard forwards a prompt above 2 MiB without truncating text or blocks", async () => {
  const request = prompt(largeText());
  request.params.prompt.push(...Array.from({ length: 70 }, (_, index) => ({ type: "text", text: `block-${index}` })));
  expect(frame(request).length).toBeGreaterThan(SAFE_ACP_LINE_CHARS);
  const result = await runGuard('send({ id: message.id, result: { digest: hash(message.params), blocks: message.params.prompt.length } });', [frame(request)]);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(result.messages).toEqual([{ jsonrpc: "2.0", id: 100, result: { digest: hash(request.params), blocks: 71 } }]);
}, 20_000);

test("read-only guard forwards an fs/read_text_file response above 2 MiB losslessly", async () => {
  const response = { jsonrpc: "2.0", id: "read-1", result: { content: largeText() }, _meta: { trace: "preserved" } };
  expect(frame(response).length).toBeGreaterThan(SAFE_ACP_LINE_CHARS);
  const result = await runGuard(`if (message.method === "session/prompt") {
    send({ id: "read-1", method: "fs/read_text_file", params: { sessionId: "s1", path: "/workspace/large.txt" } });
  } else { send({ id: 100, result: { digest: hash(message), contentLength: message.result.content.length } }); }`,
  [frame(prompt("read file"))], (message) => message.id === "read-1" ? response : undefined);
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  expect(result.messages.at(-1)).toEqual({ jsonrpc: "2.0", id: 100, result: { digest: hash(response), contentLength: response.result.content.length } });
}, 20_000);

test("read-only guard fails explicitly above the 64 MiB client frame ceiling", async () => {
  function* oversizedFrame() {
    yield '{"jsonrpc":"2.0","id":100,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"';
    const chunk = "x".repeat(1024 * 1024);
    for (let i = 0; i < MAX_RAW_ACP_LINE_BYTES / chunk.length + 1; i++) yield chunk;
    yield '"}]}}\n';
  }
  const result = await runGuard('send({ id: 100, result: { unexpected: true } });', oversizedFrame());
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`exceeded ${MAX_RAW_ACP_LINE_BYTES} bytes`);
  expect(result.messages).toEqual([]);
}, 20_000);

for (const kind of ["text", "tool"] as const) {
  test(`read-only guard retains Agent-to-Client ${kind} output bounding`, async () => {
    const text = "x".repeat(SAFE_ACP_LINE_CHARS + 1024);
    const update = kind === "text"
      ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
      : { sessionUpdate: "tool_call_update", toolCallId: "read", rawOutput: { stdout: text } };
    const result = await runGuard(`send({ method: "session/update", params: { sessionId: "s1", update: ${JSON.stringify(update)} } });
      send({ id: 100, result: { stopReason: "end_turn" } });`, [frame(prompt("read"))]);
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    expect(result.lines.every((line) => line.length <= SAFE_ACP_LINE_CHARS)).toBe(true);
    const updates = result.messages.filter((message) => message.method === "session/update");
    if (kind === "text") {
      expect(updates.length).toBeGreaterThan(1);
      expect(updates.map((message) => message.params.update.content.text).join("")).toBe(text);
    } else {
      expect(updates[0]!.params.update.rawOutput.stdout).toContain(ACP_OUTPUT_GUARD_TRUNCATION_MARKER);
    }
  }, 20_000);
}
