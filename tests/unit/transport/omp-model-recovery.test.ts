import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  modelRestoreFailure,
  OmpModelRecoveryError,
  recoverOmpSessionModel,
} from "../../../src/transport/omp-model-recovery";

// A real short-lived RPC fixture stands in for omp itself. resolveSpawnCommand
// turns the `.mjs` command into `node <script>`, so these tests drive the real
// spawn, framing, deadline, and termination paths instead of a mocked child
// process. Scenarios are selected per test through env.

const dir = mkdtempSync(join(tmpdir(), "xacpx-omp-model-recovery-"));
const fixture = join(dir, "omp-fixture.mjs");
const NATIVE_ID = "4f0f0a5e-1b7c-4a1d-9a55-2b3c4d5e6f70";
const SESSION_FILE = join(dir, "sessions", "2026-10-22T00-00-00-000Z_native.jsonl");
const SELECTED = "openai/gpt-5.2";

writeFileSync(fixture, [
  'import { appendFileSync, writeSync } from "node:fs";',
  'import { createInterface } from "node:readline";',
  "const scenario = process.env.SCENARIO ?? 'success';",
  "const log = process.env.LOG ?? '';",
  "const sessionFile = process.env.SESSION_FILE;",
  "const nativeId = process.env.NATIVE_ID;",
  "const selected = process.env.SELECTED_MODEL;",
  "const record = (value) => { if (log) appendFileSync(log, JSON.stringify(value) + '\\n'); };",
  "const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');",
  "record({ kind: 'argv', argv: process.argv.slice(2) });",
  "record({ kind: 'pid', pid: process.pid });",
  "if (scenario === 'early-exit') { writeSync(2, 'cannot open session file\\n'); process.exit(3); }",
  "if (scenario === 'chatter-before-ready') send({ type: 'available_commands_update', commands: [] });",
  "if (scenario !== 'silent') send({ type: 'ready' });",
  "if (scenario === 'malformed') process.stdout.write('not json\\n');",
  "const split = selected.indexOf('/');",
  "const provider = selected.slice(0, split);",
  "const id = selected.slice(split + 1);",
  "let switched = false;",
  "const firstState = () => {",
  "  const base = { sessionId: nativeId, sessionFile, messageCount: 5 };",
  "  if (scenario === 'malformed-state') return { sessionId: nativeId, model: { provider, id } };",
  "  if (scenario === 'wrong-id') return { ...base, sessionId: 'someone-else', model: { provider, id } };",
  "  if (scenario === 'invalid-model') return { ...base, model: { provider, id: 'gpt-4o' } };",
  "  return { ...base, model: { provider, id } };",
  "};",
  "const secondState = () => ({",
  "  sessionId: nativeId,",
  "  sessionFile: scenario === 'switch-new-file' ? sessionFile + '.other' : sessionFile,",
  "  model: { provider, id },",
  "  messageCount: scenario === 'message-count' ? 9 : 6,",
  "});",
  "const reply = (request, success, value) => send({ id: request.id, type: 'response', command: request.type, success, ...(success ? { data: value } : { error: value }) });",
  "createInterface({ input: process.stdin }).on('line', (line) => {",
  "  const request = JSON.parse(line);",
  "  record({ kind: 'frame', type: request.type });",
  "  if (request.type === 'get_state') { reply(request, true, switched ? secondState() : firstState()); return; }",
  "  if (request.type !== 'switch_session') { reply(request, false, 'unsupported fixture method'); return; }",
  "  record({ kind: 'switch', sessionPath: request.sessionPath, provider: request.provider, modelId: request.modelId });",
  "  if (scenario === 'switch-hang') return;",
  "  if (scenario === 'switch-fail') { reply(request, false, 'model unavailable'); return; }",
  "  if (scenario === 'switch-cancelled') { reply(request, true, { cancelled: true }); return; }",
  "  const expected = firstState().model;",
  "  if (request.sessionPath !== firstState().sessionFile || request.provider !== expected.provider || request.modelId !== expected.id) {",
  "    reply(request, false, 'fixture: switch did not echo the get_state identity');",
  "    return;",
  "  }",
  "  switched = true;",
  "  reply(request, true, {});",
  "});",
  "if (scenario === 'stubborn') {",
  "  // Ignore stdin EOF and SIGTERM: only SIGKILL can stop this child, so the",
  "  // helper's escalation path is exercised for real.",
  "  process.on('SIGTERM', () => { record({ kind: 'sigterm' }); });",
  "  process.stdin.on('close', () => { record({ kind: 'stdin-closed' }); });",
  "  setInterval(() => {}, 1000);",
  "} else {",
  "  process.stdin.on('close', () => process.exit(0));",
  "}",
].join("\n"));

