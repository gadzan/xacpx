import { AcpxCliTransport } from "../../../../src/transport/acpx-cli/acpx-cli-transport";
import type { NonInteractivePermissions, PermissionMode } from "../../../../src/config/types";
import type { ResolvedSession } from "../../../../src/transport/types";

// ---------------------------------------------------------------------------
// CLI argv-capture oracle harness.
//
// Black-box characterization of the *exact command-line argv* the AcpxCliTransport
// hands to each of its injected runner seams, in call order, plus the driven
// method's return/throw. The record is the equivalence guard for the upcoming
// command-builder extraction: later tasks must keep these fixtures byte-identical.
//
// Recording model: ONE ordered `string[]`. Each seam, when called, appends
// `seam(command arg arg … @timeoutMs)` with every arg rendered VERBATIM — argv is
// behaviourally load-bearing, so it is never collapsed/summarized. The only
// nondeterminism scrubbed is ISO timestamps, `reset-<epoch>` (defensive), and the
// machine-varying structured-prompt temp file path (`…/xacpx-acp-prompt-*/prompt.json`),
// which is not builder logic — only the presence/position of `--file` is.
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

// The transport's runner seams share this options shape (timeoutMs is the only
// field that lands in the record; `signal` is nondeterministic noise).
interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Minimal fake of the streaming child process the transport's `spawnPrompt` hook
// must return. It captures the stdout/close handlers the transport registers,
// then (after registration completes) emits the canned stdout and closes with the
// canned exit code so `prompt` resolves without a real child process.
interface PromptStreamProcess {
  stdout: {
    setEncoding: (encoding: string) => void;
    on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
  };
  stderr: {
    on: (event: "data", handler: (chunk: string | Buffer) => void) => void;
  };
  on: {
    (event: "error", handler: (error: Error) => void): void;
    (event: "close", handler: (code: number | null) => void): void;
  };
}

// The subset of AcpxCliTransport constructor options a scenario may stage.
export interface CliArgvOracleOptions {
  command?: string;
  sessionInitTimeoutMs?: number;
  managementCommandTimeoutMs?: number;
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  queueOwnerTtlSeconds?: number;
}

function scrub(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>")
    .replace(/reset-\d+/g, "reset-<n>")
    // The structured-prompt file lives in a random mkdtemp dir; only `--file`'s
    // presence/position is builder logic, so collapse the machine-varying path.
    .replace(/\S*xacpx-acp-prompt-\S*/g, "<prompt-file>");
}

function renderArgv(command: string, args: string[], timeoutMs?: number): string {
  const t = timeoutMs === undefined ? "" : ` @${timeoutMs}`;
  return `${scrub(command)} ${args.map((a) => scrub(String(a))).join(" ")}${t}`;
}

// A fake streaming child: emit the canned stdout, then close, after the transport
// has finished registering its handlers (deferred via setImmediate).
function makeFakeStream(stdout: string, code: number): PromptStreamProcess {
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  let closeHandler: ((code: number | null) => void) | undefined;
  return {
    stdout: {
      setEncoding: () => {},
      on: (_event, handler) => {
        dataHandler = handler;
      },
    },
    stderr: { on: () => {} },
    on: ((event: string, handler: (arg: never) => void) => {
      // Registration order in runStreamingPrompt: stdout.on("data") precedes
      // on("close"), so the data handler is set by the time close registers.
      if (event === "close") {
        closeHandler = handler as unknown as (c: number | null) => void;
        setImmediate(() => {
          if (stdout.length > 0) dataHandler?.(stdout);
          closeHandler?.(code);
        });
      }
    }) as PromptStreamProcess["on"],
  };
}

/** Neutral ResolvedSession seed; overrides tailor per-scenario axes. */
export function makeCliSession(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    alias: "demo",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:demo",
    cwd: "/tmp/backend",
    ...overrides,
  };
}

export interface CliArgvOracleScenario {
  name: string;
  options?: CliArgvOracleOptions;
  // FIFO queue of canned results; each seam call shifts the next (default
  // `{ code: 0, stdout: "", stderr: "" }` when the queue is empty).
  results?: CommandResult[];
  run: (transport: AcpxCliTransport) => Promise<unknown>;
}

export async function runCliArgvOracle(
  scenario: CliArgvOracleScenario,
): Promise<{ record: string[]; outcome: unknown }> {
  const record: string[] = [];
  const results = [...(scenario.results ?? [])];
  const nextResult = (): CommandResult => results.shift() ?? { code: 0, stdout: "", stderr: "" };

  const runCommand = async (command: string, args: string[], options?: RunOptions): Promise<CommandResult> => {
    record.push(`runCommand(${renderArgv(command, args, options?.timeoutMs)})`);
    return nextResult();
  };
  const runPtyCommand = async (command: string, args: string[], options?: RunOptions): Promise<CommandResult> => {
    record.push(`runPty(${renderArgv(command, args, options?.timeoutMs)})`);
    return nextResult();
  };
  const spawnPrompt = (command: string, args: string[]): PromptStreamProcess => {
    record.push(`spawnPrompt(${renderArgv(command, args)})`);
    const result = nextResult();
    return makeFakeStream(result.stdout, result.code);
  };
  const queueOwnerLauncher = { launch: async () => {} };

  const transport = new AcpxCliTransport(
    scenario.options ?? {},
    runCommand,
    runPtyCommand,
    queueOwnerLauncher,
    { spawnPrompt },
  );

  // Freeze the wall clock so any `Date.now()`-derived timeout (tailSessionHistory
  // subtracts a shared deadline per candidate) is byte-stable across runs.
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  let outcome: unknown;
  try {
    outcome = { ok: await scenario.run(transport) };
  } catch (err) {
    outcome = { threw: err instanceof Error ? err.message : String(err) };
  } finally {
    Date.now = realNow;
  }
  return { record, outcome: normalize(outcome) };
}

function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, val) =>
      typeof val === "string" ? val.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>") : val,
    ),
  );
}
