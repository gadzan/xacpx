import { test, expect } from "bun:test";
import {
  MSG, parseWebServerEvent, webEventEnvelope, parseWebClientMessage, webClientEnvelope,
  type ControlEventDto, type WebClientMessage,
} from "../../../../packages/relay-protocol/src/index";

test("MSG has the terminal types", () => {
  expect(MSG.terminalCreate).toBe("control.terminal.create");
  expect(MSG.terminalInput).toBe("instance.terminal.input");
  expect(MSG.terminalResize).toBe("instance.terminal.resize");
  expect(MSG.terminalClose).toBe("instance.terminal.close");
});

test("terminal-output survives the web event gate", () => {
  const event: ControlEventDto = { type: "terminal-output", terminalId: "t1", seq: 3, data: "hi" };
  const env = webEventEnvelope({ kind: "control-event", instanceId: "i1", event });
  const parsed = parseWebServerEvent(env);
  expect(parsed).not.toBeNull();
  expect((parsed as { event: ControlEventDto }).event).toEqual(event);
});

test("terminal-exit survives the web event gate", () => {
  const event: ControlEventDto = { type: "terminal-exit", terminalId: "t1", code: 0 };
  const parsed = parseWebServerEvent(webEventEnvelope({ kind: "control-event", instanceId: "i1", event }));
  expect(parsed).not.toBeNull();
});

test("malformed terminal-output is rejected by the gate", () => {
  const bad = webEventEnvelope({ kind: "control-event", instanceId: "i1", event: { type: "terminal-output", terminalId: "t1", seq: "nope", data: "x" } as unknown as ControlEventDto });
  expect(parseWebServerEvent(bad)).toBeNull();
});

test("parseWebClientMessage round-trips terminal-input/resize/close", () => {
  const msgs: WebClientMessage[] = [
    { kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" },
    { kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 120, rows: 40 },
    { kind: "terminal-close", instanceId: "i1", terminalId: "t1" },
  ];
  for (const m of msgs) expect(parseWebClientMessage(webClientEnvelope(m))).toEqual(m);
});

test("parseWebClientMessage rejects wrong envelope/shape", () => {
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "web.client", payload: { kind: "nope" } } as never)).toBeNull();
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "other", payload: {} } as never)).toBeNull();
  expect(parseWebClientMessage({ protocolVersion: 1, kind: "event", type: "web.client", payload: { kind: "terminal-input", instanceId: "i1", terminalId: "t1" } } as never)).toBeNull();
});
