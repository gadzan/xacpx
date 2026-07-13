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
  test("json acpxRecordId + agentSessionId", () =>
    expect(parseAcpxSessionRecordId('{"acpxRecordId":"abcd1234","agentSessionId":"z"}')).toEqual({ acpxRecordId: "abcd1234", agentSessionId: "z" }));
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
