import { expect, mock, test } from "bun:test";

import { TransportInvoker } from "../../../src/commands/transport-invoker";
import { createNoopAppLogger } from "../../../src/logging/app-logger";
import { AcpxBridgeTransport } from "../../../src/transport/acpx-bridge/acpx-bridge-transport";
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
    transportEngine: "runtime",
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

test("bridge model and effort reads keep the fresh session's MCP identity stable before its first prompt", async () => {
  const request = mock(async (method: string) => {
    if (method === "getSessionModel") return { available: [] };
    if (method === "getSessionEffort") return { available: [] };
    if (method === "prompt") return { text: "ok" };
    return {};
  });
  const transport = new AcpxBridgeTransport({ request });
  const invoker = makeInvoker(transport);
  const session: ResolvedSession = {
    alias: "relay:demo",
    agent: "codex",
    workspace: "repo",
    cwd: "/repo",
    transportSession: "repo:relay:demo:reset-123",
    transportEngine: "runtime",
  };
  await invoker.ensureTransportSession(session);
  // Relay Web fires model/effort reads in parallel right after session select;
  // both must carry the same stable identity as ensure and the first prompt.
  await Promise.all([transport.getSessionModel(session), transport.getSessionEffort(session)]);
  // Chat config paths warm the same worker: mode/model must not re-key it.
  await invoker.setModeTransportSession(session, "ask");
  await invoker.setModelTransportSession(session, "gpt-5");
  await invoker.promptTransportSession(session, "hi");

  expect(
    request.mock.calls.map(([method, params]) => [
      method,
      params.mcpCoordinatorSession,
      params.mcpSourceHandle,
    ]),
  ).toEqual([
    ["ensureSession", "repo:relay:demo", undefined],
    ["getSessionModel", "repo:relay:demo", undefined],
    ["getSessionEffort", "repo:relay:demo", undefined],
    ["setMode", "repo:relay:demo", undefined],
    ["setModel", "repo:relay:demo", undefined],
    ["prompt", "repo:relay:demo", undefined],
  ]);
  expect(session.mcpCoordinatorSession).toBeUndefined();
});

test("native resume keeps the same stable MCP identity across control reads to its first prompt", async () => {
  const request = mock(async (method: string) => {
    if (method === "getSessionModel") return { available: [] };
    if (method === "getSessionEffort") return { available: [] };
    if (method === "prompt") return { text: "ok" };
    return {};
  });
  const transport = new AcpxBridgeTransport({ request });
  const invoker = makeInvoker(transport);
  // Web/chat native attach: bind an existing agent session, then the UI reads
  // model/effort before the first prompt on the resumed worker.
  const session: ResolvedSession = {
    alias: "relay:attached",
    agent: "codex",
    workspace: "repo",
    cwd: "/repo",
    transportSession: "repo:relay:attached:reset-789",
    transportEngine: "runtime",
  };
  await transport.resumeAgentSession(session, "acpx-record-1");
  await Promise.all([transport.getSessionModel(session), transport.getSessionEffort(session)]);
  await invoker.promptTransportSession(session, "hi");

  expect(
    request.mock.calls.map(([method, params]) => [
      method,
      params.mcpCoordinatorSession,
      params.mcpSourceHandle,
    ]),
  ).toEqual([
    ["resumeAgentSession", "repo:relay:attached", undefined],
    ["getSessionModel", "repo:relay:attached", undefined],
    ["getSessionEffort", "repo:relay:attached", undefined],
    ["prompt", "repo:relay:attached", undefined],
  ]);
  expect(session.mcpCoordinatorSession).toBeUndefined();
});

test("bridge boundary preserves an explicitly bound worker MCP pair on every operation", async () => {
  const request = mock(async (method: string) => {
    if (method === "getSessionModel") return { available: [] };
    if (method === "getSessionEffort") return { available: [] };
    if (method === "prompt") return { text: "ok" };
    return {};
  });
  const transport = new AcpxBridgeTransport({ request });
  const invoker = makeInvoker(transport);
  const session: ResolvedSession = {
    alias: "worker",
    agent: "codex",
    workspace: "repo",
    cwd: "/repo",
    transportSession: "repo:worker",
    transportEngine: "runtime",
    mcpCoordinatorSession: "repo:coordinator",
    mcpSourceHandle: "repo:worker",
  };
  await invoker.ensureTransportSession(session);
  await transport.resumeAgentSession(session, "acpx-record-9");
  await Promise.all([transport.getSessionModel(session), transport.getSessionEffort(session)]);
  await invoker.setModeTransportSession(session, "ask");
  await invoker.promptTransportSession(session, "hi");

  expect(
    request.mock.calls.map(([method, params]) => [
      method,
      params.mcpCoordinatorSession,
      params.mcpSourceHandle,
    ]),
  ).toEqual([
    ["ensureSession", "repo:coordinator", "repo:worker"],
    ["resumeAgentSession", "repo:coordinator", "repo:worker"],
    ["getSessionModel", "repo:coordinator", "repo:worker"],
    ["getSessionEffort", "repo:coordinator", "repo:worker"],
    ["setMode", "repo:coordinator", "repo:worker"],
    ["prompt", "repo:coordinator", "repo:worker"],
  ]);
});

test("cli sessions keep the invoker coordinator binding while direct bridge reads stay none", async () => {
  const request = mock(async (method: string) => {
    if (method === "getSessionModel") return { available: [] };
    if (method === "getSessionEffort") return { available: [] };
    if (method === "prompt") return { text: "ok" };
    return {};
  });
  const transport = new AcpxBridgeTransport({ request });
  const invoker = makeInvoker(transport);
  const session: ResolvedSession = {
    alias: "cli-demo",
    agent: "codex",
    workspace: "repo",
    cwd: "/repo",
    transportSession: "repo:cli-demo:reset-456",
    transportEngine: "cli",
  };

  await invoker.ensureTransportSession(session);
  await Promise.all([transport.getSessionModel(session), transport.getSessionEffort(session)]);
  await invoker.promptTransportSession(session, "hi");

  // Historical behavior: the invoker binds the stable coordinator identity on
  // its own paths (drives the CLI MCP queue owner); direct bridge reads keep
  // the legacy CLI `none` wire shape. CLI has no immutable worker identity,
  // so this split cannot rotate anything.
  expect(
    request.mock.calls.map(([method, params]) => [
      method,
      params.mcpCoordinatorSession,
    ]),
  ).toEqual([
    ["ensureSession", "repo:cli-demo"],
    ["getSessionModel", undefined],
    ["getSessionEffort", undefined],
    ["prompt", "repo:cli-demo"],
  ]);
  expect(session.mcpCoordinatorSession).toBeUndefined();
});
