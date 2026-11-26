// ---------------------------------------------------------------------------
// Cross-lane argv parity oracle.
//
// The CLI and bridge lanes each have their own argv-capture oracle
// (`cli-argv-oracle-harness.ts` / `bridge-argv-oracle-harness.ts`) pinning their
// fixtures. Those guards are per-lane: nothing stops one lane's argv from
// drifting while its own fixture is regenerated without anyone noticing the
// other lane kept the old shape. This test closes that hole for the paths the
// spawn/session-op unification has already touched (Phase 1 spawn primitives +
// Phase 2a queue-owner / effort / cleanup / probe orchestration): the same
// scenario runs through BOTH oracles and the normalized records must match, so
// one-sided drift reddens here immediately.
//
// Normalization keeps everything load-bearing and drops only per-lane plumbing:
// - seam prefix (runCommand/runPty/spawnPrompt vs run/runSessionCreate/runPromptCommand)
// - runSessionCreate's extra `cwd=…` record (argv already carries `--cwd`)
// - the bridge-only `--verbose` probe flag on the ensure path (the bridge retries
//   without it on "unknown option"; pinned by the bridge's own
//   ensure-verbose-supported / ensure-verbose-unsupported fixtures; the CLI has
//   no such flag). This is a pre-existing lane feature, not unification drift.
// `@timeoutMs` suffixes are KEPT: both lanes agree on them today, and they carry
// the shared probeInspectTimeout cap plus the management/session-init bounds.
//
// Outcome text is deliberately not compared: the lanes wrap void results
// differently (`{}` vs `{ ok: {} }` vs bare values), and failure text is pinned
// per-lane by the golden fixtures plus cli-bridge-error-parity.test.ts. This
// file guards the argv contract.
//
// Scope: only paths the unification already shares are pinned here — Phase 1
// spawn primitives, Phase 2a/2b ops + parity, Phase 3 ensure/prompt/setModel,
// and (as of Phase 4a) the twelve thin session commands. The free-warm success
// path is covered only through a missing-record short-circuit: with a live
// record the shared code would reach the real process killer, which the oracle
// seams must not invoke.
// ---------------------------------------------------------------------------

import { afterAll, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The delete-session-success scenario reaches the real on-disk file delete. Point
// acpx's home at a throwaway dir for this file (`resolveAcpxHomeDir` is env-first
// precisely for this), so the delete can never touch the developer's `~/.acpx`.
// Module stubbing is deliberately avoided: bun's `mock.module` is process-global
// and irreversible, which breaks the real `deleteAcpxSessionFiles` tests that
// share this test process.
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const scratchHome = mkdtempSync(join(tmpdir(), "xacpx-parity-home-"));
mkdirSync(join(scratchHome, ".acpx", "sessions"), { recursive: true });
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
});

import {
  runCliArgvOracle,
  makeCliSession,
  type CliArgvOracleScenario,
} from "./cli-argv-oracle-harness";
import {
  runBridgeArgvOracle,
  makeBridgeInput,
  type BridgeArgvOracleScenario,
} from "../../bridge/golden/bridge-argv-oracle-harness";

const noop = () => {};

// A session-effort record whose live value ("low") differs from the persisted
// value the scenarios push ("high"), so the effort sync decides to reapply.
const EFFORT_RECORD = JSON.stringify({
  acpxRecordId: "record-1",
  acpx: {
    config_options: [
      { id: "effort", options: [{ value: "low" }, { value: "high" }], currentValue: "low" },
    ],
  },
});

interface ParityScenario {
  name: string;
  cli: CliArgvOracleScenario;
  bridge: BridgeArgvOracleScenario;
}

function normalizeRecord(record: string[]): string[] {
  return record.map((line) =>
    line
      // Seam name is per-lane plumbing; the argv after it is the contract.
      .replace(/^[a-zA-Z]+\(/, "")
      // runSessionCreate additionally records the child cwd — already in argv as --cwd.
      .replace(/ cwd=[^)]+\)$/, ")")
      .replace(/\)$/, "")
      // Bridge-only ensure-path verbose probe (see header).
      .replace(/ --verbose/g, ""),
  );
}

