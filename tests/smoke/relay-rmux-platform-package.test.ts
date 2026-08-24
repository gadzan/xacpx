/**
 * Production-platform-package smoke: resolve the bridge + bundled RMUX from
 * the real npm layout, then run a live create → input → recover → resize → kill
 * cycle with a HOSTILE fake RMUX on PATH and a poisoned user-default daemon;
 * neither may be used by the production bridge.
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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { parseRelayTerminalConfig } from "../../packages/channel-relay/src/config";
import {
  createProductionTerminalDriver,
  type RmuxSidecarSupervisor,
} from "../../packages/channel-relay/src/terminal/rmux-sidecar-supervisor";
import { RmuxSidecarDriver } from "../../packages/channel-relay/src/terminal/rmux-sidecar-driver";
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

function outputText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
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

function recoveryText(events: RmuxRecoveryEvent[]): string {
  return Buffer.concat(
    events
      .filter((event): event is Extract<RmuxRecoveryEvent, { type: "bytes" }> =>
        event.type === "bytes")
      .map((event) => Buffer.from(event.data)),
  ).toString("utf8");
}

test.skipIf(!enabled)("bundled RMUX ignores hostile PATH and a poisoned default daemon; private lifecycle is lazy and retired", async () => {
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
  const hostileHome = tempDir("rmux-hostile-home-");
  const hostileConfig = process.platform === "win32"
    ? join(hostileDir, "rmux.conf")
    : join(hostileHome, ".rmux.conf");
  writeFileSync(hostileConfig, "set-option -g exit-empty off\n");
  const endpointLabel = `xacpx-relay-smoke-${process.pid}-${Date.now()}`;
  const poisonName = `xacpx-default-poison-${process.pid}-${Date.now()}`;

  // Resolution AND the production lifecycle must see the hostile PATH. The
  // supervisor reads process.env.PATH at resolution time and the bridge child
  // inherits { ...process.env }, so swapping PATH for the whole lifecycle
  // proves the fake can never be selected or executed anywhere in the chain.
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  const oldXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const oldRmuxConfig = process.env.RMUX_CONFIG_FILE;
  let bundledCliForCleanup: string | undefined;
  let poisonedDefault: {
    child: ChildProcessWithoutNullStreams;
    driver: RmuxSidecarDriver;
    stderr: string;
  } | undefined;
  process.env.PATH = hostilePath;
  process.env.HOME = hostileHome;
  delete process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32") process.env.RMUX_CONFIG_FILE = hostileConfig;
  else delete process.env.RMUX_CONFIG_FILE;
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
    bundledCliForCleanup = bundledCli;
    const probe = Bun.spawnSync([bundledCli, "-V"], { encoding: "utf8" });
    expect(probe.exitCode).toBe(0);
    expect(`${probe.stdout}${probe.stderr}`).toContain(`rmux ${RMUX_BUNDLED_VERSION}`);

    // Occupy the user default endpoint through the exact packed bridge and
    // resolved daemon. Do not ask the public CLI to cold-start here: on the
    // Windows split layout its full helper lives under libexec/rmux while the
    // dedicated daemon lives under bin, so that is not a valid production
    // daemon-resolution path. Once the daemon exists, the CLI can safely
    // connect to label `default` for option mutation and assertions.
    Bun.spawnSync([bundledCli, "kill-server"], { encoding: "utf8" });
    const poisonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RMUX_SDK_DAEMON_BINARY: resolved.rmuxCommand!,
      XACPX_RMUX_ENDPOINT_LABEL: "default",
    };
    delete poisonEnv.XACPX_RMUX_DAEMON_BINARY;
    if (process.platform === "win32") poisonEnv.RMUX_CONFIG_FILE = hostileConfig;
    else delete poisonEnv.RMUX_CONFIG_FILE;
    const poisonChild = spawn(resolved.bridgeCommand, [], {
      env: poisonEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    poisonedDefault = {
      child: poisonChild,
      driver: new RmuxSidecarDriver({
        stdin: poisonChild.stdin,
        stdout: poisonChild.stdout,
        stderr: poisonChild.stderr,
        kill: (signal) => poisonChild.kill(signal),
        on: (event, listener) => poisonChild.on(event, listener as never),
      }),
      stderr: "",
    };
    poisonChild.stderr.on("data", (chunk: Buffer | string) => {
      if (poisonedDefault) {
        poisonedDefault.stderr = `${poisonedDefault.stderr}${chunk}`.slice(-4 * 1024);
      }
    });
    try {
      await poisonedDefault.driver.handshake();
      await poisonedDefault.driver.create({
        name: poisonName,
        cwd: hostileHome,
        cols: 80,
        rows: 24,
        historyLimit: 200,
        tags: ["xacpx:relay", "smoke:poisoned-default"],
        ownerLeaseTtlSeconds: 30,
      });
    } catch (error) {
      throw new Error(
        `poisoned default bootstrap failed; bridge stderr=${poisonedDefault.stderr || "<empty>"}`,
        { cause: error },
      );
    }
    const poisonedExitEmpty = Bun.spawnSync(
      [bundledCli, "-L", "default", "show-options", "-gqv", "exit-empty"],
      { encoding: "utf8" },
    );
    expect(
      poisonedExitEmpty.exitCode,
      `poisoned default option probe failed: stdout=${outputText(poisonedExitEmpty.stdout)} stderr=${outputText(poisonedExitEmpty.stderr)}`,
    ).toBe(0);
    expect(outputText(poisonedExitEmpty.stdout).trim()).toBe("off");
    expect(Bun.spawnSync(
      [bundledCli, "-L", "default", "set-option", "-g", "default-command", "exit 97"],
      { encoding: "utf8" },
    ).exitCode).toBe(0);

    // --- Live lifecycle through the PRODUCTION sidecar (no explicit commands) --
    const cwd = tempDir("rmux-smoke-pkg-");
    const config = parseRelayTerminalConfig({ enabled: true, ownerLeaseTtlSeconds: 30 });
    const prod = await createProductionTerminalDriver(config, {
      endpointLabelFactory: () => endpointLabel,
    });
    live.push(prod);

    // Handshake/diagnostics are sidecar-local: terminal.enabled alone must not
    // start an RMUX daemon before the first true terminal operation.
    const lazyProbe = Bun.spawnSync(
      [bundledCli, "-L", endpointLabel, "kill-server"],
      { encoding: "utf8" },
    );
    expect(lazyProbe.exitCode, "bridge bootstrap must leave RMUX dormant").not.toBe(0);

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
      (events) =>
        events.some((event) => event.type === "rebase")
        && recoveryText(events).includes("pkg-smoke-ok"),
    );
    await Bun.sleep(200);
    const smokeCommand = process.platform === "win32"
      ? "echo pkg-smoke-ok\n"
      : "printf 'pkg-smoke-ok|%s\\n' \"$HOME\"\n";
    await prod.driver.input(handle.paneId, new TextEncoder().encode(smokeCommand));
    const events = await recoveryP;
    const initialRebase = events.find(
      (event): event is Extract<RmuxRecoveryEvent, { type: "rebase" }> => event.type === "rebase",
    );
    expect(initialRebase).toBeDefined();
    expect(initialRebase!.cols).toBe(132);
    expect(initialRebase!.rows).toBe(47);
    expect(recoveryText(events)).toContain("pkg-smoke-ok");
    if (process.platform !== "win32") {
      expect(recoveryText(events)).toContain(hostileHome);
    }

    // The parent test process advertises a hostile exit-empty=off config, but
    // the private process-owned daemon must ignore it so a hard bridge crash
    // can retire after KillOnOwnerExit reaps its final session.
    const exitEmpty = Bun.spawnSync(
      [bundledCli, "-L", endpointLabel, "show-options", "-gqv", "exit-empty"],
      { encoding: "utf8" },
    );
    expect(exitEmpty.exitCode).toBe(0);
    expect(outputText(exitEmpty.stdout).trim()).toBe("on");

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

    // The dedicated lifecycle must not mutate or shut down the poisoned user
    // default daemon.
    const poisonStillLive = Bun.spawnSync(
      [bundledCli, "-L", "default", "has-session", "-t", poisonName],
      { encoding: "utf8" },
    );
    expect(
      poisonStillLive.exitCode,
      `poisoned default disappeared: stdout=${outputText(poisonStillLive.stdout)} stderr=${outputText(poisonStillLive.stderr)} bridge-stderr=${poisonedDefault.stderr || "<empty>"}`,
    ).toBe(0);

    // Leave one private session live so supervisor.stop must use the bridge's
    // explicit Rmux::shutdown path; an already-empty daemon could otherwise
    // disappear via exit-empty and give a false-positive retirement check.
    const shutdownSentinel = await prod.driver.create({
      name: `xacpx-pkg-shutdown-${Date.now()}`,
      cwd,
      cols: 80,
      rows: 24,
      historyLimit: 200,
      tags: ["xacpx:relay", "smoke:shutdown-sentinel"],
      ownerLeaseTtlSeconds: 30,
    });
    expect(
      (await prod.driver.list()).some(
        (entry) => entry.sessionId === shutdownSentinel.sessionId,
      ),
    ).toBe(true);

    // --- Hostile regression proof: the PATH fake(s) were never executed ------
    // PATH is still hostile here; the marker would exist if anything on PATH
    // had been invoked by the resolver, the sidecar, or the terminal shell.
    await live.pop()?.supervisor.stop();
    const retiredProbe = Bun.spawnSync(
      [bundledCli, "-L", endpointLabel, "kill-server"],
      { encoding: "utf8" },
    );
    expect(
      retiredProbe.exitCode,
      "clean stop must explicitly retire the private daemon",
    ).not.toBe(0);
    expect(existsSync(marker), "PATH fake rmux must never execute").toBe(false);
    expect(hostilePath.includes(hostileDir)).toBe(true);
  } finally {
    if (poisonedDefault) {
      poisonedDefault.child.kill("SIGTERM");
    }
    if (bundledCliForCleanup) {
      Bun.spawnSync([bundledCliForCleanup, "-L", "default", "kill-server"], {
        encoding: "utf8",
      });
    }
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldXdgConfigHome;
    if (oldRmuxConfig === undefined) delete process.env.RMUX_CONFIG_FILE;
    else process.env.RMUX_CONFIG_FILE = oldRmuxConfig;
  }

  // Sanity: the fake would have marked if actually invoked.
  const direct = Bun.spawnSync([fakeDaemon, "-V"], {
    encoding: "utf8",
    env: { ...process.env, XACPX_FAKEMUX_MARKER: marker },
  });
  void direct;
  expect(existsSync(marker), "fake binary must be self-marking (test sanity)").toBe(true);
});