import { test, expect, mock } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Stub the on-disk file delete so the delete-session scenarios never touch the
// real ~/.acpx dir. It is not a recorded seam (not argv) — purely a side-effect guard.
mock.module("../../../../src/transport/acpx-session-files", () => ({
  deleteAcpxSessionFiles: async () => {},
}));

import {
  runBridgeArgvOracle,
  makeBridgeInput,
  type BridgeArgvOracleScenario,
} from "./bridge-argv-oracle-harness";

const FIX = join(import.meta.dir, "fixtures");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

async function check(scenario: BridgeArgvOracleScenario) {
  const got = await runBridgeArgvOracle(scenario);
  const path = join(FIX, `${scenario.name}.json`);
  const serialized = JSON.stringify(got, null, 2);
  if (UPDATE) {
    if (!existsSync(FIX)) mkdirSync(FIX, { recursive: true });
    writeFileSync(path, serialized + "\n");
    return;
  }
  expect(serialized + "\n").toBe(readFileSync(path, "utf8"));
}

const MODEL_NOT_ADVERTISED =
  'Cannot apply --model "gpt-fake": the ACP agent did not advertise that model.';
const UNKNOWN_VERBOSE = "error: unknown option '--verbose'";
const noop = () => {};

// --- ensureSession × axis (all ensure paths carry `--verbose` by default) ---

test("ensure-agent", () =>
  check({
    name: "ensure-agent",
    run: (runtime) => runtime.ensureSession(makeBridgeInput()),
  }));

