import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { parseRelayTerminalConfig } from "../../../../packages/channel-relay/src/config";
import { RmuxSidecarDriver } from "../../../../packages/channel-relay/src/terminal/rmux-sidecar-driver";
import {
  createProductionTerminalDriver,
  RmuxSidecarSupervisor,
  SupervisedRmuxDriver,
} from "../../../../packages/channel-relay/src/terminal/rmux-sidecar-supervisor";
import { RmuxDriverCrashedError } from "../../../../packages/channel-relay/src/terminal/rmux-driver";

/** Fake stdio bridge that auto-answers handshake and simple req/res by id. */
function makeAutoDriver() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const life = new EventEmitter();
  let creates = 0;
  stdin.on("data", (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split("\n")) {
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw) as { type: string; id: string };
      if (msg.type === "handshake") {
        stdout.write(
          `${JSON.stringify({
            type: "handshake-ok",
            id: msg.id,
            bridge_version: "0.1.0",
            protocol_version: 1,
            rmux_wire_version: "0.10.0",
            capabilities: ["create"],
          })}\n`,
        );
        return;
      }
      if (msg.type === "diagnostics") {
        stdout.write(
          `${JSON.stringify({
            type: "diagnostics",
            id: msg.id,
            bridge_version: "0.1.0",
            rmux_wire_version: "0.10.0",
            capabilities: ["create"],
          })}\n`,
        );
        return;
      }
      if (msg.type === "shutdown") {
        stdout.write(`${JSON.stringify({ type: "ok", id: msg.id })}\n`);
        return;
      }
      stdout.write(
        `${JSON.stringify({ type: "error", id: msg.id, code: "unsupported", message: msg.type })}\n`,
      );
    }
  });
  const driver = new RmuxSidecarDriver({
    stdin,
    stdout,
    kill: () => life.emit("exit", 0),
    on: (event, listener) => {
      life.on(event, listener);
    },
  });
  return {
    driver,
    bumpCreate() {
      creates += 1;
    },
    getCreates() {
      return creates;
    },
  };
}

test("supervisor starts injected driver once and exposes supervised proxy", async () => {
  const auto = makeAutoDriver();
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({ enabled: true }),
    createDriver: async () => auto.driver,
  });
  const live = await supervisor.start();
  expect(live).toBe(auto.driver);
  const proxy = new SupervisedRmuxDriver(supervisor);
  const diag = await proxy.diagnostics();
  expect(diag.bridgeVersion).toBe("0.1.0");
  await supervisor.stop();
});

test("production spawn isolates the endpoint, ignores user RMUX config, and supports failed-create injection", async () => {
  const child = makeFakeChild({ autoHandshake: true });
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  let capturedArgs: readonly string[] | undefined;
  const labels = ["xacpx-relay-4242-first", "xacpx-relay-4242-second"];
  const bridgeCommand = resolve("fake-xacpx-rmux-bridge");
  const daemonCommand = resolve("fake-rmux-daemon");
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({
      enabled: true,
      bridgeCommand,
      rmuxCommand: daemonCommand,
    }),
    spawnFn: (((_command, args, options) => {
      capturedArgs = args;
      capturedEnv = options?.env;
      return child;
    }) as unknown as typeof spawn),
    endpointLabelFactory: () => labels.shift() ?? "unexpected",
    injectCreateFailureAfterOwnedOnce: true,
    maxRestarts: 0,
  });

  await supervisor.start();
  expect(capturedArgs).toEqual(["--__test-fail-create-after-owned-once"]);
  expect(capturedEnv?.XACPX_RMUX_ENDPOINT_LABEL).toBe("xacpx-relay-4242-first");
  if (process.platform === "win32") {
    expect(capturedEnv?.RMUX_SDK_DAEMON_BINARY).toBe(daemonCommand);
    expect(capturedEnv?.RMUX_CONFIG_FILE).toBe("NUL");
    expect(capturedEnv?.XACPX_RMUX_DAEMON_BINARY).toBeUndefined();
  } else {
    expect(capturedEnv?.RMUX_SDK_DAEMON_BINARY).toBe(bridgeCommand);
    expect(capturedEnv?.XACPX_RMUX_DAEMON_BINARY).toBe(daemonCommand);
    expect(capturedEnv?.RMUX_CONFIG_FILE).toBeUndefined();
  }
  await supervisor.stop();
});

test("supervised proxy fences when supervisor has no live driver", async () => {
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({ enabled: true }),
    createDriver: async () => makeAutoDriver().driver,
    maxRestarts: 0,
  });
  const proxy = new SupervisedRmuxDriver(supervisor);
  await expect(proxy.list()).rejects.toBeInstanceOf(RmuxDriverCrashedError);
});

test("supervisor does not start two drivers concurrently", async () => {
  const auto = makeAutoDriver();
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({ enabled: true }),
    createDriver: async () => {
      auto.bumpCreate();
      return auto.driver;
    },
  });
  const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
  expect(a).toBe(b);
  expect(auto.getCreates()).toBe(1);
  await supervisor.stop();
});

