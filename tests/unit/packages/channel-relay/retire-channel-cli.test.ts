import { expect, test, beforeEach } from "bun:test";
import { setLocale } from "../../../../src/i18n";
import { retireRelayChannelFromCli } from "../../../../packages/channel-relay/src/retire-channel-cli";
import type { ChannelRetireContext } from "../../../../src/channels/plugin";

beforeEach(() => setLocale("en"));

function relayChannel() {
  return { id: "relay", type: "relay", enabled: true, options: { url: "wss://hub" } } as const;
}

function ctx(
  overrides: Partial<ChannelRetireContext> & Pick<ChannelRetireContext, "getDaemonStatus" | "print">,
): ChannelRetireContext {
  return {
    channel: relayChannel(),
    reason: "removed",
    ...overrides,
  };
}

test("skips one-shot retirement while the daemon is running", async () => {
  const out: string[] = [];
  let retired = false;
  await retireRelayChannelFromCli(
    ctx({
      print: (line) => out.push(line),
      getDaemonStatus: async () => ({ state: "running" }),
    }),
    {
      retireRelayTerminals: async () => {
        retired = true;
        return { status: "terminated" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay",
      parseRelayChannelConfig: () => ({ url: "wss://hub", terminal: {} as never }),
    },
  );
  expect(retired).toBe(false);
  expect(out.join("\n")).toContain("deferred until daemon restart");
});

test("skips one-shot retirement while daemon status is indeterminate", async () => {
  const out: string[] = [];
  let retired = false;
  await retireRelayChannelFromCli(
    ctx({
      print: (line) => out.push(line),
      getDaemonStatus: async () => ({ state: "indeterminate" }),
    }),
    {
      retireRelayTerminals: async () => {
        retired = true;
        return { status: "terminated" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay",
      parseRelayChannelConfig: () => ({ url: "wss://hub", terminal: {} as never }),
    },
  );
  expect(retired).toBe(false);
  expect(out.join("\n")).toContain("deferred until daemon restart");
});

test("runs one-shot retirement only when the daemon is stopped", async () => {
  const calls: string[] = [];
  await retireRelayChannelFromCli(
    ctx({
      print: (line) => calls.push(`print:${line}`),
      getDaemonStatus: async () => ({ state: "stopped" }),
    }),
    {
      retireRelayTerminals: async (input) => {
        calls.push(`retire:${input.registryDir}`);
        return { status: "terminated" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay-reg",
      parseRelayChannelConfig: () => ({ url: "wss://hub", terminal: { enabled: true } as never }),
    },
  );
  expect(calls).toEqual(["retire:/tmp/relay-reg"]);
});

test("ignores non-relay channels", async () => {
  let retired = false;
  await retireRelayChannelFromCli(
    ctx({
      channel: { id: "weixin", type: "weixin", enabled: true },
      print: () => {},
      getDaemonStatus: async () => ({ state: "stopped" }),
    }),
    {
      retireRelayTerminals: async () => {
        retired = true;
        return { status: "idle" };
      },
      defaultTerminalRegistryDir: () => "/tmp/relay",
      parseRelayChannelConfig: () => ({ url: "wss://hub", terminal: {} as never }),
    },
  );
  expect(retired).toBe(false);
});
