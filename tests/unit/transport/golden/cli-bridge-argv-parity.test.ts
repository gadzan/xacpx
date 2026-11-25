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
// Outcome text is deliberately not compared: error strings still differ per lane
// by design until the error-convergence task lands, and the lanes wrap void
// results differently (`{}` vs `{ ok: {} }`).
//
// Scope: only paths the unification already shares are pinned here. The thin,
// not-yet-unified families (list / tail / cancel / remove / delete / …) are
// intentionally excluded — pinning them now would freeze today's shape instead
// of catching drift, and would fight the upcoming error-convergence change.
// Add each family here as it is unified, in the commit that unifies it.
// ---------------------------------------------------------------------------

import { test } from "bun:test";

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
];

for (const scenario of scenarios) {
  test(`cli/bridge argv parity: ${scenario.name}`, () => expectParity(scenario));
}
