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
      agentCommand: "npx -y --registry=https://npm.corp.example/ --@agentclientprotocol:registry=https://npm.corp.example/ @agentclientprotocol/codex-acp@1.1.4",
    }),
    new Error("npm ERR! code E404\nnpm ERR! 404 Not Found"),
  );

  expect(reply.text).toContain("xacpx adapter registry set https://registry.npmjs.org/");
  expect(reply.text).toContain("@agentclientprotocol");
});

test("runtime adapter E404 is actionable when a prompt cold-start fails", () => {
  const reply = renderTransportError(
    session({
      agentCommand: "npx -y --registry=https://npm.corp.example/ --@agentclientprotocol:registry=https://npm.corp.example/ @agentclientprotocol/codex-acp@1.1.4",
    }),
    new Error("npm ERR! code E404"),
  );

  expect(reply.text).toContain("xacpx adapter registry set https://registry.npmjs.org/");
});
