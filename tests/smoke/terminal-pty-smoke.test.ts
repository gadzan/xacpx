// Real-PTY smoke: spawns an actual shell via node-pty (no injected spawn) and asserts the
// byte stream round-trips. NOT run by `npm test` (tests/unit only) — invoked explicitly by
// the windows-latest CI leg to validate ConPTY, and runnable locally on macOS/Linux.
import { test, expect } from "bun:test";
import { createTerminalService } from "../../src/control/terminal-service";
import { createControlEventBus, type ControlEvent } from "../../src/control/control-event-bus";

const MARKER = "__PTY_SMOKE_OK__";

test("spawns a real shell and round-trips output", async () => {
  const events = createControlEventBus();
  let buf = "";
  events.subscribe((e: ControlEvent) => {
    if (e.type === "terminal-output") buf += e.data;
  });
  const svc = createTerminalService({ events, idleTimeoutSeconds: () => 900 });
  const { terminalId } = svc.create({ cwd: process.cwd(), cols: 80, rows: 24 });

  // `echo <marker>` prints the marker in pwsh / powershell / cmd / bash / zsh alike.
  // The trailing CR submits the line.
  svc.write(terminalId, `echo ${MARKER}\r`);

  const deadline = Date.now() + 15000;
  while (!buf.includes(MARKER) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(buf).toContain(MARKER);

  expect(() => svc.close(terminalId)).not.toThrow();
}, 20000);
