import { BridgeRuntime } from "../../../../src/bridge/bridge-runtime";
import type { NonInteractivePermissions, PermissionMode } from "../../../../src/config/types";

// ---------------------------------------------------------------------------
// Bridge argv-capture oracle harness.
//
// Mirror of the CLI oracle for BridgeRuntime. Records the exact argv the runtime
// hands to each injected runner seam (`run`, `runSessionCreate`, `runPromptCommand`),
// in call order, plus the driven method's outcome. Byte-identical equivalence guard
// for the shared command-builder extraction.
//
// Bridge public methods take a structural `{ agent, agentCommand?, cwd, name, model? }`
// input rather than a ResolvedSession, so the seed helper produces that shape.
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface CommandRunnerOptions {
  onStderrLine?: (line: string) => void;
  timeoutMs?: number;
}

export interface BridgeArgvOracleOptions {
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  queueOwnerTtlSeconds?: number;
  sessionInitTimeoutMs?: number;
  managementCommandTimeoutMs?: number;
  now?: () => number;
}

export interface BridgeSessionInput {
  agent: string;
  agentCommand?: string;
  cwd: string;
  name: string;
  model?: string;
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

/** Neutral bridge session input; overrides tailor per-scenario axes. */
export function makeBridgeInput(overrides: Partial<BridgeSessionInput> = {}): BridgeSessionInput {
  return {
    agent: "codex",
    cwd: "/tmp/backend",
    name: "backend:demo",
    ...overrides,
  };
}

export interface BridgeArgvOracleScenario {
  name: string;
  options?: BridgeArgvOracleOptions;
  // FIFO queue of canned results; each seam call shifts the next (default
  // `{ code: 0, stdout: "", stderr: "" }` when the queue is empty).
  results?: CommandResult[];
  run: (runtime: BridgeRuntime) => Promise<unknown>;
}

export async function runBridgeArgvOracle(
  scenario: BridgeArgvOracleScenario,
): Promise<{ record: string[]; outcome: unknown }> {
  const record: string[] = [];
  const results = [...(scenario.results ?? [])];
  const nextResult = (): CommandResult => results.shift() ?? { code: 0, stdout: "", stderr: "" };

  const run = async (command: string, args: string[], options?: CommandRunnerOptions): Promise<CommandResult> => {
    record.push(`run(${renderArgv(command, args, options?.timeoutMs)})`);
    return nextResult();
  };
  // runSessionCreate additionally receives the child cwd; record it (it is the
  // session input's cwd, behaviourally load-bearing for the create spawn).
  const runSessionCreate = async (
    command: string,
    args: string[],
    cwd: string,
    options?: CommandRunnerOptions,
  ): Promise<CommandResult> => {
    record.push(`runSessionCreate(${renderArgv(command, args, options?.timeoutMs)} cwd=${scrub(cwd)})`);
    return nextResult();
  };
  const runPromptCommand = async (command: string, args: string[]): Promise<CommandResult> => {
    record.push(`runPromptCommand(${renderArgv(command, args)})`);
    return nextResult();
  };
  const repairSessionIndex = async () => false;
  const queueOwnerLauncher = { launch: async () => {} };

  // Freeze the wall clock: the ensure path's shared deadline uses options.now
  // (passed here) and tailSessionHistory subtracts a `Date.now()` deadline
  // per candidate — freezing both makes every derived timeout byte-stable.
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  const options: BridgeArgvOracleOptions = { now: () => 1_000_000, ...scenario.options };

  const runtime = new BridgeRuntime(
    "acpx",
    run,
    runSessionCreate,
    options,
    runPromptCommand as never,
    repairSessionIndex,
    queueOwnerLauncher,
  );

  let outcome: unknown;
  try {
    outcome = { ok: await scenario.run(runtime) };
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
