import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_MODE, DEFAULT_NON_INTERACTIVE,
  buildPermissionArgs, buildQueueOwnerTtlArgs, buildModelArgs,
  buildSessionArgs, buildPromptArgs, buildAgentQueryArgs,
  isMissingAcpxSessionError, parseAcpxSessionRecordId,
} from "../../../src/transport/acpx-command-builder";

const permission = { permissionMode: DEFAULT_PERMISSION_MODE, nonInteractivePermissions: DEFAULT_NON_INTERACTIVE };

describe("buildPermissionArgs", () => {
  test("defaults, no policy", () => {
    expect(buildPermissionArgs(permission)).toEqual(["--approve-all", "--non-interactive-permissions", "deny"]);
  });
  test("with policy appends --permission-policy", () => {
    expect(buildPermissionArgs({ ...permission, permissionPolicy: "p.json" }))
      .toEqual(["--approve-all", "--non-interactive-permissions", "deny", "--permission-policy", "p.json"]);
  });
});

describe("buildQueueOwnerTtlArgs", () => {
  test("number → --ttl", () => expect(buildQueueOwnerTtlArgs(1800)).toEqual(["--ttl", "1800"]));
  test("undefined → []", () => expect(buildQueueOwnerTtlArgs(undefined)).toEqual([]));
  test("NaN → []", () => expect(buildQueueOwnerTtlArgs(Number.NaN)).toEqual([]));
});

describe("buildModelArgs", () => {
  test("trimmed model", () => expect(buildModelArgs("  gpt-5.2  ")).toEqual(["--model", "gpt-5.2"]));
  test("empty/undefined → []", () => { expect(buildModelArgs("  ")).toEqual([]); expect(buildModelArgs(undefined)).toEqual([]); });
});

describe("buildSessionArgs", () => {
  test("bare agent, quiet default", () => {
    expect(buildSessionArgs({ agent: "codex", cwd: "/w", permission }, ["sessions", "new"]))
      .toEqual(["--format", "quiet", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "codex", "sessions", "new"]);
  });
  test("agentCommand branch + model + verbose + json format", () => {
    expect(buildSessionArgs({ agent: "codex", agentCommand: "my-codex", cwd: "/w", model: "m", permission }, ["x"], { verbose: true, format: "json" }))
      .toEqual(["--format", "json", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "--model", "m", "--verbose", "--agent", "my-codex", "x"]);
  });
});

describe("buildPromptArgs", () => {
  test("prefix carries model+ttl, bare agent branch", () => {
    expect(buildPromptArgs({ agent: "codex", cwd: "/w", model: "m", permission, queueOwnerTtlSeconds: 900 }, ["prompt", "-s", "s", "hi"]))
      .toEqual(["--format", "json", "--json-strict", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "--model", "m", "--ttl", "900", "codex", "prompt", "-s", "s", "hi"]);
  });
  // Directly pins buildPromptArgs's agentCommand branch (`--agent <cmd>` vs bare agent) so
  // a mutation to how the prompt path selects the agent reddens at the module layer.
  test("agentCommand branch", () => {
    expect(buildPromptArgs({ agent: "codex", agentCommand: "my-codex", cwd: "/w", model: "m", permission, queueOwnerTtlSeconds: 900 }, ["prompt", "-s", "s", "hi"]))
      .toEqual(["--format", "json", "--json-strict", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "--model", "m", "--ttl", "900", "--agent", "my-codex", "prompt", "-s", "s", "hi"]);
  });
});

describe("buildAgentQueryArgs", () => {
  test("never adds model", () => {
    expect(buildAgentQueryArgs({ agent: "codex", cwd: "/w", permission }, "json", ["sessions", "list"]))
      .toEqual(["--format", "json", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "codex", "sessions", "list"]);
  });
  // Pins buildAgentQueryArgs's agentCommand branch AND its `quiet` format branch — neither is
  // exercised elsewhere (production's list path always passes "json" + no agentCommand), so this
  // is the only guard against a mutation that hardcodes the format or drops the agent selection.
  test("agentCommand branch + quiet format", () => {
    expect(buildAgentQueryArgs({ agent: "codex", agentCommand: "my-codex", cwd: "/w", permission }, "quiet", ["sessions", "list"]))
      .toEqual(["--format", "quiet", "--cwd", "/w", "--approve-all", "--non-interactive-permissions", "deny", "--agent", "my-codex", "sessions", "list"]);
  });
});

