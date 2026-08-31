import { expect, test, beforeEach } from "bun:test";
import {
  renderSessionCreationError,
  renderSessionCreationVerificationError,
  renderTransportError,
  tryRecoverMissingSession,
} from "../../../../src/commands/handlers/session-recovery-handler";
import type { SessionRecoveryOps } from "../../../../src/commands/router-types";
import type { ResolvedSession } from "../../../../src/transport/types";
import { setLocale, t } from "../../../../src/i18n";
import { AcpxQueueOverflowError } from "../../../../src/transport/acpx-queue-overflow";

beforeEach(() => {
  setLocale("zh");
});

function session(overrides: Partial<ResolvedSession> = {}): ResolvedSession {
  return {
    alias: "review",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:codex",
    agentCommand: "codex",
    cwd: "/tmp/backend",
    ...overrides,
  };
}

test("renderTransportError quotes a workspace name with spaces in the attach hint", () => {
  const reply = renderTransportError(
    session({ workspace: "My Repo", cwd: "/tmp/My Repo" }),
    new Error("No acpx session found"),
  );

  expect(reply.text).toContain(
    t().recovery.sessionUnavailableAttachHint("review", "codex", '"My Repo"'),
  );
});

test("renderTransportError leaves a clean workspace name unquoted in the attach hint", () => {
  const reply = renderTransportError(
    session({ workspace: "backend" }),
    new Error("No acpx session found"),
  );

  expect(reply.text).toContain(
    t().recovery.sessionUnavailableAttachHint("review", "codex", "backend"),
  );
});

test("renderTransportError quotes a workspace name with spaces in the /session new hint", () => {
  const reply = renderTransportError(
    session({ workspace: "My Repo" }),
    new Error("No acpx session found"),
  );

  expect(reply.text).toContain(
    t().recovery.sessionUnavailableRenewHint("review", "codex", '"My Repo"'),
  );
});

test("renderTransportError gives a scheduled-appropriate message for a transient session (no /session advice)", () => {
  const reply = renderTransportError(
    session({ alias: "later-k8f2", transient: true }),
    new Error("No acpx session found"),
  );

  expect(reply.text).toContain(t().recovery.transientSessionFailed);
  expect(reply.text).toContain(t().recovery.transientSessionHint);
  expect(reply.text).not.toContain("/session new");
  expect(reply.text).not.toContain("/session attach");
});

test("tryRecoverMissingSession skips persisted recovery for a transient session", async () => {
  let touchedPersistence = false;
  const ops: SessionRecoveryOps = {
    resolveSessionAgentCommand: async () => "a-different-command",
    setSessionTransportAgentCommand: async () => {
      touchedPersistence = true;
    },
    getSession: async () => null,
  };

  const result = await tryRecoverMissingSession(
    ops,
    session({ alias: "later-k8f2", transient: true }),
    new Error("No acpx session found"),
  );

  expect(result).toBeNull();
  expect(touchedPersistence).toBe(false);
});

test("renderSessionCreationVerificationError quotes a workspace name with spaces", () => {
  const reply = renderSessionCreationVerificationError(session({ workspace: "My Repo", cwd: "/tmp/My Repo" }));

  expect(reply.text).toContain(
    t().recovery.sessionCreationAttachHint("review", "codex", '"My Repo"'),
  );
});

test("renderSessionCreationVerificationError leaves a clean workspace name unquoted", () => {
  const reply = renderSessionCreationVerificationError(session({ workspace: "backend" }));

  expect(reply.text).toContain(
    t().recovery.sessionCreationAttachHint("review", "codex", "backend"),
  );
});

test("runtime adapter E404 points session creation to the registry CLI", () => {
  const reply = renderSessionCreationError(
    session({
      agentCommand: "npx -y --registry=https://npm.corp.example/ --@agentclientprotocol:registry=https://npm.corp.example/ @agentclientprotocol/codex-acp@1.1.9",
    }),
    new Error("npm ERR! code E404\nnpm ERR! 404 Not Found"),
  );

  expect(reply.text).toContain("xacpx adapter registry set https://registry.npmjs.org");
  expect(reply.text).toContain("@agentclientprotocol");
});

