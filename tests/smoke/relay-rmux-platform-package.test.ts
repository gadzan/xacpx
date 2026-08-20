/**
 * Production-platform-package smoke: resolve the bridge + bundled RMUX from
 * the real npm layout, then run a live create → input → recover → resize → kill
 * cycle with a HOSTILE fake RMUX on PATH that must never be executed.
 *
 * Requires (publish workflow / Windows CI only, never default CI):
 *   XACPX_RMUX_PLATFORM_PACKAGE=1
 * and the freshly packed platform package installed (over) into
 *   node_modules/@ganglion/xacpx-rmux-bridge-<os>-<arch>
 * so the production resolver finds it via require.resolve. No explicit
 * terminal.rmuxCommand / bridgeCommand may be set — the point is to exercise
 * production resolution (bundled RMUX wins over PATH/helper and resolves the
 * dedicated rmux-daemon, never the public rmux CLI).
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { parseRelayTerminalConfig } from "../../packages/channel-relay/src/config";
import {
  createProductionTerminalDriver,
  type RmuxSidecarSupervisor,
} from "../../packages/channel-relay/src/terminal/rmux-sidecar-supervisor";
import { resolveRmuxBinaries, RMUX_BUNDLED_VERSION } from "../../packages/channel-relay/src/terminal/resolve-rmux-binaries";
import type { RmuxRecoveryEvent, RmuxTerminalDriver } from "../../packages/channel-relay/src/terminal/rmux-driver";

setDefaultTimeout(120_000);

const enabled = process.env.XACPX_RMUX_PLATFORM_PACKAGE === "1";

const dirs: string[] = [];
const live: Array<{ supervisor: RmuxSidecarSupervisor }> = [];
let markerPath: string | null = null;

afterEach(async () => {
  while (live.length > 0) {
    const item = live.pop();
    if (item) {
      try {
        await item.supervisor.stop();
      } catch {
        // ignore
      }
    }
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Real PE (Windows) or sh script (POSIX) that marks a file when executed. */
function fabricateHostileFake(dir: string, name: string, marker: string): string {
  const path = join(dir, name);
  if (process.platform === "win32") {
    const ps = `
Add-Type -TypeDefinition 'using System; using System.IO; static class FakeRmux { public static void Main() { File.AppendAllText(Environment.GetEnvironmentVariable("XACPX_FAKEMUX_MARKER") ?? "_marker_missing", "ran\\n"); } }' -OutputAssembly '${path}' -OutputType ConsoleApplication
`;
    const res = Bun.spawnSync(["powershell", "-NoProfile", "-Command", ps]);
    if (res.exitCode !== 0) throw new Error(`failed to fabricate ${name}: ${res.stderr.toString()}`);
  } else {
    writeFileSync(path, `#!/bin/sh\nprintf 'ran\\n' >> "\${XACPX_FAKEMUX_MARKER:-/tmp/_marker_missing}"\n`);
    const chmod = Bun.spawnSync(["chmod", "+x", path]);
    expect(chmod.exitCode).toBe(0);
  }
  return path;
}

function collectUntil(
  stream: AsyncIterable<RmuxRecoveryEvent>,
  pred: (events: RmuxRecoveryEvent[]) => boolean,
  timeoutMs = 30_000,
): Promise<RmuxRecoveryEvent[]> {
  return (async () => {
    const events: RmuxRecoveryEvent[] = [];
    const iter = stream[Symbol.asyncIterator]();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const step = await Promise.race([
        iter.next().then((value) => ({ kind: "next" as const, value })),
        Bun.sleep(remaining).then(() => ({ kind: "timeout" as const })),
      ]);
      if (step.kind === "timeout") break;
      if (step.value.done) break;
      events.push(step.value.value);
      if (pred(events)) {
        void iter.return?.();
        return events;
      }
    }
    void iter.return?.();
    throw new Error(`collectUntil timeout; types=${events.map((e) => e.type).join(",")}`);
  })();
}

