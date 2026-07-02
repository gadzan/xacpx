import { test, expect, mock } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "@ganglion/xacpx-relay-protocol";
import { dispatchControlEvent } from "../../../../packages/channel-relay/src/control-bridge";

function fakeControl() {
  return {
    createTerminal: mock(async () => ({ terminalId: "t1" })),
    writeTerminal: mock(() => {}),
    resizeTerminal: mock(() => {}),
    closeTerminal: mock(() => {}),
  };
}

test("dispatchControlEvent routes terminal.input to writeTerminal", () => {
  const control = fakeControl();
  const env: RelayEnvelope = { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalInput, payload: { terminalId: "t1", data: "ls\n" } };
  dispatchControlEvent(control as never, env);
  expect((control.writeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1", "ls\n"]);
});

test("dispatchControlEvent routes terminal.resize and terminal.close", () => {
  const control = fakeControl();
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalResize, payload: { terminalId: "t1", cols: 90, rows: 20 } });
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalClose, payload: { terminalId: "t1" } });
  expect((control.resizeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1", 90, 20]);
  expect((control.closeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1"]);
});

test("dispatchControlEvent ignores unrelated event types", () => {
  const control = fakeControl();
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "instance.something", payload: {} });
  expect((control.writeTerminal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});
