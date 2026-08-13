import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type {
  ChannelCliProvider,
  ChannelFactory,
  ChannelRuntimeConfig,
  MessageChannelRuntime,
  ScheduledChannelMessageInput,
  SessionResourceCatalog,
  SessionResourceDescriptor,
  SessionResourceLifecycleEvent,
  WeacpxPlugin,
} from "../../../src/plugin-api";

test("plugin-api exports the types needed by channel packages", async () => {
  const runtime: Pick<MessageChannelRuntime, "id"> = { id: "demo" };
  const factory: ChannelFactory = () => runtime as MessageChannelRuntime;
  const provider: Pick<ChannelCliProvider, "type"> = { type: "demo" };
  const config: ChannelRuntimeConfig = { id: "demo", type: "demo", enabled: true };
  const scheduledInput: ScheduledChannelMessageInput = {
    chatKey: "wx:test",
    sessionAlias: "demo",
    taskId: "k8f2",
    noticeText: "notice",
    promptText: "prompt",
  };
  const plugin: WeacpxPlugin = {
    apiVersion: 1,
    name: "demo-plugin",
    channels: [{ type: provider.type, factory }],
  };

  expect(config.type).toBe("demo");
  expect(plugin.channels?.[0]?.type).toBe("demo");
  expect(scheduledInput.taskId).toBe("k8f2");

  const source = await readFile("src/plugin-api.ts", "utf8");
  expect(source).toContain("ChannelRuntimeConfig");
  expect(source).toContain("ScheduledChannelMessageInput");
});

test("plugin-api exports the session resource catalog contract types", async () => {
  const descriptor: SessionResourceDescriptor = {
    logicalSessionId: "uuid-1",
    channelId: "relay",
    internalAlias: "relay:demo",
    displayAlias: "demo",
    workspace: "backend",
    cwd: "/tmp/backend",
    archived: false,
  };
  const event: SessionResourceLifecycleEvent = { type: "archived", session: descriptor };
  const catalog: SessionResourceCatalog = {
    resolve: async () => descriptor,
    list: async () => [descriptor],
    subscribe: () => () => {},
  };

  expect(event.type).toBe("archived");
  expect(await catalog.resolve("relay:acc", "demo")).toEqual(descriptor);
  expect(await catalog.list("relay")).toHaveLength(1);

  const source = await readFile("src/plugin-api.ts", "utf8");
  expect(source).toContain("SessionResourceCatalog");
  expect(source).toContain("SessionResourceDescriptor");
  expect(source).toContain("SessionResourceLifecycleEvent");
});
