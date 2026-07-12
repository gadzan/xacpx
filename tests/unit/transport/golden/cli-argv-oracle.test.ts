import { test, expect, mock } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Stub the on-disk file delete so the delete-session scenarios never touch the
// real ~/.acpx dir. It is not a recorded seam (not argv) — purely a side-effect guard.
mock.module("../../../../src/transport/acpx-session-files", () => ({
  deleteAcpxSessionFiles: async () => {},
}));

import {
  runCliArgvOracle,
  makeCliSession,
  type CliArgvOracleScenario,
} from "./cli-argv-oracle-harness";

const FIX = join(import.meta.dir, "fixtures", "cli");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

async function check(scenario: CliArgvOracleScenario) {
  const got = await runCliArgvOracle(scenario);
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

// --- ensureSession × axis -------------------------------------------------

// Bare agent (no agentCommand) → runWithPty seam; model unset.
test("ensure-agent", () =>
  check({
    name: "ensure-agent",
    run: (t) => t.ensureSession(makeCliSession()),
  }));

// agentCommand set → the plain runCommand seam (NOT pty — see harness note).
test("ensure-agentcommand", () =>
  check({
    name: "ensure-agentcommand",
    run: (t) => t.ensureSession(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" })),
  }));

// model set → global `--model` in the create argv.
test("ensure-model", () =>
  check({
    name: "ensure-model",
    run: (t) => t.ensureSession(makeCliSession({ model: "gpt-5.2[high]" })),
  }));

// First ensure fails model-not-advertised → retry once WITHOUT `--model`.
test("ensure-model-not-advertised", () =>
  check({
    name: "ensure-model-not-advertised",
    results: [
      { code: 1, stdout: MODEL_NOT_ADVERTISED, stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (t) => t.ensureSession(makeCliSession({ model: "gpt-fake" })),
  }));

// --- prompt × axis (captured via the streamingHooks.spawnPrompt seam) ------

test("prompt-text", () =>
  check({
    name: "prompt-text",
    run: (t) => t.prompt(makeCliSession(), "hello there", undefined, undefined, { onSegment: async () => {} }),
  }));

// model set → `--model` in the prompt argv too (guards buildPromptArgs' model spread).
test("prompt-model", () =>
  check({
    name: "prompt-model",
    run: (t) =>
      t.prompt(makeCliSession({ model: "gpt-5.2[high]" }), "hello there", undefined, undefined, {
        onSegment: async () => {},
      }),
  }));

// queueOwnerTtlSeconds set → `--ttl` in the prompt argv.
test("prompt-ttl", () =>
  check({
    name: "prompt-ttl",
    options: { queueOwnerTtlSeconds: 1800 },
    run: (t) => t.prompt(makeCliSession(), "hello there", undefined, undefined, { onSegment: async () => {} }),
  }));

test("prompt-agentcommand", () =>
  check({
    name: "prompt-agentcommand",
    run: (t) =>
      t.prompt(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }), "hello there", undefined, undefined, {
        onSegment: async () => {},
      }),
  }));

// media provided → the `--file <structured-prompt>` branch fires (path scrubbed).
test("prompt-media", () =>
  check({
    name: "prompt-media",
    run: (t) =>
      t.prompt(makeCliSession(), "look at this", undefined, undefined, {
        onSegment: async () => {},
        media: { type: "file", filePath: "/tmp/backend/notes.txt", mimeType: "text/plain", fileName: "notes.txt" },
      }),
  }));

// --- other single-method paths --------------------------------------------

test("set-mode", () =>
  check({
    name: "set-mode",
    run: (t) => t.setMode(makeCliSession(), "plan"),
  }));

test("set-model", () =>
  check({
    name: "set-model",
    run: (t) => t.setModel(makeCliSession(), "gpt-5.2[high]"),
  }));

test("get-session-model", () =>
  check({
    name: "get-session-model",
    results: [
      { code: 0, stdout: '{"model":"gpt-5.2[high]","availableModels":["gpt-5.2[high]","gpt-5.1"]}', stderr: "" },
    ],
    run: (t) => t.getSessionModel(makeCliSession()),
  }));

test("cancel", () =>
  check({
    name: "cancel",
    results: [{ code: 0, stdout: "cancelled ok", stderr: "" }],
    run: (t) => t.cancel(makeCliSession()),
  }));

// agentCommand set → resume via the plain runCommand seam.
test("resume-agent-session", () =>
  check({
    name: "resume-agent-session",
    run: (t) =>
      t.resumeAgentSession(makeCliSession({ agentCommand: "./node_modules/.bin/codex-acp" }), "acp-sess-42"),
  }));

// listAgentSessions: cwd, filter-cwd (filterCwd set), cursor (cursor set); NO --model.
test("list-native", () =>
  check({
    name: "list-native",
    results: [{ code: 0, stdout: '{"source":"agent","sessions":[{"sessionId":"sess-1","cwd":"/tmp/backend"}]}', stderr: "" }],
    run: (t) =>
      t.listAgentSessions!({ agent: "codex", cwd: "/tmp/backend", filterCwd: "/tmp/backend", cursor: "cur-1" }),
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
    run: (t) => t.tailSessionHistory(makeCliSession(), 20),
  }));

// --- record-id parse predicates -------------------------------------------

// sessions show → JSON acpxRecordId → close, then file delete (stubbed).
test("delete-session-json-record", () =>
  check({
    name: "delete-session-json-record",
    results: [
      { code: 0, stdout: '{"acpxRecordId":"abcd1234"}', stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (t) => t.deleteSession!(makeCliSession()),
  }));

// sessions show → bare non-JSON line → first-line fallback → close.
test("delete-session-bare-id", () =>
  check({
    name: "delete-session-bare-id",
    results: [
      { code: 0, stdout: "abcd1234", stderr: "" },
      { code: 0, stdout: "", stderr: "" },
    ],
    run: (t) => t.deleteSession!(makeCliSession()),
  }));

// sessions show → too-short id → readSessionRecord throws. Driven via
// getAgentSessionId, which surfaces the throw (deleteSession would swallow it).
test("delete-session-malformed", () =>
  check({
    name: "delete-session-malformed",
    results: [{ code: 0, stdout: "x", stderr: "" }],
    run: (t) => t.getAgentSessionId(makeCliSession()),
  }));

// removeSession: `no named session` → swallowed, no throw.
test("remove-session-missing", () =>
  check({
    name: "remove-session-missing",
    results: [{ code: 1, stdout: "", stderr: "no named session" }],
    run: (t) => t.removeSession!(makeCliSession()),
  }));

// --- permission axes -------------------------------------------------------

test("permission-policy", () =>
  check({
    name: "permission-policy",
    options: { permissionPolicy: "/etc/policy.json" },
    run: (t) => t.setMode(makeCliSession(), "plan"),
  }));

test("permission-noninteractive", () =>
  check({
    name: "permission-noninteractive",
    options: { permissionMode: "deny-all", nonInteractivePermissions: "fail" },
    run: (t) => t.setMode(makeCliSession(), "plan"),
  }));
