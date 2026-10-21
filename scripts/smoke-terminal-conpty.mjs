// Node-runtime PTY/ConPTY smoke with the forward-slash cwd used by the daemon.
// Run: node scripts/smoke-terminal-conpty.mjs
import { spawn } from "node-pty";

const MARKER = "__PTY_SMOKE_OK__";

function pickShell() {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

// Forward-slash cwd mirrors production: workspace cwd is stored normalized (C:/x, not C:\x).
const cwd = process.cwd().replace(/\\/g, "/");
const pty = spawn(pickShell(), [], { name: "xterm-256color", cols: 80, rows: 24, cwd });
let buf = "";
pty.onData((d) => { buf += d; });
pty.write(process.platform === "win32"
  ? `echo ${MARKER}\r`
  : "printf '%s%s\\n' '__PTY_SMOKE_' 'OK__'\r");

const deadline = Date.now() + 15000;
while (!buf.includes(MARKER) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
try { pty.kill(); } catch { /* already gone */ }

if (!buf.includes(MARKER)) {
  console.error("PTY smoke FAILED: marker not seen. buffer=", JSON.stringify(buf.slice(0, 500)));
  process.exit(1);
}
console.log("PTY smoke OK (shell + node-pty + forward-slash cwd round-trip)");
process.exit(0);