describe("isMissingAcpxSessionError", () => {
  test("matches the 5 markers", () => {
    for (const marker of ["no named session", "no cwd session", "session not found", "unknown session", "no acpx session found"])
      expect(isMissingAcpxSessionError(marker.toUpperCase(), "")).toBe(true);
  });
  test("non-match", () => expect(isMissingAcpxSessionError("boom", "nope")).toBe(false));
});

describe("parseAcpxSessionRecordId", () => {
  test("acpx 0.12 json acpxRecordId + acpSessionId", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","acpSessionId":"z"}')).toEqual({ acpxRecordId: "abcd1234", agentSessionId: "z" }));
  test("json acpxRecordId + agentSessionId", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","agentSessionId":"z"}')).toEqual({ acpxRecordId: "abcd1234", agentSessionId: "z" }));
  test("prefers provider-native agentSessionId when both session ids are present", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","acpSessionId":"acp-session","agentSessionId":"native-session"}')).toEqual({
      acpxRecordId: "abcd1234",
      agentSessionId: "native-session",
    }));
  test("falls back to acpSessionId when agentSessionId is empty", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","acpSessionId":"acp-session","agentSessionId":""}')).toEqual({
      acpxRecordId: "abcd1234",
      agentSessionId: "acp-session",
    }));
  test("ignores an empty acpSessionId when agentSessionId is present", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","acpSessionId":"","agentSessionId":"native-session"}')).toEqual({
      acpxRecordId: "abcd1234",
      agentSessionId: "native-session",
    }));
  test("json id fallback", () =>
    expect(parseAcpxSessionRecordId('{"id":"abcd1234"}')).toEqual({ acpxRecordId: "abcd1234", agentSessionId: undefined }));
  test("bare first line when JSON.parse throws", () =>
    expect(parseAcpxSessionRecordId("abcd1234\nrest")).toEqual({ acpxRecordId: "abcd1234" }));
  test("too-short id → undefined", () => expect(parseAcpxSessionRecordId('{"id":"x"}')).toBeUndefined());
  // Pins the >=8 length floor at its boundary: a 6-char id (valid charset) must still be
  // rejected, so loosening the guard below 8 reddens here (nothing else exercises 4–7 chars).
  test("6-char id below the 8-char floor → undefined", () => expect(parseAcpxSessionRecordId('{"id":"abc123"}')).toBeUndefined());
  test("malformed non-json → undefined", () => expect(parseAcpxSessionRecordId("!!")).toBeUndefined());
});

// ── structured launch selection ──────────────────────────────────────────────

import { buildSessionArgs } from "../../../src/transport/acpx-command-builder";

const launchPermission = { permissionMode: "approve-all" as const, nonInteractivePermissions: "deny" as const };

test("selection: rawCommand wins as --agent", () => {
  expect(buildSessionArgs(
    { agent: "claude", acpxAgent: "claude", rawCommand: "my-claude --acp", cwd: "/repo", permission: launchPermission },
    ["sessions", "new", "--name", "demo"],
  )).toContain("--agent");
  const args = buildSessionArgs(
    { agent: "claude", acpxAgent: "claude", rawCommand: "my-claude --acp", cwd: "/repo", permission: launchPermission },
    ["sessions", "new", "--name", "demo"],
  );
  expect(args).toEqual(expect.arrayContaining(["--agent", "my-claude --acp"]));
});

test("selection: acpxAgent wins as the positional agent for structured launches", () => {
  const args = buildSessionArgs(
    {
      agent: "codex",
      acpxAgent: "xacpx-managed-codex-abc123def456",
      agentCommand: "npx -y @agentclientprotocol/codex-acp@1.1.9",
      cwd: "/repo",
      permission,
    },
    ["prompt", "-s", "demo", "hi"],
  );
  expect(args).toEqual(expect.arrayContaining(["xacpx-managed-codex-abc123def456", "prompt", "-s", "demo", "hi"]));
  expect(args).not.toContain("--agent");
});

test("selection: legacy agentCommand falls back to --agent when no acpxAgent is sent (old bridge clients)", () => {
  const args = buildSessionArgs(
    { agent: "codex", agentCommand: "npx -y @agentclientprotocol/codex-acp@1.1.9", cwd: "/repo", permission: launchPermission },
    ["sessions", "list"],
  );
  expect(args).toEqual(expect.arrayContaining(["--agent", "npx -y @agentclientprotocol/codex-acp@1.1.9"]));
});

test("selection: bare driver stays positional", () => {
  const args = buildSessionArgs(
    { agent: "pool", cwd: "/repo", permission: launchPermission },
    ["sessions", "new", "--name", "demo"],
  );
  expect(args).toEqual(expect.arrayContaining(["pool", "sessions", "new", "--name", "demo"]));
  expect(args).not.toContain("--agent");
});
