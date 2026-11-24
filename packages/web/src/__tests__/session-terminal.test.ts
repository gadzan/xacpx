import { expect, test, vi } from "vitest";
import { detachSessionTerminal, killSessionTerminal } from "../lib/session-terminal";
import type { useTerminalStore } from "../stores/terminal";

function mockTerminals(): ReturnType<typeof useTerminalStore> {
  return { detach: vi.fn(), close: vi.fn() } as unknown as ReturnType<typeof useTerminalStore>;
}

test("detachSessionTerminal detaches by local key and does not terminate", () => {
  const terminals = mockTerminals();
  const key = "i1::demo";
  detachSessionTerminal(key, "i1", "demo", terminals);
  expect(terminals.detach).toHaveBeenCalledWith("i1\0demo");
});

test("killSessionTerminal is a deprecated alias that detaches", () => {
  const terminals = mockTerminals();
  killSessionTerminal("i1::demo", "i1", terminals);
  expect(terminals.detach).toHaveBeenCalledWith("i1\0demo");
});
