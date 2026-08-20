import { expect, test } from "bun:test";

import {
  MSG,
  MAX_CAPABILITIES,
  MAX_CAPABILITY_LENGTH,
  RELAY_CAPABILITIES,
  errorPayload,
  isErrorPayload,
  normalizeCapabilities,
  type InstanceAuthPayload,
  type InstanceRegisterPayload,
} from "../../../../packages/relay-protocol/src/messages";
import { parseControlPayload } from "../../../../packages/relay-protocol/src/payload-validators";
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
  expect(MSG.fsBrowse).toBe("control.fs.browse");
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

test("normalizeCapabilities returns empty for missing/invalid input", () => {
  expect(normalizeCapabilities(undefined)).toEqual([]);
  expect(normalizeCapabilities(null)).toEqual([]);
  expect(normalizeCapabilities("x")).toEqual([]);
  expect(normalizeCapabilities([1, null, {}, ""])).toEqual([]);
});

test("normalizeCapabilities dedupes, drops overlong, and caps count", () => {
  const long = "c".repeat(MAX_CAPABILITY_LENGTH + 1);
  expect(normalizeCapabilities([
    RELAY_CAPABILITIES.terminalRmuxRecoveryV1,
    RELAY_CAPABILITIES.terminalRmuxRecoveryV1,
    "future.cap.v9",
    long,
    RELAY_CAPABILITIES.terminalMultiViewV1,
  ])).toEqual([
    RELAY_CAPABILITIES.terminalRmuxRecoveryV1,
    "future.cap.v9",
    RELAY_CAPABILITIES.terminalMultiViewV1,
  ]);
  const many = Array.from({ length: MAX_CAPABILITIES + 5 }, (_, i) => `cap.${i}`);
  expect(normalizeCapabilities(many)).toHaveLength(MAX_CAPABILITIES);
});

test("InstanceRegisterPayload and InstanceAuthPayload accept optional capabilities", () => {
  const reg: InstanceRegisterPayload = {
    pairingToken: "t",
    capabilities: ["terminal.rmux.recovery.v1"],
  };
  const auth: InstanceAuthPayload = {
    instanceId: "i1",
    credential: "c",
    capabilities: [],
  };
  expect(reg.capabilities).toHaveLength(1);
  expect(auth.capabilities).toEqual([]);
});

test("fsBrowse payload validator accepts empty and path payloads, rejects non-string path", () => {
  expect(parseControlPayload(MSG.fsBrowse, {})).toEqual({});
  expect(parseControlPayload(MSG.fsBrowse, { path: "/srv" })).toEqual({ path: "/srv" });
  expect(parseControlPayload(MSG.fsBrowse, { path: "~" })).toEqual({ path: "~" });
  expect(parseControlPayload(MSG.fsBrowse, { path: 42 })).toBeNull();
  expect(parseControlPayload(MSG.fsBrowse, "nope")).toBeNull();
});
