import { expect, test } from "bun:test";

import { executeDryRun, parseDryRunArgs, runDryRun } from "../../src/dry-run";
import type { WechatAgent } from "../../src/wechat-types";

test("parses chat key and messages from dry-run args", () => {
  expect(parseDryRunArgs(["--chat-key", "wx:test", "/help", "hello"])).toEqual({
    turns: [
      { chatKey: "wx:test", input: "/help" },
      { chatKey: "wx:test", input: "hello" },
    ],
  });
});

test("uses the default chat key when none is provided", () => {
  expect(parseDryRunArgs(["/help"])).toEqual({
    turns: [{ chatKey: "dry-run", input: "/help" }],
  });
});

test("ignores the argument separator token", () => {
  expect(parseDryRunArgs(["--chat-key", "wx:test", "--", "/help"])).toEqual({
    turns: [{ chatKey: "wx:test", input: "/help" }],
  });
});

test("supports switching chat keys within one dry-run invocation", () => {
  expect(
    parseDryRunArgs([
      "--chat-key",
      "wx:alice",
      "/status",
      "--chat-key",
      "wx:bob",
      "/status",
      "hello",
    ]),
  ).toEqual({
    turns: [
      { chatKey: "wx:alice", input: "/status" },
      { chatKey: "wx:bob", input: "/status" },
      { chatKey: "wx:bob", input: "hello" },
    ],
  });
});

test("replays a transcript through the shared agent interface", async () => {
  const seen: Array<{ accountId: string; conversationId: string; text: string }> = [];
  const agent: WechatAgent = {
    async chat(request) {
      seen.push(request);
      return { text: `reply:${request.text}` };
    },
  };

  const transcript = await runDryRun(agent, {
    turns: [
      { chatKey: "wx:test", input: "/help" },
      { chatKey: "wx:other", input: "hello" },
    ],
  });

  // Dry-run turns declare chatType explicitly so command authorization treats
  // them as direct chats (channel turns without chatType fail closed).
  expect(seen).toEqual([
    { accountId: "dry-run", conversationId: "wx:test", text: "/help", metadata: { chatType: "direct", origin: "human" } },
    { accountId: "dry-run", conversationId: "wx:other", text: "hello", metadata: { chatType: "direct", origin: "human" } },
  ]);
  expect(transcript).toEqual([
    { input: "/help", output: "reply:/help" },
    { input: "hello", output: "reply:hello" },
  ]);
});


test("executes dry-run with runtime disposal on success", async () => {
  const calls: string[] = [];
  const transcript = await executeDryRun(
    {
      agent: {
        async chat(request) {
          calls.push(`chat:${request.text}`);
          return { text: `reply:${request.text}` };
        },
      },
      async dispose() {
        calls.push("dispose");
      },
    },
    { turns: [{ chatKey: "wx:test", input: "/help" }] },
  );

  expect(transcript).toEqual([{ input: "/help", output: "reply:/help" }]);
  expect(calls).toEqual(["chat:/help", "dispose"]);
});

test("executes dry-run with runtime disposal on failure", async () => {
  const calls: string[] = [];

  await expect(
    executeDryRun(
      {
        agent: {
          async chat() {
            calls.push("chat");
            throw new Error("boom");
          },
        },
        async dispose() {
          calls.push("dispose");
        },
      },
      { turns: [{ chatKey: "wx:test", input: "/help" }] },
    ),
  ).rejects.toThrow("boom");

  expect(calls).toEqual(["chat", "dispose"]);
});
