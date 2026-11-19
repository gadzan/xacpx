import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

export const MOCK_ACP_AGENT = resolve(import.meta.dir, "../fixtures/mock-acp-agent.mjs");

const ACPX_CLI_ENTRY = resolve(import.meta.dir, "../../node_modules/acpx/dist/cli.js");

export interface AcpxCliRun {
  code: number;
  out: string;
  err: string;
}

/**
 * Spawn the real acpx CLI against the mock ACP agent inside an isolated home.
 *
 * Two Windows requirements shape this:
 *
 * 1. acpx refuses a raw `--agent "<exe> <script>"` command string on Windows
 *    ("Raw agent command strings are not supported on Windows") — it only
 *    accepts an argv array, and the only way to supply one is its config file
 *    (`<home>/.acpx/config.json` → `agents.<name>.argv`). POSIX accepts the raw
 *    string, so that path is left byte-identical to keep the POSIX baseline.
 * 2. acpx resolves its home through `os.homedir()`, which on Windows reads
 *    USERPROFILE and ignores HOME — so both must point at the isolated dir or
 *    the CLI would read and write the operator's real `~/.acpx`.
 */
export function runAcpxCli(home: string, args: string[]): Promise<AcpxCliRun> {
  const windows = process.platform === "win32";
  if (windows) {
    const configDir = join(home, ".acpx");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      `${JSON.stringify({
        agents: { mock: { argv: [process.execPath, MOCK_ACP_AGENT] } },
        defaultAgent: "mock",
      }, null, 2)}\n`,
    );
  }
  const cliArgs = windows
    ? [ACPX_CLI_ENTRY, ...args]
    : [ACPX_CLI_ENTRY, "--agent", `${process.execPath} ${MOCK_ACP_AGENT}`, ...args];
  const { promise, resolve: resolveRun, reject } = Promise.withResolvers<AcpxCliRun>();
  const child = spawn(process.execPath, cliArgs, {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += String(chunk); });
  child.stderr.on("data", (chunk) => { err += String(chunk); });
  child.on("close", (code) => resolveRun({ code: code ?? 1, out, err }));
  child.on("error", reject);
  return promise;
}
