import { test, expect, mock, spyOn } from "bun:test";
import { AcpxCliTransport } from "../../../src/transport/acpx-cli/acpx-cli-transport";
import { AcpxQueueOverflowError } from "../../../src/transport/acpx-queue-overflow";
import type { ResolvedSession } from "../../../src/transport/types";
import * as launcher from "../../../src/transport/acpx-queue-owner-launcher";

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

function makeRunMock(overrides: {
  cancelShouldFail?: boolean;
  cancelFailMessage?: string;
}) {
  return mock(async (_command: string, args: string[]) => {
    if (args.includes("prompt")) {
      return { code: 1, stdout: "", stderr: "Message buffer exceeded 10485760 bytes" };
    }
    if (args.includes("cancel")) {
      if (overrides.cancelShouldFail) {
        return { code: 1, stdout: "", stderr: overrides.cancelFailMessage ?? "cancel failed: No acpx session found" };
      }
      return { code: 0, stdout: "cancelled", stderr: "" };
    }
    if (args.includes("show") && args.includes("json")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "backend:api-fix:overflow-record" }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

test("acpx-cli prompt overflow is typed after successful cancel and verified termination (confirmed)", async () => {
  const spy = spyOn(launcher, "terminateAcpxQueueOwnerVerified").mockResolvedValue(undefined as never);

  const run = makeRunMock({});
  const transport = new AcpxCliTransport({ command: "acpx" }, run as never);

  try {
    await transport.prompt(session, "hello");
    throw new Error("expected overflow");
  } catch (error) {
    expect(error).toBeInstanceOf(AcpxQueueOverflowError);
    const overflow = error as AcpxQueueOverflowError;
    expect(overflow.code).toBe("ACPX_QUEUE_MESSAGE_OVERFLOW");
    expect(overflow.cleanup?.cancelAttempted).toBe(true);
    expect(overflow.cleanup?.cancelSucceeded).toBe(true);
    expect(overflow.cleanup?.ownerTerminationAttempted).toBe(true);
    expect(overflow.cleanup?.ownerTerminationSucceeded).toBe(true);
    const calls = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls as unknown[][];
    const argLists = calls.map((c) => (c[1] as string[]).join(" "));
    expect(argLists.some((a) => a.includes("prompt"))).toBe(true);
    expect(argLists.some((a) => a.includes(" cancel "))).toBe(true);
    expect(spy).toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("acpx-cli prompt overflow with termination failure is still typed but unconfirmed", async () => {
  const spy = spyOn(launcher, "terminateAcpxQueueOwnerVerified").mockRejectedValue(new Error("terminate failed: lock remained live") as never);

  const run = makeRunMock({});
  const transport = new AcpxCliTransport({ command: "acpx" }, run as never);

  try {
    await transport.prompt(session, "hello");
    throw new Error("expected overflow");
  } catch (error) {
    expect(error).toBeInstanceOf(AcpxQueueOverflowError);
    const overflow = error as AcpxQueueOverflowError;
    expect(overflow.cleanup?.ownerTerminationSucceeded).toBe(false);
    expect(overflow.cleanup?.ownerTerminationAttempted).toBe(true);
    expect(overflow.cleanupDiagnostic).toContain("terminate failed");
    expect(overflow.message).toContain("not retried automatically");
  } finally {
    spy.mockRestore();
  }
});

test("acpx-cli prompt overflow where cancel fails still produces typed error with cancel diagnostic", async () => {
  const spy = spyOn(launcher, "terminateAcpxQueueOwnerVerified").mockResolvedValue(undefined as never);

  const run = makeRunMock({ cancelShouldFail: true, cancelFailMessage: "No acpx session found for backend:api-fix" });
  const transport = new AcpxCliTransport({ command: "acpx" }, run as never);

  try {
    await transport.prompt(session, "hello");
    throw new Error("expected overflow");
  } catch (error) {
    expect(error).toBeInstanceOf(AcpxQueueOverflowError);
    const overflow = error as AcpxQueueOverflowError;
    expect(overflow.cleanup?.cancelSucceeded).toBe(false);
    expect(overflow.cleanupDiagnostic).toContain("No acpx session found");
    expect(overflow.cleanup?.ownerTerminationSucceeded).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("acpx-cli transport does not misclassify provider failure when agent stdout contains overflow code", async () => {
  const spy = spyOn(launcher, "terminateAcpxQueueOwnerVerified").mockResolvedValue(undefined as never);
  // Custom run mock that returns provider failure with agent stdout containing overflow string
  const run = mock(async (_command: string, args: string[]) => {
    if (args.includes("prompt")) {
      return {
        code: 1,
        stdout: JSON.stringify({
          method: "session/update",
          params: {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "QUEUE_MESSAGE_OVERFLOW" },
            },
          },
        }),
        stderr: "provider failed",
      };
    }
    if (args.includes("cancel")) {
      return { code: 0, stdout: "cancelled", stderr: "" };
    }
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: "backend:api-fix:overflow-record" }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const transport = new AcpxCliTransport({ command: "acpx" }, run as never);

  try {
    await transport.prompt(session, "hello");
    throw new Error("expected provider failure");
  } catch (error) {
    // Must remain provider failure, not overflow
    expect(error).not.toBeInstanceOf(AcpxQueueOverflowError);
    expect((error as Error).message).toContain("provider failed");
    expect((error as Error).message).not.toContain("oversized ACP event");
    // No destructive cleanup should have been triggered
    expect(spy).not.toHaveBeenCalled();
    const calls = (run as unknown as { mock: { calls: unknown[][] } }).mock.calls as unknown[][];
    const argLists = calls.map((c) => (c[1] as string[]).join(" "));
    expect(argLists.some((a) => a.includes(" cancel "))).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