test("runtime adapter E404 is actionable when a prompt cold-start fails", () => {
  const reply = renderTransportError(
    session({
      agentCommand: "npx -y --registry=https://npm.corp.example/ --@agentclientprotocol:registry=https://npm.corp.example/ @agentclientprotocol/codex-acp@1.1.9",
    }),
    new Error("npm ERR! code E404"),
  );

  expect(reply.text).toContain("xacpx adapter registry set https://registry.npmjs.org");
});

test("a non-npm backend 404 is not misreported as an adapter registry failure", () => {
  const error = new Error("model endpoint returned 404 Not Found");
  expect(() => renderSessionCreationError(
    session({
      agentCommand: "npx -y --registry=https://npm.corp.example/ --@agentclientprotocol:registry=https://npm.corp.example/ @agentclientprotocol/codex-acp@1.1.9",
    }),
    error,
  )).toThrow(error);
});
test("renderTransportError downgrades AcpxQueueOverflowError to soft warning (zh) when cleanup is confirmed", () => {
  setLocale("zh");
  const error = new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: true,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
    diagnostic: "test diagnostic",
  });
  const reply = renderTransportError(session(), error);
  expect(reply.text).toBe([t().recovery.queueOverflowWarning, t().recovery.queueOverflowHint].join("\n"));
  expect(reply.text).not.toContain("Execution error");
  expect(reply.text).not.toContain("错误信息");
  expect(reply.text).toContain("可直接继续");
});

test("renderTransportError downgrades AcpxQueueOverflowError to unconfirmed soft warning (en) when cleanup is not confirmed", () => {
  setLocale("en");
  const error = new AcpxQueueOverflowError("cleanup failed");
  const reply = renderTransportError(session(), error);
  expect(reply.text).toBe([t().recovery.queueOverflowWarning, t().recovery.queueOverflowUnconfirmedHint].join("\n"));
  expect(reply.text).not.toContain("Execution error");
  expect(reply.text).not.toContain("ready for your next message");
  expect(reply.text).toContain("/cancel");
});

test("renderTransportError downgrades AcpxQueueOverflowError without cleanup to unconfirmed warning (zh)", () => {
  setLocale("zh");
  const error = new AcpxQueueOverflowError();
  // no cleanup => ownerTerminationSucceeded undefined => unconfirmed
  const reply = renderTransportError(session(), error);
  expect(reply.text).toContain(t().recovery.queueOverflowUnconfirmedHint);
  expect(reply.text).not.toContain(t().recovery.queueOverflowHint);
});

test("renderTransportError does not soft-downgrade raw buffer overflow without cleanup (remains hard error)", () => {
  setLocale("en");
  const error = new Error("Message buffer exceeded 10485760 bytes");
  expect(() => renderTransportError(session(), error)).toThrow(error);
});

test("renderTransportError does not soft-downgrade generic overflow code without typed error (remains hard)", () => {
  setLocale("zh");
  const error = Object.assign(new Error("ACPX_QUEUE_MESSAGE_OVERFLOW"), { code: "ACPX_QUEUE_MESSAGE_OVERFLOW" });
  // This generic error is not an AcpxQueueOverflowError instance, so it stays hard.
  // In production the bridge client reconstructs it as AcpxQueueOverflowError before it reaches here.
  expect(() => renderTransportError(session(), error)).toThrow(error);
});

test("bridge-reconstructed AcpxQueueOverflowError with confirmed cleanup is still soft ready", () => {
  setLocale("zh");
  // Simulate bridge client reconstruction: new AcpxQueueOverflowError(cleanup)
  const error = new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: true,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
  });
  const reply = renderTransportError(session(), error);
  expect(reply.text).toContain(t().recovery.queueOverflowHint);
});
