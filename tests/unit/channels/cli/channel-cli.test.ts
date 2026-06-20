import { expect, test, beforeEach } from "bun:test";
import { handleChannelCli } from "../../../../src/channels/cli/channel-cli";
import { setLocale } from "../../../../src/i18n";

beforeEach(() => setLocale("zh"));

function makeDeps(initialChannels: any[]) {
  const out: string[] = [];
  let stored = {
    channel: { type: "weixin", replyMode: "verbose" },
    channels: initialChannels,
  } as any;
  return {
    out,
    getStored: () => stored,
    deps: {
      print: (line: string) => out.push(line),
      isInteractive: () => false,
      promptText: async () => "",
      loadConfig: async () => JSON.parse(JSON.stringify(stored)),
      saveChannels: async (c: any) => { stored = { ...stored, channels: c }; },
      getDaemonStatus: async () => ({ state: "stopped" as const }),
      restartDaemon: async () => 0,
    } as any,
  };
}

test("set-reply-mode writes the channel's replyMode and reports saved", async () => {
  const { deps, getStored } = makeDeps([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "feishu", type: "feishu", enabled: true },
  ]);
  const code = await handleChannelCli(["set-reply-mode", "feishu", "final"], deps);
  expect(code).toBe(0);
  expect(getStored().channels.find((c: any) => c.id === "feishu").replyMode).toBe("final");
});

test("set-reply-mode rejects an invalid mode", async () => {
  const { deps, out } = makeDeps([{ id: "weixin", type: "weixin", enabled: true }]);
  const code = await handleChannelCli(["set-reply-mode", "weixin", "loud"], deps);
  expect(code).toBe(1);
  expect(out.join("\n")).toContain("loud");
});

test("set-reply-mode rejects an unknown channel", async () => {
  const { deps, out } = makeDeps([{ id: "weixin", type: "weixin", enabled: true }]);
  const code = await handleChannelCli(["set-reply-mode", "nope", "final"], deps);
  expect(code).toBe(1);
  expect(out.join("\n")).toContain("nope");
});

test("set-reply-mode accepts a trailing --no-restart flag like the other mutating subcommands", async () => {
  const { deps, getStored } = makeDeps([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "feishu", type: "feishu", enabled: true },
  ]);
  const code = await handleChannelCli(["set-reply-mode", "feishu", "stream", "--no-restart"], deps);
  expect(code).toBe(0);
  expect(getStored().channels.find((c: any) => c.id === "feishu").replyMode).toBe("stream");
});

test("channel rm clears the removed channel's stored credentials by default", async () => {
  const { deps, out, getStored } = makeDeps([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "relay", type: "relay", enabled: true },
  ]);
  const cleared: any[] = [];
  deps.clearChannelCredentials = async (ch: any) => { cleared.push(ch); };
  const code = await handleChannelCli(["rm", "relay"], deps);
  expect(code).toBe(0);
  expect(getStored().channels.map((c: any) => c.id)).toEqual(["weixin"]);
  expect(cleared.map((c) => c.id)).toEqual(["relay"]);
  expect(out.join("\n")).toContain("存储凭证");
});

test("channel rm --keep-credentials leaves stored credentials in place", async () => {
  const { deps, out } = makeDeps([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "relay", type: "relay", enabled: true },
  ]);
  let called = false;
  deps.clearChannelCredentials = async () => { called = true; };
  const code = await handleChannelCli(["rm", "relay", "--keep-credentials"], deps);
  expect(code).toBe(0);
  expect(called).toBe(false);
  expect(out.join("\n")).toContain("已保留");
});

test("channel rm still succeeds and reports when credential cleanup throws", async () => {
  const { deps, out, getStored } = makeDeps([
    { id: "weixin", type: "weixin", enabled: true },
    { id: "relay", type: "relay", enabled: true },
  ]);
  deps.clearChannelCredentials = async () => { throw new Error("boom"); };
  const code = await handleChannelCli(["rm", "relay"], deps);
  expect(code).toBe(0); // channel still removed
  expect(getStored().channels.map((c: any) => c.id)).toEqual(["weixin"]);
  expect(out.join("\n")).toContain("boom");
});