const logs: string[] = [];

function newLog(): string {
  const file = join(dir, `log-${logs.length}.ndjson`);
  logs.push(file);
  return file;
}

interface FixtureLogEntry {
  kind: string;
  type?: string;
  pid?: number;
  argv?: string[];
  sessionPath?: string;
  provider?: string;
  modelId?: string;
}

// Fixture output is trusted test data written by the fixture above.
function readLog(file: string): FixtureLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixtureLogEntry);
}

// A pid that no longer exists cannot be signalled: this is the "the helper is
// gone" probe used after the stop escalation.
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Awaits the real condition (the pid disappears) instead of sleeping a fixed
// amount: the OS reaps the child shortly after it exits.
async function waitForProcessGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessRunning(pid);
}

interface RecoverTestInput {
  scenario?: string;
  modelId?: string;
  args?: string[];
  timeoutMs?: number;
  stopTimeoutMs?: number;
  log: string;
  agentSessionId?: string;
}

function recover(input: RecoverTestInput): Promise<void> {
  return recoverOmpSessionModel({
    command: fixture,
    args: input.args,
    cwd: dir,
    agentSessionId: input.agentSessionId ?? NATIVE_ID,
    modelId: input.modelId ?? SELECTED,
    env: {
      ...process.env,
      SCENARIO: input.scenario ?? "success",
      LOG: input.log,
      SESSION_FILE,
      NATIVE_ID,
      SELECTED_MODEL: SELECTED,
    },
    timeoutMs: input.timeoutMs ?? 10_000,
    stopTimeoutMs: input.stopTimeoutMs ?? 1_000,
  });
}

// Test seam that narrows a rejection so assertions never cast inline.
async function failureOf(promise: Promise<unknown>): Promise<OmpModelRecoveryError> {
  const outcome: unknown = await promise.then(() => undefined, (error: unknown) => error);
  if (!(outcome instanceof OmpModelRecoveryError)) {
    throw new Error(`expected OmpModelRecoveryError, got ${String(outcome)}`);
  }
  return outcome;
}

function recoverFailure(input: RecoverTestInput): Promise<OmpModelRecoveryError> {
  return failureOf(recover(input));
}

afterAll(() => {
  const cleanup = resolve(dir);
  if (!cleanup.startsWith(`${resolve(tmpdir())}/`) && !cleanup.startsWith(`${resolve(tmpdir())}\\`)) {
    throw new Error(`unexpected fixture cleanup directory: ${cleanup}`);
  }
  rmSync(cleanup, { recursive: true, force: true });
});

test("escalates to SIGKILL and leaves no helper process alive", async () => {
  const log = newLog();
  // The fixture ignores stdin EOF and SIGTERM, so only the SIGKILL step can
  // stop it. The stop budget is a real wall-clock bound (no fake timers can
  // advance a live child process).
  await recover({ scenario: "stubborn", log, stopTimeoutMs: 500 });

  const entries = readLog(log);
  const pid = entries.find((entry) => entry.kind === "pid")?.pid;
  if (typeof pid !== "number") throw new Error("fixture did not report its pid");
  // The child saw the graceful attempt and the SIGTERM, then the SIGKILL
  // escalation stopped it.
  expect(entries.some((entry) => entry.kind === "stdin-closed")).toBe(true);
  expect(entries.some((entry) => entry.kind === "sigterm")).toBe(true);
  expect(await waitForProcessGone(pid, 5_000)).toBe(true);
});

test("restores through get_state -> switch_session -> get_state and never prompts", async () => {
  const log = newLog();
  await recover({ log, args: ["--profile", "work"] });

  const entries = readLog(log);
  expect(entries.find((entry) => entry.kind === "argv")).toEqual({
    kind: "argv",
    argv: [
      "--profile", "work",
      "--resume", NATIVE_ID,
      "--model", SELECTED,
      "--mode", "rpc",
      "--no-ui", "--no-title", "--no-lsp",
    ],
  });
  // The switch identity comes from get_state, not from splitting the selector.
  expect(entries.find((entry) => entry.kind === "switch")).toEqual({
    kind: "switch",
    sessionPath: SESSION_FILE,
    provider: "openai",
    modelId: "gpt-5.2",
  });
  const frames = entries.filter((entry) => entry.kind === "frame").map((entry) => entry.type);
  expect(frames).toEqual(["get_state", "switch_session", "get_state"]);
  expect(frames).not.toContain("prompt");
});