test.skipIf(!enabled)("bundled RMUX daemon is resolved over a hostile PATH fake; live lifecycle works and the fake is never executed", async () => {
  // --- Hostile environment: fake rmux 0.9-ish at the FRONT of PATH -----------
  const hostileDir = tempDir("rmux-hostile-");
  const marker = join(hostileDir, "fake-ran.marker");
  markerPath = marker;
  process.env.XACPX_FAKEMUX_MARKER = marker;
  const fakeRmux = fabricateHostileFake(hostileDir, process.platform === "win32" ? "rmux.exe" : "rmux", marker);
  const fakeDaemon = fabricateHostileFake(
    hostileDir,
    process.platform === "win32" ? "rmux-daemon.exe" : "rmux-daemon",
    marker,
  );
  const hostilePath = hostileDir + delimiter + (process.env.PATH ?? "");

  // Resolution AND the production lifecycle must see the hostile PATH. The
  // supervisor reads process.env.PATH at resolution time and the bridge child
  // inherits { ...process.env }, so swapping PATH for the whole lifecycle
  // proves the fake can never be selected or executed anywhere in the chain.
  const oldPath = process.env.PATH;
  process.env.PATH = hostilePath;
  try {
    // --- Production resolution must pick the bundled platform-package daemon -
    const resolved = resolveRmuxBinaries({
      pathEnv: process.env.PATH,
      platformPackageResolver: undefined,
    });
    expect(resolved.source.bridge).toBe("platform-package");
    expect(resolved.rmuxCommand, "bundled RMUX daemon must exist next to the platform bridge").toBeDefined();
    expect(resolved.source.rmux).toBe("platform-package");
    expect(basename(resolved.rmuxCommand!)).toBe(
      process.platform === "win32" ? "rmux-daemon.exe" : "rmux-daemon",
    );
    expect(resolved.rmuxCommand).not.toBe(fakeRmux);
    expect(resolved.rmuxCommand).not.toBe(fakeDaemon);

    // The public bundled CLI remains the version probe authority. Resolve its
    // path beside the dedicated daemon instead of executing the daemon itself.
    const bundledCli = join(
      resolved.rmuxCommand!.slice(0, -basename(resolved.rmuxCommand!).length),
      process.platform === "win32" ? "rmux.exe" : "rmux",
    );
    const probe = Bun.spawnSync([bundledCli, "-V"], { encoding: "utf8" });
    expect(probe.exitCode).toBe(0);
    expect(`${probe.stdout}${probe.stderr}`).toContain(`rmux ${RMUX_BUNDLED_VERSION}`);

    // --- Live lifecycle through the PRODUCTION sidecar (no explicit commands) --
    const cwd = tempDir("rmux-smoke-pkg-");
    const config = parseRelayTerminalConfig({ enabled: true, ownerLeaseTtlSeconds: 30 });
    const prod = await createProductionTerminalDriver(config);
    live.push(prod);

    const name = `xacpx-pkg-smoke-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const handle = await prod.driver.create({
      name,
      cwd,
      cols: 132,
      rows: 47,
      historyLimit: 2000,
      tags: ["xacpx:relay", "smoke:platform-package"],
      ownerLeaseTtlSeconds: 30,
    });

    const recoveryP = collectUntil(
      prod.driver.recover(handle.paneId),
      (events) => events.some((e) => e.type === "rebase") && events.some((e) => e.type === "bytes" && e.data.byteLength > 0),
    );
    await Bun.sleep(200);
    await prod.driver.input(handle.paneId, new TextEncoder().encode("echo pkg-smoke-ok\n"));
    const events = await recoveryP;
    const initialRebase = events.find(
      (event): event is Extract<RmuxRecoveryEvent, { type: "rebase" }> => event.type === "rebase",
    );
    expect(initialRebase).toBeDefined();
    expect(initialRebase!.cols).toBe(132);
    expect(initialRebase!.rows).toBe(47);

    // The exact production package must also prove that a subsequent resize
    // reaches the native RMUX pane. Starting a fresh recovery after resize gives
    // us an authoritative rebase geometry instead of merely checking that the
    // resize RPC returned.
    await prod.driver.resize(handle.paneId, 111, 39);
    const resized = await collectUntil(
      prod.driver.recover(handle.paneId),
      (next) => next.some((event) => event.type === "rebase"),
    );
    const resizedRebase = resized.find(
      (event): event is Extract<RmuxRecoveryEvent, { type: "rebase" }> => event.type === "rebase",
    );
    expect(resizedRebase).toBeDefined();
    expect(resizedRebase!.cols).toBe(111);
    expect(resizedRebase!.rows).toBe(39);
    await prod.driver.kill(handle.sessionId);
    expect((await prod.driver.list()).every((e) => e.name !== name)).toBe(true);

    // --- Hostile regression proof: the PATH fake(s) were never executed ------
    // PATH is still hostile here; the marker would exist if anything on PATH
    // had been invoked by the resolver, the sidecar, or the terminal shell.
    await live.pop()?.supervisor.stop();
    expect(existsSync(marker), "PATH fake rmux must never execute").toBe(false);
    expect(hostilePath.includes(hostileDir)).toBe(true);
  } finally {
    process.env.PATH = oldPath;
  }

  // Sanity: the fake would have marked if actually invoked.
  const direct = Bun.spawnSync([fakeDaemon, "-V"], {
    encoding: "utf8",
    env: { ...process.env, XACPX_FAKEMUX_MARKER: marker },
  });
  void direct;
  expect(existsSync(marker), "fake binary must be self-marking (test sanity)").toBe(true);
});