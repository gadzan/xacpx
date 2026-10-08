import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { buildAcpAgentSpawnSpec, guardAcpStdoutLine, MAX_RAW_ACP_LINE_BYTES, pumpAcpStdout } from "./acp-output-guard";
import { guardReadOnlyAgentMessage, guardReadOnlyClientMessage } from "./conversation-effect-policy";

const separator = process.argv.indexOf("--");
const argv = separator < 0 ? process.argv.slice(2) : process.argv.slice(separator + 1);
if (!argv.length) throw new Error("missing restricted ACP agent argv");
const spec = buildAcpAgentSpawnSpec(argv);
// Never let an ambient executable override replace the pinned SDK runtime.
const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_SIMPLE: "1" };
for (const key of Object.keys(env)) if (key.toUpperCase() === "CLAUDE_CODE_EXECUTABLE") delete env[key];
const child = spawn(spec.command, spec.args, {
  stdio: ["pipe", "pipe", "pipe"], shell: spec.shell,
  windowsVerbatimArguments: spec.windowsVerbatimArguments, env,
});
let failed = false;
function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  process.stderr.write(`[xacpx-read-only] ${error instanceof Error ? error.message : String(error)}\n`);
  child.stdin.destroy();
  child.kill("SIGTERM");
  const forceKill = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
  forceKill.unref();
  process.exitCode = 1;
}
async function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await new Promise<void>((resolve) => stream.once("drain", resolve));
}
async function writeClientMessage(message: Record<string, unknown>): Promise<void> {
  for (const line of guardAcpStdoutLine(JSON.stringify(message))) {
    await writeLine(process.stdout, line);
  }
}
async function writeAgentMessage(message: Record<string, unknown>): Promise<void> {
  // Output bounding may truncate fields or arrays. Client input is execution
  // data: preserve all permitted contents after filtering, or fail explicitly.
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > MAX_RAW_ACP_LINE_BYTES) {
    throw new Error(`client-to-agent ACP frame exceeded ${MAX_RAW_ACP_LINE_BYTES} bytes after policy filtering`);
  }
  await writeLine(child.stdin, line);
}
const input = pumpAcpStdout(process.stdin, async (line) => {
  const decision = guardReadOnlyClientMessage(JSON.parse(line.toString("utf8")));
  if ("forward" in decision) await writeAgentMessage(decision.forward);
  else if ("reply" in decision && "id" in decision.reply && decision.reply.id !== undefined) await writeClientMessage(decision.reply);
}, MAX_RAW_ACP_LINE_BYTES).then(() => child.stdin.end()).catch(fail);
const output = pumpAcpStdout(child.stdout, async (line) => {
  const decision = guardReadOnlyAgentMessage(JSON.parse(line.toString("utf8")));
  if ("forward" in decision) await writeClientMessage(decision.forward);
  else if ("reply" in decision) await writeAgentMessage(decision.reply);
}, MAX_RAW_ACP_LINE_BYTES).catch(fail);
child.stderr.pipe(process.stderr);
child.stdin.on("error", fail);
child.on("error", fail);
child.on("close", (code, signal) => {
  void output.finally(() => {
    process.stdin.destroy();
    process.exitCode = failed ? 1 : signal ? 128 + (osConstants.signals[signal] ?? 0) : code ?? 1;
  });
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
void input;