test("ensure-agentcommand", () =>
  check({
    name: "ensure-agentcommand",
    run: (runtime) => runtime.ensureSession(makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" })),
  }));

test("ensure-model", () =>
  check({
    name: "ensure-model",
    run: (runtime) => runtime.ensureSession(makeBridgeInput({ model: "gpt-5.2[high]" })),
  }));

// First ensure fails model-not-advertised (through ensure→show→new) → retry once
// WITHOUT `--model`. Staged results drive both attempts.
test("ensure-model-not-advertised", () =>
  check({
    name: "ensure-model-not-advertised",
    results: [
      { code: 1, stdout: MODEL_NOT_ADVERTISED, stderr: "" }, // attempt 1: sessions ensure
      { code: 1, stdout: "", stderr: "" }, //                  attempt 1: sessions show probe
      { code: 1, stdout: MODEL_NOT_ADVERTISED, stderr: "" }, // attempt 1: sessions new
      { code: 0, stdout: "", stderr: "" }, //                  attempt 2: sessions ensure (no --model)
    ],
    run: (runtime) => runtime.ensureSession(makeBridgeInput({ model: "gpt-fake" })),
  }));

// --- bridge-only verbose-probe axis ---------------------------------------

// First `sessions ensure --verbose` returns 0 → verbose supported, no retry.
test("ensure-verbose-supported", () =>
  check({
    name: "ensure-verbose-supported",
    results: [{ code: 0, stdout: "", stderr: "" }],
    run: (runtime) => runtime.ensureSession(makeBridgeInput()),
  }));

// First `--verbose` rejected as unknown option → retry WITHOUT `--verbose`.
test("ensure-verbose-unsupported", () =>
  check({
    name: "ensure-verbose-unsupported",
    results: [
      { code: 1, stdout: "", stderr: UNKNOWN_VERBOSE },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (runtime) => runtime.ensureSession(makeBridgeInput()),
  }));

// --- prompt × axis (captured via the runPromptCommand seam) ----------------

test("prompt-text", () =>
  check({
    name: "prompt-text",
    run: (runtime) => runtime.prompt({ ...makeBridgeInput(), text: "hello there" }, noop),
  }));

// model set → `--model` in the prompt argv too (guards buildPromptArgs' model spread).
test("prompt-model", () =>
  check({
    name: "prompt-model",
    run: (runtime) => runtime.prompt({ ...makeBridgeInput({ model: "gpt-5.2[high]" }), text: "hello there" }, noop),
  }));

test("prompt-ttl", () =>
  check({
    name: "prompt-ttl",
    options: { queueOwnerTtlSeconds: 1800 },
    run: (runtime) => runtime.prompt({ ...makeBridgeInput(), text: "hello there" }, noop),
  }));

test("prompt-agentcommand", () =>
  check({
    name: "prompt-agentcommand",
    run: (runtime) =>
      runtime.prompt({ ...makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" }), text: "hello there" }, noop),
  }));

test("prompt-media", () =>
  check({
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
  }));

// --- other single-method paths --------------------------------------------

test("set-mode", () =>
  check({
    name: "set-mode",
    run: (runtime) => runtime.setMode({ ...makeBridgeInput(), modeId: "plan" }),
  }));

test("set-model", () =>
  check({
    name: "set-model",
    run: (runtime) => runtime.setModel({ ...makeBridgeInput(), modelId: "gpt-5.2[high]" }),
  }));

test("get-session-model", () =>
  check({
    name: "get-session-model",
    results: [
      { code: 0, stdout: '{"model":"gpt-5.2[high]","availableModels":["gpt-5.2[high]","gpt-5.1"]}', stderr: "" },
    ],
    run: (runtime) => runtime.getSessionModel(makeBridgeInput()),
  }));

test("cancel", () =>
  check({
    name: "cancel",
    results: [{ code: 0, stdout: "cancelled ok", stderr: "" }],
    run: (runtime) => runtime.cancel(makeBridgeInput()),
  }));

// resumeAgentSession → runSessionCreate seam (session-create path).
test("resume-agent-session", () =>
  check({
    name: "resume-agent-session",
    run: (runtime) =>
      runtime.resumeAgentSession({
        ...makeBridgeInput({ agentCommand: "./node_modules/.bin/codex-acp" }),
        agentSessionId: "acp-sess-42",
      }),
  }));

// listAgentSessions: cwd, filter-cwd (filterCwd set), cursor (cursor set); NO --model, NO --verbose.
test("list-native", () =>
  check({
    name: "list-native",
    results: [{ code: 0, stdout: '{"source":"agent","sessions":[{"sessionId":"sess-1","cwd":"/tmp/backend"}]}', stderr: "" }],
    run: (runtime) =>
      runtime.listAgentSessions({ agent: "codex", cwd: "/tmp/backend", filterCwd: "/tmp/backend", cursor: "cur-1" }),
  }));

// tailSessionHistory: every candidate argv (all fail → method throws).
test("tail-history", () =>
  check({
    name: "tail-history",
    results: [
      { code: 1, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "" },
    ],
    run: (runtime) => runtime.tailSessionHistory({ ...makeBridgeInput(), lines: 20 }),
  }));

// --- record-id parse predicates -------------------------------------------

test("delete-session-json-record", () =>
  check({
    name: "delete-session-json-record",
    results: [
      { code: 0, stdout: '{"acpxRecordId":"abcd1234"}', stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (runtime) => runtime.deleteSession(makeBridgeInput()),
  }));

// sessions show → JSON with only `id` (no acpxRecordId) → id→acpxRecordId
// fallback → close. Pins parseAcpxSessionRecordId's `id` branch through the
// public method (spec-mandated).
test("delete-session-id-only", () =>
  check({
    name: "delete-session-id-only",
    results: [
      { code: 0, stdout: '{"id":"abcd1234"}', stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (runtime) => runtime.deleteSession(makeBridgeInput()),
  }));

test("delete-session-bare-id", () =>
  check({
    name: "delete-session-bare-id",
    results: [
      { code: 0, stdout: "abcd1234", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (runtime) => runtime.deleteSession(makeBridgeInput()),
  }));

// too-short id → readSessionRecord throws. Driven via getAgentSessionId, which
// surfaces the throw (deleteSession would swallow it).
test("delete-session-malformed", () =>
  check({
    name: "delete-session-malformed",
    results: [{ code: 0, stdout: "x", stderr: "" }],
    run: (runtime) => runtime.getAgentSessionId(makeBridgeInput()),
  }));

// removeSession: `no named session` → swallowed, no throw.
test("remove-session-missing", () =>
  check({
    name: "remove-session-missing",
    results: [{ code: 1, stdout: "", stderr: "no named session" }],
    run: (runtime) => runtime.removeSession(makeBridgeInput()),
  }));

// removeSession: a real (NON-missing) error → propagates (method throws).
test("remove-session-real-error", () =>
  check({
    name: "remove-session-real-error",
    results: [{ code: 1, stdout: "", stderr: "EACCES: permission denied" }],
    run: (runtime) => runtime.removeSession(makeBridgeInput()),
  }));

// --- permission axes -------------------------------------------------------

test("permission-policy", () =>
  check({
    name: "permission-policy",
    options: { permissionPolicy: "/etc/policy.json" },
    run: (runtime) => runtime.setMode({ ...makeBridgeInput(), modeId: "plan" }),
  }));

test("permission-noninteractive", () =>
  check({
    name: "permission-noninteractive",
    options: { permissionMode: "deny-all", nonInteractivePermissions: "fail" },
    run: (runtime) => runtime.setMode({ ...makeBridgeInput(), modeId: "plan" }),
  }));
