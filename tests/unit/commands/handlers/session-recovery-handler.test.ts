import { expect, test, beforeEach } from "bun:test";
import {
  queueOverflowTipText,
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

test("renderTransportError is silent for confirmed overflow (zh) — no chat text", () => {
  setLocale("zh");
  const error = new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: true,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
    diagnostic: "test diagnostic",
  });
  const reply = renderTransportError(session(), error);
  expect(reply.silent).toBe(true);
  expect(reply.text).toBeUndefined();
  expect(queueOverflowTipText(true)).toBe("部分回复因过长已收束，可直接继续。");
  expect(queueOverflowTipText(true)).not.toContain("\n");
  expect(queueOverflowTipText(true)).not.toMatch(/⚠️|❌/);
});

test("confirmed overflow tip copy is a single soft line (en)", () => {
  setLocale("en");
  expect(queueOverflowTipText(true)).toBe("Reply was truncated for size — you can continue.");
  expect(queueOverflowTipText(true)).not.toContain("/cancel");
  const reply = renderTransportError(session(), new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: true,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
  }));
  expect(reply).toEqual({ silent: true });
});

test("renderTransportError is silent for unconfirmed overflow (en) — copy still asks for /cancel", () => {
  setLocale("en");
  const error = new AcpxQueueOverflowError("cleanup failed");
  const reply = renderTransportError(session(), error);
  expect(reply.silent).toBe(true);
  expect(reply.text).toBeUndefined();
  expect(queueOverflowTipText(false)).toBe("Output was large and cleanup wasn't confirmed — send /cancel, then continue.");
  expect(queueOverflowTipText(false)).not.toContain("\n");
  expect(queueOverflowTipText(false)).not.toMatch(/⚠️|❌/);
  expect(queueOverflowTipText(false)).toContain("/cancel");
  expect(queueOverflowTipText(false)).not.toContain("you can continue");
});

test("renderTransportError downgrades AcpxQueueOverflowError without cleanup to unconfirmed warning (zh)", () => {
  setLocale("zh");
  const error = new AcpxQueueOverflowError();
  // no cleanup => ownerTerminationSucceeded undefined => unconfirmed
  const reply = renderTransportError(session(), error);
  expect(reply.silent).toBe(true);
  expect(reply.text).toBeUndefined();
  expect(queueOverflowTipText(false)).toBe("输出过长且清理未确认，请先发 /cancel 再继续。");
  expect(queueOverflowTipText(false)).not.toContain("\n");
  expect(queueOverflowTipText(false)).not.toMatch(/⚠️|❌/);
  expect(queueOverflowTipText(false)).toContain("/cancel");
  expect(queueOverflowTipText(false)).not.toBe(queueOverflowTipText(true));
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
  expect(reply.silent).toBe(true);
  expect(reply.text).toBeUndefined();
});

test("tryRecoverMissingSession does not recover from AcpxQueueOverflowError even if diagnostic contains No acpx session found", async () => {
  const error = new AcpxQueueOverflowError({
    cancelAttempted: true,
    cancelSucceeded: false,
    ownerTerminationAttempted: true,
    ownerTerminationSucceeded: true,
    diagnostic: "cancel failed: No acpx session found for backend:api-fix",
  });
  let resolveCalled = false;
  let setCalled = false;
  const ops: SessionRecoveryOps = {
    resolveSessionAgentCommand: async () => {
      resolveCalled = true;
      return "different-agent-command";
    },
    setSessionTransportAgentCommand: async () => {
      setCalled = true;
    },
    getSession: async () => session(),
  };
  const result = await tryRecoverMissingSession(ops, session({ agentCommand: "old-command" }), error);
  expect(result).toBeNull();
  expect(resolveCalled).toBe(false);
  expect(setCalled).toBe(false);
});
