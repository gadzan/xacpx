import { test, expect } from "bun:test";
import {
  MSG,
  RELAY_CAPABILITIES,
  TERMINAL_ERROR_CODES,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_INPUT_BYTES,
  TERMINAL_REBASE_CHUNK_BYTES,
  MAX_TERMINAL_REBASE_TOTAL_BYTES,
  parseWebServerEvent,
  webEventEnvelope,
  parseWebClientMessage,
  webClientEnvelope,
  parseCanonicalBase64,
  type ControlEventDto,
  type WebClientMessage,
  type WebServerEvent,
  type TerminalOpenResult,
  type TerminalRoleResult,
  type TerminalTerminateResult,
  type TerminalErrorCode,
} from "../../../../packages/relay-protocol/src/index";

test("MSG keeps legacy terminal types and adds recoverable RMUX names", () => {
  expect(MSG.terminalCreate).toBe("control.terminal.create");
  expect(MSG.terminalAttach).toBe("control.terminal.attach");
  expect(MSG.terminalInput).toBe("instance.terminal.input");
  expect(MSG.terminalResize).toBe("instance.terminal.resize");
  expect(MSG.terminalClose).toBe("instance.terminal.close");
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

test("capability constants match the release-gate strings", () => {
  expect(RELAY_CAPABILITIES.terminalRmuxRecoveryV1).toBe("terminal.rmux.recovery.v1");
  expect(RELAY_CAPABILITIES.terminalMultiViewV1).toBe("terminal.multi-view.v1");
});

test("stable terminal error codes are fixed", () => {
  const expected: TerminalErrorCode[] = [
    "terminal-disabled",
    "terminal-rmux-unavailable",
    "terminal-session-not-found",
    "terminal-session-archived",
    "terminal-capacity-exceeded",
    "terminal-viewer-capacity-exceeded",
    "terminal-terminating",
    "terminal-attachment-not-found",
    "terminal-generation-mismatch",
    "terminal-not-controller",
    "terminal-recovery-too-large",
    "terminal-protocol-error",
    "terminal-timeout",
    "instance-offline",
  ];
  expect([...TERMINAL_ERROR_CODES]).toEqual(expected);
});

test("hard limits match the wire contract", () => {
  expect(MAX_TERMINAL_COLS).toBe(500);
  expect(MAX_TERMINAL_ROWS).toBe(300);
  expect(MAX_TERMINAL_INPUT_BYTES).toBe(64 * 1024);
  expect(TERMINAL_REBASE_CHUNK_BYTES).toBe(48 * 1024);
  expect(MAX_TERMINAL_REBASE_TOTAL_BYTES).toBe(2 * 1024 * 1024);
});

test("result DTOs compile with the locked shapes", () => {
  const opened: TerminalOpenResult = {
    terminalId: "t1",
    generation: "g1",
    attachmentId: "a1",
    role: "controller",
    viewerCount: 1,
  };
  const role: TerminalRoleResult = {
    terminalId: "t1",
    generation: "g1",
    attachmentId: "a1",
    role: "controller",
    viewerCount: 2,
  };
  const terminated: TerminalTerminateResult = { status: "terminated" };
  const pending: TerminalTerminateResult = { status: "cleanup-pending" };
  expect(opened.role).toBe("controller");
  expect(role.viewerCount).toBe(2);
  expect(terminated.status).toBe("terminated");
  expect(pending.status).toBe("cleanup-pending");
});

test("legacy terminal-output/exit still survive the web event gate", () => {
  const output: ControlEventDto = { type: "terminal-output", terminalId: "t1", seq: 3, data: "hi" };
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i1", event: output }))).not.toBeNull();
  const exit: ControlEventDto = { type: "terminal-exit", terminalId: "t1", code: 0 };
  expect(parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i1", event: exit }))).not.toBeNull();
});

test("malformed legacy terminal-output is rejected by the gate", () => {
  const bad = webEventEnvelope({
    kind: "control-event",
    instanceId: "i1",
    event: { type: "terminal-output", terminalId: "t1", seq: "nope", data: "x" } as unknown as ControlEventDto,
  });
  expect(parseWebServerEvent(bad)).toBeNull();
});

test("parseWebClientMessage round-trips legacy terminal-input/resize/close", () => {
  const msgs: WebClientMessage[] = [
    { kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" },
    { kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 120, rows: 40 },
    { kind: "terminal-close", instanceId: "i1", terminalId: "t1" },
  ];
  for (const m of msgs) expect(parseWebClientMessage(webClientEnvelope(m))).toEqual(m);
});

test("parseWebClientMessage round-trips recoverable terminal client messages", () => {
  const dataBase64 = Buffer.from("ls\n").toString("base64");
  const msgs: WebClientMessage[] = [
    { kind: "terminal-open", requestId: "r1", instanceId: "i1", sessionAlias: "demo", cols: 80, rows: 24 },
    { kind: "terminal-stream-start", requestId: "r2", instanceId: "i1", attachmentId: "a1" },
    { kind: "terminal-input", instanceId: "i1", attachmentId: "a1", generation: "g1", dataBase64 },
    { kind: "terminal-resize", instanceId: "i1", attachmentId: "a1", generation: "g1", cols: 120, rows: 40 },
    { kind: "terminal-heartbeat", instanceId: "i1", attachmentId: "a1" },
    { kind: "terminal-take-control", requestId: "r3", instanceId: "i1", attachmentId: "a1", generation: "g1" },
    { kind: "terminal-resync", requestId: "r4", instanceId: "i1", attachmentId: "a1", generation: "g1" },
    { kind: "terminal-terminate", requestId: "r5", instanceId: "i1", terminalId: "t1", generation: "g1" },
    { kind: "terminal-detach", instanceId: "i1", attachmentId: "a1" },
  ];
  for (const m of msgs) expect(parseWebClientMessage(webClientEnvelope(m))).toEqual(m);
});

test("parseWebClientMessage rejects browser-stamped viewerId/cwd and invalid sizes", () => {
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "terminal-open", requestId: "r1", instanceId: "i1", sessionAlias: "demo", cols: 80, rows: 24, viewerId: "v1",
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "terminal-open", requestId: "r1", instanceId: "i1", sessionAlias: "demo", cols: 80, rows: 24, cwd: "/tmp",
  } as never))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "terminal-open", requestId: "r1", instanceId: "i1", sessionAlias: "demo", cols: 0, rows: 24,
  }))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "terminal-open", requestId: "r1", instanceId: "i1", sessionAlias: "demo", cols: 80, rows: 999,
  }))).toBeNull();
  expect(parseWebClientMessage(webClientEnvelope({
    kind: "terminal-input", instanceId: "i1", attachmentId: "a1", generation: "g1", dataBase64: "!!!",
  }))).toBeNull();
});

