// packages/relay-web/src/__tests__/session-terminal.test.ts
import { expect, test, vi } from "vitest";
import { killSessionTerminal } from "../lib/session-terminal";
import { saveTerminalId, loadTerminalId, clearTerminalId } from "../lib/terminal-sessions";
import type { useTerminalStore } from "../stores/terminal";

function mockTerminals(): ReturnType<typeof useTerminalStore> {
  return { close: vi.fn() } as unknown as ReturnType<typeof useTerminalStore>;
}

test("killSessionTerminal closes the PTY and clears the persisted id when one exists", () => {
  const key = "i1::demo";
  saveTerminalId(key, "tid-1");
  const terminals = mockTerminals();

  killSessionTerminal(key, "i1", terminals);

  expect(terminals.close).toHaveBeenCalledWith("i1", "tid-1");
  expect(loadTerminalId(key)).toBeNull();
});

test("killSessionTerminal is a no-op (does not call close) when the session has no persisted terminal id", () => {
  const key = "i1::demo";
  clearTerminalId(key); // ensure no stale id from another test
  const terminals = mockTerminals();

  killSessionTerminal(key, "i1", terminals);

  expect(terminals.close).not.toHaveBeenCalled();
  expect(loadTerminalId(key)).toBeNull();
});