test("refuses a --resume that landed on a different native session", async () => {
  const log = newLog();
  const error = await recoverFailure({ scenario: "wrong-id", log });
  expect(error.message).toContain("resumed a different native session");
  expect(error.nativeModelSaved).toBe(false);
  expect(readLog(log).some((entry) => entry.kind === "switch")).toBe(false);
});

test("refuses to switch when the resumed native model is not the selected model", async () => {
  const log = newLog();
  const error = await recoverFailure({ scenario: "invalid-model", log });
  expect(error.message).toContain("native model mismatch");
  expect(error.message).toContain("openai/gpt-4o");
  expect(readLog(log).some((entry) => entry.kind === "switch")).toBe(false);
});

test("reports a rejected switch as an unknown native state, not a confirmed save", async () => {
  const error = await recoverFailure({ scenario: "switch-fail", log: newLog() });
  expect(error.message).toContain("switch_session failed: model unavailable");
  // OMP can persist the model_change and only then fail the switch, so the
  // native state is UNKNOWN: never claim it was saved, never claim rollback.
  expect(error.nativeModelSaved).toBe(false);
  expect(error.message).toContain("may already have been saved");
  expect(error.message).not.toContain("rolled back");
});

test("treats a cancelled switch response as a failure, not a save", async () => {
  const error = await recoverFailure({ scenario: "switch-cancelled", log: newLog() });
  expect(error.message).toContain("cancelled");
  // A cancelled switch is rejected before the model change is applied.
  expect(error.nativeModelSaved).toBe(false);
  expect(error.message).not.toContain("may already have been saved");
});

test("a lost switch acknowledgement says the model may already be saved", async () => {
  const log = newLog();
  // A real child process cannot be advanced by fake timers; the deadline must
  // still comfortably outlast node startup + ready + get_state under CI load.
  // The test's own timeout must exceed the helper deadline below, or bun test
  // kills the test before the helper's 5s bound fires.
  const error = await recoverFailure({ scenario: "switch-hang", log, timeoutMs: 5_000 });
  expect(error.nativeModelSaved).toBe(false);
  expect(error.message).toContain("may already have been saved");
  expect(error.message).not.toContain("rolled back");
  // The switch really was written before the deadline expired.
  expect(readLog(log).some((entry) => entry.kind === "switch")).toBe(true);
}, { timeout: 15_000 });

test("verifies the same session file after the switch and flags a changed one as saved", async () => {
  const error = await recoverFailure({ scenario: "switch-new-file", log: newLog() });
  expect(error.message).toContain("unexpected native session");
  expect(error.nativeModelSaved).toBe(true);
});

test("rejects a switch that produced new messages instead of a clean restore", async () => {
  const error = await recoverFailure({ scenario: "message-count", log: newLog() });
  expect(error.message).toContain("new messages during the switch");
  expect(error.nativeModelSaved).toBe(true);
});

test("bounds the whole helper by timeoutMs before the switch is ever attempted", async () => {
  const log = newLog();
  const error = await recoverFailure({ scenario: "silent", log, timeoutMs: 1_000 });
  expect(error.message).toContain("timed out after 1000ms");
  expect(error.message).not.toContain("may already have been saved");
  expect(readLog(log).some((entry) => entry.kind === "switch")).toBe(false);
});

test("surfaces early exits with stderr instead of hanging", async () => {
  const error = await recoverFailure({ scenario: "early-exit", log: newLog() });
  expect(error.message).toContain("exited early (code 3)");
  expect(error.message).toContain("cannot open session file");
  expect(error.nativeModelSaved).toBe(false);
});

test("rejects malformed RPC frames", async () => {
  const error = await recoverFailure({ scenario: "malformed", log: newLog() });
  expect(error.message).toContain("malformed RPC frame");
});