test("parseWebClientMessage rejects wrong envelope/shape", () => {
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "web.client", payload: { kind: "nope" } } as never)).toBeNull();
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "other", payload: {} } as never)).toBeNull();
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "web.client", payload: { kind: "terminal-input", instanceId: "i1", terminalId: "t1" } } as never)).toBeNull();
});

test("targeted recoverable terminal server events round-trip", () => {
  const events: WebServerEvent[] = [
    {
      kind: "terminal-opened",
      requestId: "r1",
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      attachmentId: "a1",
      role: "controller",
      viewerCount: 1,
    },
    {
      kind: "terminal-request-failed",
      requestId: "r1",
      instanceId: "i1",
      code: "terminal-session-not-found",
      message: "missing",
    },
    {
      kind: "terminal-rebase-start",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      nextSequence: 10,
      cols: 80,
      rows: 24,
      alternate: false,
      totalBytes: 4,
      chunkCount: 1,
    },
    {
      kind: "terminal-rebase-chunk",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      index: 0,
      dataBase64: Buffer.from("abcd").toString("base64"),
    },
    {
      kind: "terminal-rebase-end",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
    },
    {
      kind: "terminal-bytes",
      instanceId: "i1",
      attachmentId: "a1",
      generation: "g1",
      epoch: 1,
      sequence: 10,
      dataBase64: Buffer.from("x").toString("base64"),
    },
    {
      kind: "terminal-role-changed",
      instanceId: "i1",
      attachmentId: "a1",
      terminalId: "t1",
      role: "spectator",
      viewerCount: 2,
    },
    {
      kind: "terminal-exit",
      instanceId: "i1",
      terminalId: "t1",
      generation: "g1",
      code: 0,
      reason: "explicit-close",
    },
  ];
  for (const event of events) {
    expect(parseWebServerEvent(webEventEnvelope(event))).toEqual(event);
  }
});

test("targeted terminal events reject invalid generation/size/index/count/sequence", () => {
  expect(parseWebServerEvent(webEventEnvelope({
    kind: "terminal-rebase-start",
    instanceId: "i1",
    attachmentId: "a1",
    generation: "g1",
    epoch: 1,
    nextSequence: 1,
    cols: 80,
    rows: 24,
    alternate: false,
    totalBytes: MAX_TERMINAL_REBASE_TOTAL_BYTES + 1,
    chunkCount: 1,
  }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({
    kind: "terminal-rebase-chunk",
    instanceId: "i1",
    attachmentId: "a1",
    generation: "g1",
    epoch: 1,
    index: -1,
    dataBase64: Buffer.from("x").toString("base64"),
  }))).toBeNull();
  expect(parseWebServerEvent(webEventEnvelope({
    kind: "terminal-bytes",
    instanceId: "i1",
    attachmentId: "a1",
    generation: "g1",
    epoch: 1,
    sequence: 1.5,
    dataBase64: Buffer.from("x").toString("base64"),
  }))).toBeNull();
});

test("parseCanonicalBase64 bounds encoded length before decode and requires round-trip", () => {
  const ok = Buffer.from("hi").toString("base64");
  expect(Buffer.from(parseCanonicalBase64(ok, 16)!).toString()).toBe("hi");
  expect(parseCanonicalBase64("!!!", 16)).toBeNull();
  // Non-canonical (missing padding) must fail the round-trip check.
  expect(parseCanonicalBase64("YQ", 16)).toBeNull();
  const oversizedEncoded = "A".repeat(4 * Math.ceil((MAX_TERMINAL_INPUT_BYTES + 1) / 3));
  expect(parseCanonicalBase64(oversizedEncoded, MAX_TERMINAL_INPUT_BYTES)).toBeNull();
});
