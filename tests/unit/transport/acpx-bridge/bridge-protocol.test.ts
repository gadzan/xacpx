import { describe, expect, test } from "bun:test";
import {
  decodeBridgeOriginatedRequest,
  encodeBridgePromptThoughtEvent,
  encodeBridgeSessionProgressEvent,
  type BridgeErrorResponse,
  type BridgePromptThoughtEvent,
  type BridgeSessionProgressEvent,
  type EnsureSessionErrorKind,
} from "../../../../src/transport/acpx-bridge/acpx-bridge-protocol";

describe("bridge protocol progress + structured error", () => {
  test("encodes session.progress event as NDJSON", () => {
    const event: BridgeSessionProgressEvent = {
      id: "42",
      event: "session.progress",
      stage: "initializing",
    };
    expect(encodeBridgeSessionProgressEvent(event)).toBe(
      `${JSON.stringify(event)}\n`,
    );
  });

  test("error response accepts kind and data", () => {
    const response: BridgeErrorResponse = {
      id: "1",
      ok: false,
      error: {
        code: "BRIDGE_ENSURE_SESSION_FAILED",
        message: "...",
        kind: "missing_optional_dep" satisfies EnsureSessionErrorKind,
        data: { package: "opencode-windows-x64", parentPackagePath: "/path" },
      },
    };
    expect(response.error.kind).toBe("missing_optional_dep");
  });

  test("encodes prompt.thought event as NDJSON", () => {
    const event: BridgePromptThoughtEvent = {
      id: "7",
      event: "prompt.thought",
      text: "weighing the tradeoffs",
    };
    expect(encodeBridgePromptThoughtEvent(event)).toBe(
      `${JSON.stringify(event)}\n`,
    );
  });

  test("strictly separates Windows launch schemas from Unix command resolution", () => {
    const base = { direction: "bridge-to-daemon", rpcId: "bridge:1" };
    expect(decodeBridgeOriginatedRequest({
      ...base,
      method: "registerAdapterIntent",
      params: {
        id: "launch-1",
        sessionKey: "session",
        agentCommand: "adapter",
        intentToken: "11111111-1111-4111-8111-111111111111",
        launcherPid: 42,
        launcherCreationDate: "133801632000000000",
      },
    })?.method).toBe("registerAdapterIntent");
    expect(decodeBridgeOriginatedRequest({
      ...base,
      method: "resolveAdapterCommand",
      params: { id: "launch-2", sessionKey: "session", agentCommand: "adapter" },
    })?.method).toBe("resolveAdapterCommand");
    expect(decodeBridgeOriginatedRequest({
      ...base,
      method: "resolveAdapterCommand",
      params: {
        id: "launch-2",
        sessionKey: "session",
        agentCommand: "adapter",
        intentToken: "11111111-1111-4111-8111-111111111111",
      },
    })).toBeNull();
    expect(decodeBridgeOriginatedRequest({ ...base, method: "launchSettled", params: {
      id: "launch-1",
      sessionKey: "session",
      intentToken: "11111111-1111-4111-8111-111111111111",
      outcome: "owner-committed",
    } })).toBeNull();
  });
});
