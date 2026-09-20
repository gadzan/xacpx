import { expect, test } from "bun:test";

import { MessageChannelRegistry } from "../../../src/channels/channel-registry";
import type { MessageChannelRuntime } from "../../../src/channels/types.js";

function baseChannel(id: string): MessageChannelRuntime {
  return {
    id,
    isLoggedIn: () => true,
    login: async () => id,
    logout: () => {},
    start: async () => {},
    notifyTaskCompletion: async () => {},
    notifyTaskProgress: async () => {},
    sendCoordinatorMessage: async () => {},
  } as unknown as MessageChannelRuntime;
}

function permissionOnlyChannel(id: string): MessageChannelRuntime {
  return {
    ...baseChannel(id),
    requestPermission: async () => ({ outcome: "allow_once", responderId: "u" }),
  } as unknown as MessageChannelRuntime;
}

function elicitationChannel(id: string, modes: readonly ("form" | "url")[]): MessageChannelRuntime {
  return {
    ...baseChannel(id),
    elicitationModes: modes,
    requestElicitation: async () => ({ action: "cancel", responderId: "u" }),
  } as unknown as MessageChannelRuntime;
}

function declaringOnlyChannel(id: string, modes: readonly ("form" | "url")[]): MessageChannelRuntime {
  return {
    ...baseChannel(id),
    elicitationModes: modes,
  } as unknown as MessageChannelRuntime;
}

test("no channel implements Elicitation → no capability, no modes", () => {
  const registry = new MessageChannelRegistry([baseChannel("textonly")]);
  expect(registry.hasElicitationInteractionCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("permission support alone never implies Elicitation support", () => {
  const registry = new MessageChannelRegistry([permissionOnlyChannel("approver")]);
  expect(registry.hasPermissionInteractionCapability()).toBe(true);
  expect(registry.hasElicitationInteractionCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("declared mode without an implementation is not support", () => {
  const registry = new MessageChannelRegistry([declaringOnlyChannel("liar", ["form", "url"])]);
  expect(registry.hasElicitationInteractionCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("declared mode with an implementation is support", () => {
  const registry = new MessageChannelRegistry([elicitationChannel("renderer", ["form"])]);
  expect(registry.hasElicitationInteractionCapability()).toBe(true);
  expect(registry.supportedElicitationModes()).toEqual(["form"]);
});

test("url is only advertised when a channel declares and implements it", () => {
  const registry = new MessageChannelRegistry([elicitationChannel("renderer", ["url"])]);
  expect(registry.supportedElicitationModes()).toEqual(["url"]);
});

test("modes are the union across channels, deduplicated and deterministic", () => {
  const registry = new MessageChannelRegistry([
    elicitationChannel("renderer-a", ["form"]),
    elicitationChannel("renderer-b", ["form", "url"]),
    baseChannel("textonly"),
  ]);
  expect(registry.supportedElicitationModes()).toEqual(["form", "url"]);
});