async function expectParity(scenario: ParityScenario): Promise<void> {
  const cli = normalizeRecord((await runCliArgvOracle(scenario.cli)).record);
  const bridge = normalizeRecord((await runBridgeArgvOracle(scenario.bridge)).record);
  const drifted = cli.length !== bridge.length || cli.some((line, index) => line !== bridge[index]);
  if (drifted) {
    throw new Error(
      `argv drift between lanes for "${scenario.name}":\n` +
        `CLI:\n${cli.map((line) => `  ${line}`).join("\n")}\n` +
        `BRIDGE:\n${bridge.map((line) => `  ${line}`).join("\n")}`,
    );
  }
}

const scenarios: ParityScenario[] = [
  // --- Phase 1: spawn primitives (prompt / ensure / resume spawn argv) --------
  {
    name: "prompt-text",
    cli: {
      name: "prompt-text",
      run: (transport) =>
        transport.prompt(makeCliSession(), "hello there", undefined, undefined, { onSegment: async () => {} }),
    },
    bridge: {
      name: "prompt-text",
      run: (runtime) => runtime.prompt({ ...makeBridgeInput(), text: "hello there" }, noop),
    },
  },
  {
    name: "prompt-agentcommand",
    cli: {
      name: "prompt-agentcommand",
      run: (transport) =>
        transport.prompt(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }), "hello there", undefined, undefined, {
          onSegment: async () => {},
        }),
    },
    bridge: {
      name: "prompt-agentcommand",
      run: (runtime) =>
        runtime.prompt({ ...makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" }), text: "hello there" }, noop),
    },
  },
  // queueOwnerTtlSeconds → `--ttl` in the prompt spawn argv.
  {
    name: "prompt-ttl",
    cli: {
      name: "prompt-ttl",
      options: { queueOwnerTtlSeconds: 1800 },
      run: (transport) =>
        transport.prompt(makeCliSession(), "hello there", undefined, undefined, { onSegment: async () => {} }),
    },
    bridge: {
      name: "prompt-ttl",
      options: { queueOwnerTtlSeconds: 1800 },
      run: (runtime) => runtime.prompt({ ...makeBridgeInput(), text: "hello there" }, noop),
    },
  },
  // media → `--file <structured-prompt>` branch of the prompt spawn argv.
  {
    name: "prompt-media",
    cli: {
      name: "prompt-media",
      run: (transport) =>
        transport.prompt(makeCliSession(), "look at this", undefined, undefined, {
          onSegment: async () => {},
          media: { type: "file", filePath: "/tmp/backend/notes.txt", mimeType: "text/plain", fileName: "notes.txt" },
        }),
    },
    bridge: {
      name: "prompt-media",
      run: (runtime) =>
        runtime.prompt(
          {
            ...makeBridgeInput(),
            text: "look at this",
            media: { type: "file", filePath: "/tmp/backend/notes.txt", mimeType: "text/plain", fileName: "notes.txt" },
          },
          noop,
        ),
    },
  },
  {
    name: "ensure-agent",
    cli: {
      name: "ensure-agent",
      run: (transport) => transport.ensureSession(makeCliSession()),
    },
    bridge: {
      name: "ensure-agent",
      run: (runtime) => runtime.ensureSession(makeBridgeInput()),
    },
  },
  {
    name: "ensure-agentcommand",
    cli: {
      name: "ensure-agentcommand",
      run: (transport) => transport.ensureSession(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" })),
    },
    bridge: {
      name: "ensure-agentcommand",
      run: (runtime) => runtime.ensureSession(makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" })),
    },
  },
  {
    name: "ensure-model",
    cli: {
      name: "ensure-model",
      run: (transport) => transport.ensureSession(makeCliSession({ model: "gpt-5.2[high]" })),
    },
    bridge: {
      name: "ensure-model",
      run: (runtime) => runtime.ensureSession(makeBridgeInput({ model: "gpt-5.2[high]" })),
    },
  },
  // Resume spawns through the session-create seam; the bridge records the child
  // cwd there, which the normalizer strips (already in argv as --cwd).
  {
    name: "resume-agent-session",
    cli: {
      name: "resume-agent-session",
      run: (transport) =>
        transport.resumeAgentSession(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }), "acp-sess-42"),
    },
    bridge: {
      name: "resume-agent-session",
      run: (runtime) =>
        runtime.resumeAgentSession({
          ...makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" }),
          agentSessionId: "acp-sess-42",
        }),
    },
  },
  // --- Phase 2a: effort / queue-owner / probe orchestration -------------------
  // setSessionEffort: sessions show (json) → set (quiet) — the effort apply path.
  {
    name: "set-session-effort",
    cli: {
      name: "set-session-effort",
      results: [{ code: 0, stdout: EFFORT_RECORD, stderr: "" }],
      run: (transport) => transport.setSessionEffort(makeCliSession({ effort: "high" } as never), "high"),
    },
    bridge: {
      name: "set-session-effort",
      results: [{ code: 0, stdout: EFFORT_RECORD, stderr: "" }],
      run: (runtime) => runtime.setSessionEffort({ ...makeBridgeInput(), effort: "high" }),
    },
  },
  // Persisted effort differs from live → sync reads the record, applies `set`,
  // THEN prompts. Pins syncPersistedSessionEffortFlow's argv through prompt.
  {
    name: "prompt-effort-sync",
    cli: {
      name: "prompt-effort-sync",
      results: [{ code: 0, stdout: EFFORT_RECORD, stderr: "" }],
      run: (transport) =>
        transport.prompt(makeCliSession({ effort: "high" } as never), "hello there", undefined, undefined, {
          onSegment: async () => {},
        }),
    },
    bridge: {
      name: "prompt-effort-sync",
      results: [{ code: 0, stdout: EFFORT_RECORD, stderr: "" }],
      run: (runtime) => runtime.prompt({ ...makeBridgeInput(), effort: "high", text: "hello there" }, noop),
    },
  },
  // Persisted effort already live → resolveEffortReapply decides NOT to reapply:
  // the record is read but no `set` fires, in either lane.
  {
    name: "prompt-effort-noop",
    cli: {
      name: "prompt-effort-noop",
      results: [{ code: 0, stdout: EFFORT_RECORD, stderr: "" }],
      run: (transport) =>
        transport.prompt(makeCliSession({ effort: "low" } as never), "hello there", undefined, undefined, {
          onSegment: async () => {},
        }),
    },
    bridge: {
      name: "prompt-effort-noop",
      results: [{ code: 0, stdout: EFFORT_RECORD, stderr: "" }],
      run: (runtime) => runtime.prompt({ ...makeBridgeInput(), effort: "low", text: "hello there" }, noop),
    },
  },
  // MCP coordinator set → ensureMcpQueueOwnerLaunched reads the record first
  // (the launcher seam itself is not argv-recorded, so the show is the observable).
  {
    name: "prompt-mcp-owner",
    cli: {
      name: "prompt-mcp-owner",
      results: [{ code: 0, stdout: '{"acpxRecordId":"record-1"}', stderr: "" }],
      run: (transport) =>
        transport.prompt(makeCliSession({ mcpCoordinatorSession: "backend:main" }), "hello there", undefined, undefined, {
          onSegment: async () => {},
        }),
    },
    bridge: {
      name: "prompt-mcp-owner",
      results: [{ code: 0, stdout: '{"acpxRecordId":"record-1"}', stderr: "" }],
      run: (runtime) =>
        runtime.prompt({ ...makeBridgeInput(), mcpCoordinatorSession: "backend:main", text: "hello there" }, noop),
    },
  },
  // getSessionModel carries the probeInspectTimeout cap in its @timeout suffix;
  // both lanes must bind the same ceiling.
  {
    name: "get-session-model",
    cli: {
      name: "get-session-model",
      results: [
        { code: 0, stdout: '{"model":"gpt-5.2[high]","availableModels":["gpt-5.2[high]","gpt-5.1"]}', stderr: "" },
      ],
      run: (transport) => transport.getSessionModel(makeCliSession()),
    },
    bridge: {
      name: "get-session-model",
      results: [
        { code: 0, stdout: '{"model":"gpt-5.2[high]","availableModels":["gpt-5.2[high]","gpt-5.1"]}', stderr: "" },
      ],
      run: (runtime) => runtime.getSessionModel(makeBridgeInput()),
    },
  },
  // --- Phase 3c: setModel (ordinary setter; shared with OMP recovery) ------
  // Both lanes now delegate to the same native-restore flow; the ordinary
  // `set ... model` argv must stay byte-identical.
  {
    name: "set-model",
    cli: {
      name: "set-model",
      run: (transport) => transport.setModel(makeCliSession(), "gpt-5.2[high]"),
    },
    bridge: {
      name: "set-model",
      run: (runtime) => runtime.setModel({ ...makeBridgeInput(), modelId: "gpt-5.2[high]" }),
    },
  },
  // --- Phase 4a: thin session commands (shared shells) ----------------------
  // Every scenario below runs the same method through both lanes; the
  // normalized argv records must match. Record-dependent methods use a canned
  // record (side-effect-free) or a failing show (early return, no side effects).
  {
    name: "tail-history-fail",
    cli: {
      name: "tail-history-fail",
      results: [
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
      ],
      run: (transport) => transport.tailSessionHistory(makeCliSession(), 20),
    },
    bridge: {
      name: "tail-history-fail",
      results: [
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "" },
      ],
      run: (runtime) => runtime.tailSessionHistory({ ...makeBridgeInput(), lines: 20 }),
    },
  },
  {
    name: "get-session-model-fail",
    cli: {
      name: "get-session-model-fail",
      results: [{ code: 1, stdout: "", stderr: "boom" }],
      run: (transport) => transport.getSessionModel(makeCliSession()),
    },
    bridge: {
      name: "get-session-model-fail",
      results: [{ code: 1, stdout: "", stderr: "boom" }],
      run: (runtime) => runtime.getSessionModel(makeBridgeInput()),
    },
  },
  {
    name: "list-native",
    cli: {
      name: "list-native",
      results: [{ code: 0, stdout: '{"source":"agent","sessions":[{"sessionId":"sess-1","cwd":"/tmp/backend"}]}', stderr: "" }],
      run: (transport) =>
        transport.listAgentSessions!({ agent: "codex", cwd: "/tmp/backend", filterCwd: "/tmp/backend", cursor: "cur-1" }),
    },
    bridge: {
      name: "list-native",
      results: [{ code: 0, stdout: '{"source":"agent","sessions":[{"sessionId":"sess-1","cwd":"/tmp/backend"}]}', stderr: "" }],
      run: (runtime) =>
        runtime.listAgentSessions({ agent: "codex", cwd: "/tmp/backend", filterCwd: "/tmp/backend", cursor: "cur-1" }),
    },
  },
  {
    name: "remove-missing",
    cli: {
      name: "remove-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (transport) => transport.removeSession!(makeCliSession()),
    },
    bridge: {
      name: "remove-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (runtime) => runtime.removeSession(makeBridgeInput()),
    },
  },
  {
    name: "remove-real-error",
    cli: {
      name: "remove-real-error",
      results: [{ code: 1, stdout: "", stderr: "EACCES: permission denied" }],
      run: (transport) => transport.removeSession!(makeCliSession()),
    },
    bridge: {
      name: "remove-real-error",
      results: [{ code: 1, stdout: "", stderr: "EACCES: permission denied" }],
      run: (runtime) => runtime.removeSession(makeBridgeInput()),
    },
  },
  {
    name: "has-session",
    cli: {
      name: "has-session",
      results: [{ code: 0, stdout: "", stderr: "" }],
      run: (transport) => transport.hasSession(makeCliSession()),
    },
    bridge: {
      name: "has-session",
      results: [{ code: 0, stdout: "", stderr: "" }],
      run: (runtime) => runtime.hasSession(makeBridgeInput()),
    },
  },
  {
    name: "delete-missing",
    cli: {
      name: "delete-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (transport) => transport.deleteSession(makeCliSession()),
    },
    bridge: {
      name: "delete-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (runtime) => runtime.deleteSession(makeBridgeInput()),
    },
  },
  {
    name: "delete-record",
    cli: {
      name: "delete-record",
      results: [
        { code: 0, stdout: '{"acpxRecordId":"abcd1234"}', stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ],
      run: (transport) => transport.deleteSession(makeCliSession()),
    },
    bridge: {
      name: "delete-record",
      results: [
        { code: 0, stdout: '{"acpxRecordId":"abcd1234"}', stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ],
      run: (runtime) => runtime.deleteSession(makeBridgeInput()),
    },
  },
  {
    name: "free-warm-missing",
    cli: {
      name: "free-warm-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (transport) => transport.freeWarmProcess(makeCliSession()),
    },
    bridge: {
      name: "free-warm-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (runtime) => runtime.freeWarmProcess(makeBridgeInput()),
    },
  },
  {
    name: "free-warm-record",
    cli: {
      name: "free-warm-record",
      results: [{ code: 0, stdout: '{"acpxRecordId":"record-1"}', stderr: "" }],
      run: (transport) => transport.freeWarmProcess(makeCliSession()),
    },
    bridge: {
      name: "free-warm-record",
      results: [{ code: 0, stdout: '{"acpxRecordId":"record-1"}', stderr: "" }],
      run: (runtime) => runtime.freeWarmProcess(makeBridgeInput()),
    },
  },
  {
    name: "is-warm-missing",
    cli: {
      name: "is-warm-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (transport) => transport.isSessionWarm(makeCliSession()),
    },
    bridge: {
      name: "is-warm-missing",
      results: [{ code: 1, stdout: "", stderr: "no named session" }],
      run: (runtime) => runtime.isSessionWarm(makeBridgeInput()),
    },
  },
  {
    name: "is-warm-cold-record",
    cli: {
      name: "is-warm-cold-record",
      results: [{ code: 0, stdout: '{"acpxRecordId":"record-1"}', stderr: "" }],
      run: (transport) => transport.isSessionWarm(makeCliSession()),
    },
    bridge: {
      name: "is-warm-cold-record",
      results: [{ code: 0, stdout: '{"acpxRecordId":"record-1"}', stderr: "" }],
      run: (runtime) => runtime.isSessionWarm(makeBridgeInput()),
    },
  },
  {
    name: "cancel",
    cli: {
      name: "cancel",
      results: [{ code: 0, stdout: "cancelled ok", stderr: "" }],
      run: (transport) => transport.cancel(makeCliSession()),
    },
    bridge: {
      name: "cancel",
      results: [{ code: 0, stdout: "cancelled ok", stderr: "" }],
      run: (runtime) => runtime.cancel(makeBridgeInput()),
    },
  },
  {
    name: "get-agent-session-id",
    cli: {
      name: "get-agent-session-id",
      results: [{ code: 0, stdout: '{"acpxRecordId":"abcd1234","agentSessionId":"agent-from-id"}', stderr: "" }],
      run: (transport) => transport.getAgentSessionId(makeCliSession()),
    },
    bridge: {
      name: "get-agent-session-id",
      results: [{ code: 0, stdout: '{"acpxRecordId":"abcd1234","agentSessionId":"agent-from-id"}', stderr: "" }],
      run: (runtime) => runtime.getAgentSessionId(makeBridgeInput()),
    },
  },
  {
    name: "set-mode",
    cli: {
      name: "set-mode",
      run: (transport) => transport.setMode(makeCliSession(), "plan"),
    },
    bridge: {
      name: "set-mode",
      run: (runtime) => runtime.setMode({ ...makeBridgeInput(), modeId: "plan" }),
    },
  },
];

for (const scenario of scenarios) {
  test(`cli/bridge argv parity: ${scenario.name}`, () => expectParity(scenario));
}
