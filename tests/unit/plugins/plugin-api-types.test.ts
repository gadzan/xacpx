import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { isConversationIngressRejection } from "../../../src/plugin-api";
import { ConversationIngressRejection } from "../../../src/conversations/conversation-ingress-rejection";
import { ConversationError } from "../../../src/conversations/conversation-error";

test("plugin-api recognizes durable ingress rejection across bundle copies without guessing error codes", () => {
  expect(isConversationIngressRejection(new ConversationIngressRejection("external_target_invalid", "invalid target"))).toBe(true);
  expect(isConversationIngressRejection(new ConversationError("external_target_invalid", "not committed"))).toBe(false);
  expect(isConversationIngressRejection(new Error("disk failure"))).toBe(false);
  const otherBundle = Object.assign(new Error("durable rejection"), { code: "external_request_aborted",
    [Symbol.for("@ganglion/xacpx/conversation-ingress-rejection")]: true });
  expect(isConversationIngressRejection(otherBundle)).toBe(true);
  expect(isConversationIngressRejection({ ...otherBundle, code: "run_corrupt" })).toBe(false);
  for (const error of [null, undefined, "external_request_aborted", { code: "external_request_aborted", message: "not committed" }]) {
    expect(isConversationIngressRejection(error)).toBe(false);
  }
});

import type {
  ChannelCliProvider,
  ChannelFactory,
  ChannelRuntimeConfig,
  MessageChannelRuntime,
  PublicControlPromptInput,
  PublicControlService,
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

test("plugin-api Control surface is the public facade, not Conversation execution", async () => {
  type ForbiddenPrompt = Extract<
    keyof PublicControlPromptInput,
    "executionOrigin" | "conversation" | "conversationSeam"
  >;
  const promptClean: [ForbiddenPrompt] extends [never] ? true : false = true;
  expect(promptClean).toBe(true);

  type ForbiddenMethods = Extract<
    keyof PublicControlService,
    "promptImmediate" | "cancelTurnForPromptRequest" | "inspectPromptRequest" | "cancelQueuedConversationItem"
  >;
  const methodsClean: [ForbiddenMethods] extends [never] ? true : false = true;
  expect(methodsClean).toBe(true);

  const source = await readFile("src/plugin-api.ts", "utf8");
  expect(source).toContain("PublicControlService");
  expect(source).not.toContain("promptImmediate");
  expect(source).not.toContain("ConversationExecutionPort");
  expect(source).not.toContain("executionOrigin");
  expect(source).not.toContain("conversationKernel");
});
