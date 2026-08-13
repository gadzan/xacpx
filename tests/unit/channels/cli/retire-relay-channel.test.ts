import { expect, test, beforeEach } from "bun:test";
import { setLocale } from "../../../../src/i18n";
import { retireRelayChannelFromCli } from "../../../../src/channels/cli/retire-relay-channel";

beforeEach(() => setLocale("en"));

function relayChannel() {
  return { id: "relay", type: "relay", enabled: true, options: { url: "wss://hub" } } as const;
}

test("skips one-shot retirement while the daemon is running", async () => {
  const out: string[] = [];
  let retired = false;
  await retireRelayChannelFromCli({
    channel: relayChannel(),
    print: (line) => out.push(line),
    getDaemonStatus: async () => ({ state: "running" }),
    retireImpl: {
      retireRelayTerminals: async () => {
        retired = true;
        return { status: "terminated" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay",
      parseRelayChannelConfig: () => ({ terminal: {} }),
    },
  });
  expect(retired).toBe(false);
  expect(out.join("\n")).toContain("deferred until daemon restart");
});

test("skips one-shot retirement while daemon status is indeterminate", async () => {
  const out: string[] = [];
  let retired = false;
  await retireRelayChannelFromCli({
    channel: relayChannel(),
    print: (line) => out.push(line),
    getDaemonStatus: async () => ({ state: "indeterminate" }),
    retireImpl: {
      retireRelayTerminals: async () => {
        retired = true;
        return { status: "terminated" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay",
      parseRelayChannelConfig: () => ({ terminal: {} }),
    },
  });
  expect(retired).toBe(false);
  expect(out.join("\n")).toContain("deferred until daemon restart");
});

test("runs one-shot retirement only when the daemon is stopped", async () => {
  const calls: string[] = [];
  await retireRelayChannelFromCli({
    channel: relayChannel(),
    print: (line) => calls.push(`print:${line}`),
    getDaemonStatus: async () => ({ state: "stopped" }),
    retireImpl: {
      retireRelayTerminals: async (input) => {
        calls.push(`retire:${input.registryDir}`);
        return { status: "terminated" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay-reg",
      parseRelayChannelConfig: () => ({ terminal: { enabled: true } }),
    },
  });
  expect(calls).toEqual(["retire:/tmp/relay-reg"]);
});

test("ignores non-relay channels", async () => {
  let retired = false;
  await retireRelayChannelFromCli({
    channel: { id: "weixin", type: "weixin", enabled: true },
    print: () => {},
    getDaemonStatus: async () => ({ state: "stopped" }),
    retireImpl: {
      retireRelayTerminals: async () => {
        retired = true;
        return { status: "idle" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay",
      parseRelayChannelConfig: () => ({ terminal: {} }),
    },
  });
  expect(retired).toBe(false);
});
