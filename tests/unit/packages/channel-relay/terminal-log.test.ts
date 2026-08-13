import { expect, test } from "bun:test";

import {
  logTerminalEvent,
  sanitizeTerminalLogFields,
  TERMINAL_LOG_EVENTS,
} from "../../../../packages/channel-relay/src/terminal/terminal-log";

test("TERMINAL_LOG_EVENTS covers the spec §19 catalog", () => {
  expect(TERMINAL_LOG_EVENTS).toContain("relay.terminal.runtime_ready");
  expect(TERMINAL_LOG_EVENTS).toContain("relay.terminal.cleanup_pending");
  expect(TERMINAL_LOG_EVENTS).toContain("relay.terminal.lease_lost");
});

test("sanitizeTerminalLogFields drops bytes/credentials/paths and canary tokens", () => {
  const canaryBytes = "SECRET_TERMINAL_BYTES_CANARY_9f3a";
  const canaryCred = "cred-canary-deadbeef";
  const canaryPath = "/Users/canary/.xacpx/relay/credential.json";

  const safe = sanitizeTerminalLogFields(
    {
      terminalId: "t1",
      generation: "g1",
      byteLength: 12,
      dataBase64: Buffer.from(canaryBytes).toString("base64"),
      keyframe: canaryBytes,
      credential: canaryCred,
      pairingToken: canaryCred,
      cwd: canaryPath,
      bridgeCommand: canaryPath,
      path: canaryPath,
      note: `leaked ${canaryCred} in text`,
      ok: true,
    },
    [canaryBytes, canaryCred, canaryPath],
  );

  const blob = JSON.stringify(safe);
  expect(blob).not.toContain(canaryBytes);
  expect(blob).not.toContain(canaryCred);
  expect(blob).not.toContain(canaryPath);
  expect(safe).toMatchObject({ terminalId: "t1", generation: "g1", byteLength: 12, ok: true });
  expect(safe.dataBase64).toBeUndefined();
  expect(safe.keyframe).toBeUndefined();
  expect(safe.credential).toBeUndefined();
});

test("logTerminalEvent writes only sanitized fields through AppLogger", async () => {
  const events: Array<{ event: string; message: string; context: unknown }> = [];
  const logger = {
    info: async (event: string, message: string, context?: unknown) => {
      events.push({ event, message, context });
    },
    error: async () => {},
    debug: async () => {},
  };

  const canary = "RAW_PTY_OUTPUT_CANARY";
  await logTerminalEvent(
    logger,
    "relay.terminal.terminated",
    {
      terminalId: "term-1",
      status: "terminated",
      data: canary,
      bytes: canary,
    },
    [canary],
  );

  expect(events).toHaveLength(1);
  expect(events[0]?.event).toBe("relay.terminal.terminated");
  expect(JSON.stringify(events[0])).not.toContain(canary);
  expect(events[0]?.context).toMatchObject({ terminalId: "term-1", status: "terminated" });
});