test("ignores unrelated frames while waiting for the ready frame and states", async () => {
  const log = newLog();
  await recover({ scenario: "chatter-before-ready", log });
  expect(readLog(log).filter((entry) => entry.kind === "switch")).toHaveLength(1);
});

test("rejects a get_state payload without the native identity fields", async () => {
  const log = newLog();
  const error = await recoverFailure({ scenario: "malformed-state", log });
  expect(error.message).toContain("malformed get_state before switch");
  expect(readLog(log).some((entry) => entry.kind === "switch")).toBe(false);
});

test("fails when the helper executable cannot be spawned", async () => {
  const error = await failureOf(recoverOmpSessionModel({
    command: "xacpx-omp-binary-that-does-not-exist",
    cwd: dir,
    agentSessionId: NATIVE_ID,
    modelId: SELECTED,
    timeoutMs: 5_000,
  }));
  expect(error.message).toContain("failed to spawn");
  expect(error.nativeModelSaved).toBe(false);
});

test("validates the request before spawning anything", async () => {
  for (const modelId of ["gpt-5.2", "openai/", "/gpt-5.2", ""]) {
    const error = await recoverFailure({ modelId, log: newLog() });
    expect(error.message).toContain("invalid request");
    expect(error.requestedModelId).toBe(modelId);
  }
  const error = await failureOf(recoverOmpSessionModel({
    command: fixture,
    cwd: dir,
    agentSessionId: NATIVE_ID,
    modelId: SELECTED,
    timeoutMs: 0,
  }));
  expect(error.message).toContain("invalid timeoutMs");
});

test("modelRestoreFailure matches only the exact OMP restore failure", () => {
  expect(modelRestoreFailure(new Error("Could not restore model openai/gpt-5.2"))).toEqual({ modelId: "openai/gpt-5.2" });
  expect(modelRestoreFailure("Could not restore model anthropic/claude-opus-4-8.")).toEqual({ modelId: "anthropic/claude-opus-4-8" });
  // acpx wraps the failure in a cause chain.
  expect(modelRestoreFailure(new Error("RUNTIME_INIT_FAILED", { cause: new Error("Could not restore model openai/gpt-5.2") })))
    .toEqual({ modelId: "openai/gpt-5.2" });
  // PromptCommandError keeps the native failure beside a generic message.
  expect(modelRestoreFailure(Object.assign(new Error("command failed with exit code 1"), {
    stderr: "Could not restore model openai/gpt-5.2",
  }))).toEqual({ modelId: "openai/gpt-5.2" });
  // acpx-style result objects keep the native failure on stderr.
  expect(modelRestoreFailure({ code: 1, stdout: "", stderr: "Could not restore model openai/gpt-5.2\n" }))
    .toEqual({ modelId: "openai/gpt-5.2" });
  // omp crash output mixes source excerpts (with the throw's template literal)
  // on stdout with the real failure line on stderr; the real id wins.
  expect(modelRestoreFailure(new Error([
    "omp rpc exited while waiting for the ready frame: 26903 |",
    "      throw new Error(`Could not restore model ${vr[0]}`);",
    "error: Could not restore model magpie/group/auto-deepseek-v4-1-flash",
  ].join("\n")))).toEqual({ modelId: "magpie/group/auto-deepseek-v4-1-flash" });
  // An earlier fallback excerpt line must not suppress a real failure on the
  // last line: the exclusion is per-candidate, never whole-text.
  expect(modelRestoreFailure(new Error([
    "Could not restore model openai/gpt-5.2. Using anthropic/other",
    "error: Could not restore model magpie/group/auto-deepseek-v4-1-flash",
  ].join("\n")))).toEqual({ modelId: "magpie/group/auto-deepseek-v4-1-flash" });
  expect(modelRestoreFailure(new Error("Could not restore model openai/gpt-5.2. Using anthropic/claude-opus-4-8"))).toBeUndefined();
  // Other model failures are not this failure.
  expect(modelRestoreFailure(new Error("Model not found: openai/gpt-5.2"))).toBeUndefined();
  expect(modelRestoreFailure(new Error('Cannot apply --model "gpt-5.2": the ACP agent did not advertise that model.'))).toBeUndefined();
  expect(modelRestoreFailure(new Error("Could not restore model "))).toBeUndefined();
  expect(modelRestoreFailure(undefined)).toBeUndefined();
  expect(modelRestoreFailure({})).toBeUndefined();
});
