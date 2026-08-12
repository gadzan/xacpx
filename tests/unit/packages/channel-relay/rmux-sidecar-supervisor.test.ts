import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { parseRelayTerminalConfig } from "../../../../packages/channel-relay/src/config";
import { RmuxSidecarDriver } from "../../../../packages/channel-relay/src/terminal/rmux-sidecar-driver";
import {
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