test("protocol crash without child exit nulls the live driver so proxy fences", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const life = new EventEmitter();
  stdin.on("data", (chunk: Buffer) => {
    for (const raw of chunk.toString("utf8").split("\n")) {
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw) as { type: string; id: string };
      if (msg.type === "handshake") {
        stdout.write(
          `${JSON.stringify({
            type: "handshake-ok",
            id: msg.id,
            bridge_version: "0.1.0",
            protocol_version: 1,
            rmux_wire_version: "0.10.0",
            capabilities: ["create"],
          })}\n`,
        );
      }
    }
  });
  let killed = false;
  const driver = new RmuxSidecarDriver({
    stdin,
    stdout,
    kill: () => {
      killed = true;
      // Intentionally do NOT emit exit — protocol crash must fence before exit.
    },
    on: (event, listener) => {
      life.on(event, listener);
    },
  });
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({ enabled: true }),
    createDriver: async () => driver,
    maxRestarts: 0,
  });
  await supervisor.start();
  const proxy = new SupervisedRmuxDriver(supervisor);

  stdout.write("this is not json\n");
  await Bun.sleep(20);
  expect(killed).toBe(true);
  await expect(proxy.diagnostics()).rejects.toBeInstanceOf(RmuxDriverCrashedError);
  await supervisor.stop();
});

function makeFakeChild(opts: { autoHandshake?: boolean; exitAfterHandshake?: boolean } = {}): ChildProcessWithoutNullStreams & { killed: boolean } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const life = new EventEmitter();
  const child = Object.assign(life, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    killed: false,
    kill(signal?: NodeJS.Signals) {
      this.killed = true;
      this.emit("exit", null, signal ?? "SIGTERM");
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams & { killed: boolean };
  if (opts.autoHandshake) {
    stdin.on("data", (chunk: Buffer) => {
      for (const raw of chunk.toString("utf8").split("\n")) {
        if (!raw.trim()) continue;
        const msg = JSON.parse(raw) as { type: string; id: string };
        if (msg.type === "handshake") {
          stdout.write(
            `${JSON.stringify({
              type: "handshake-ok",
              id: msg.id,
              bridge_version: "0.1.0",
              protocol_version: 1,
              rmux_wire_version: "0.10.0",
              capabilities: ["create"],
            })}\n`,
          );
          if (opts.exitAfterHandshake) {
            setTimeout(() => {
              child.killed = true;
              child.emit("exit", 1, null);
            }, 5);
          }
        } else if (msg.type === "shutdown") {
          stdout.write(`${JSON.stringify({ type: "ok", id: msg.id })}\n`);
        }
      }
    });
  }
  return child;
}

test("handshake timeout kills the hung child and allows a later restart", async () => {
  let n = 0;
  const hung = makeFakeChild();
  const live = makeFakeChild({ autoHandshake: true });
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({ enabled: true }),
    spawnFn: ((() => {
      n += 1;
      return n === 1 ? hung : live;
    }) as unknown as typeof spawn),
    requestTimeoutMs: 40,
    sleep: async () => {},
    maxRestarts: 1,
  });

  await expect(supervisor.start()).rejects.toThrow(/timeout/);
  expect(hung.killed).toBe(true);

  const deadline = Date.now() + 1000;
  while (supervisor.getDriver() === null && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(supervisor.getDriver()).not.toBeNull();
  await supervisor.stop();
});

test("createProductionTerminalDriver stops the supervisor when handshake fails", async () => {
  const hung = makeFakeChild();
  await expect(
    createProductionTerminalDriver(parseRelayTerminalConfig({ enabled: true }), {
      spawnFn: ((() => hung) as unknown as typeof spawn),
      requestTimeoutMs: 40,
      sleep: async () => {},
      maxRestarts: 0,
    }),
  ).rejects.toThrow(/timeout/);
  expect(hung.killed).toBe(true);
});

test("handshake-ok then immediate crash is capped at 1 + maxRestarts spawns with growing backoff", async () => {
  let spawns = 0;
  const delays: number[] = [];
  const endpointLabels = [
    "endpoint-1",
    "endpoint-2",
    "endpoint-3",
    "endpoint-4",
  ];
  const spawnedLabels: Array<string | undefined> = [];
  const supervisor = new RmuxSidecarSupervisor({
    config: parseRelayTerminalConfig({ enabled: true }),
    spawnFn: (((_command, _args, options) => {
      spawns += 1;
      spawnedLabels.push(options?.env?.XACPX_RMUX_ENDPOINT_LABEL);
      return makeFakeChild({ autoHandshake: true, exitAfterHandshake: true });
    }) as unknown as typeof spawn),
    endpointLabelFactory: () => endpointLabels.shift() ?? "unexpected",
    requestTimeoutMs: 40,
    sleep: async (ms) => {
      delays.push(ms);
    },
    maxRestarts: 3,
  });

  await supervisor.start();
  const deadline = Date.now() + 2000;
  while (spawns < 4 && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  await Bun.sleep(40);
  expect(spawns).toBe(4);
  expect(delays).toEqual([500, 1000, 2000]);
  expect(spawnedLabels).toEqual([
    "endpoint-1",
    "endpoint-2",
    "endpoint-3",
    "endpoint-4",
  ]);
  await supervisor.stop();
});
