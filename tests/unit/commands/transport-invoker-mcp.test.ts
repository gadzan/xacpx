import { expect, test } from "bun:test";

import { TransportInvoker } from "../../../src/commands/transport-invoker";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";

function makeInvoker(transport: SessionTransport): TransportInvoker {
  return new TransportInvoker({
    transport,
    logger: createNoopAppLogger(),
    sessions: {},
    resolveSessionAgentCommand: async () => undefined,
    autoInstall: async () => ({ ok: false, errors: [], logPath: "" }),
    discoverPaths: async () => [],
  } as never);
}

test("a fresh session uses the same stable MCP identity for ensure and its first prompt", async () => {
  let ensuredMcpIdentity: string | undefined;
  const seenMcpIdentities: Array<string | undefined> = [];
  const transport = {
    async ensureSession(session: ResolvedSession) {
      ensuredMcpIdentity = session.mcpCoordinatorSession;
      seenMcpIdentities.push(ensuredMcpIdentity);
    },
    async prompt(session: ResolvedSession) {
      seenMcpIdentities.push(session.mcpCoordinatorSession);
      if (!ensuredMcpIdentity || session.mcpCoordinatorSession !== ensuredMcpIdentity) {
        throw new Error(
          "Persistent ACP session fresh-acp-id could not be resumed: Internal error",
        );
      }
      return { text: "ok" };
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);
  const session: ResolvedSession = {
    alias: "relay:demo",
    agent: "codex",
    workspace: "repo",
    cwd: "/repo",
    transportSession: "repo:relay:demo:reset-123",
  };

  await invoker.ensureTransportSession(session);
  expect(session.mcpCoordinatorSession).toBeUndefined();
  await expect(invoker.promptTransportSession(session, "hi")).resolves.toEqual({
    text: "ok",
  });
  expect(seenMcpIdentities).toEqual([
    "repo:relay:demo",
    "repo:relay:demo",
  ]);
});

test("ensure preserves an explicitly bound worker MCP identity", async () => {
  const seen: Array<[string | undefined, string | undefined]> = [];
  const transport = {
    async ensureSession(session: ResolvedSession) {
      seen.push([session.mcpCoordinatorSession, session.mcpSourceHandle]);
    },
  } as unknown as SessionTransport;
  const invoker = makeInvoker(transport);
  const session: ResolvedSession = {
    alias: "worker",
    agent: "codex",
    workspace: "repo",
    cwd: "/repo",
    transportSession: "repo:worker",
    mcpCoordinatorSession: "repo:coordinator",
    mcpSourceHandle: "repo:worker",
  };

  await invoker.ensureTransportSession(session);

  expect(seen).toEqual([["repo:coordinator", "repo:worker"]]);
});
