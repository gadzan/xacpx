import { expect, test } from "bun:test";

import {
  MSG,
  errorPayload,
  isErrorPayload,
} from "../../../../packages/relay-protocol/src/messages";
import type { AgentCatalogEntryDto } from "../../../../packages/relay-protocol/src/dtos";

test("message type constants are namespaced and unique", () => {
  const values = Object.values(MSG);
  expect(new Set(values).size).toBe(values.length);
  for (const value of values) {
    expect(value).toMatch(/^(instance|control)\.[a-z][a-z0-9.-]*$/);
  }
});

test("errorPayload/isErrorPayload roundtrip", () => {
  const payload = errorPayload("instance-offline", "instance i-1 is not connected");
  expect(isErrorPayload(payload)).toBe(true);
  expect(payload.error.code).toBe("instance-offline");
  expect(isErrorPayload({ ok: true })).toBe(false);
  expect(isErrorPayload(null)).toBe(false);
  expect(isErrorPayload({ error: { code: 1, message: "x" } })).toBe(false);
  expect(isErrorPayload({ error: "not-an-object" })).toBe(false);
  expect(isErrorPayload({ error: { code: "ok", message: 42 } })).toBe(false);
});

test("new control message types exist with the control. prefix", () => {
  expect(MSG.agentsCatalog).toBe("control.agents.catalog");
  expect(MSG.agentsCreate).toBe("control.agents.create");
  expect(MSG.agentsRemove).toBe("control.agents.remove");
  expect(MSG.workspacesRemove).toBe("control.workspaces.remove");
});

test("recoverable terminal message types use the instance.terminal namespace", () => {
  expect(MSG.terminalOpen).toBe("instance.terminal.open");
  expect(MSG.terminalTakeControl).toBe("instance.terminal.take-control");
  expect(MSG.terminalResync).toBe("instance.terminal.resync");
  expect(MSG.terminalTerminate).toBe("instance.terminal.terminate");
  expect(MSG.terminalStreamStart).toBe("instance.terminal.stream-start");
  expect(MSG.terminalHeartbeat).toBe("instance.terminal.heartbeat");
  expect(MSG.terminalDetach).toBe("instance.terminal.detach");
  expect(MSG.terminalViewerEvent).toBe("instance.terminal.viewer-event");
  expect(MSG.terminalResourceExit).toBe("instance.terminal.resource-exit");
});

test("AgentCatalogEntryDto shape compiles", () => {
  const e: AgentCatalogEntryDto = { driver: "gemini", configured: false, installed: "unknown" };
  expect(e.driver).toBe("gemini");
});
