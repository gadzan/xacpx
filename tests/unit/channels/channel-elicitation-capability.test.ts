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
  expect(registry.hasElicitationFormCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("permission support alone never implies Elicitation support", () => {
  const registry = new MessageChannelRegistry([permissionOnlyChannel("approver")]);
  expect(registry.hasPermissionInteractionCapability()).toBe(true);
  expect(registry.hasElicitationFormCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("declared mode without an implementation is not support", () => {
  const registry = new MessageChannelRegistry([declaringOnlyChannel("liar", ["form", "url"])]);
  expect(registry.hasElicitationFormCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("implementation without any declared mode is not form support", () => {
  // Regression: an existential method probe reported this as form-capable, so
  // the daemon advertised ACP form support, the agent asked, and the broker
  // then cancelled on its own mode check — a capability lie the agent paid for.
  const registry = new MessageChannelRegistry([elicitationChannel("silent", [])]);
  expect(registry.hasElicitationFormCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("implementation declaring only url is not form support", () => {
  // Regression: same shape as above with a non-form mode declared. The channel
  // implements `requestElicitation`, yet must report NO mode — M1 cannot render
  // URL, so claiming it would advertise a capability that fails later.
  const registry = new MessageChannelRegistry([elicitationChannel("urlish", ["url"])]);
  expect(registry.hasElicitationFormCapability()).toBe(false);
  expect(registry.supportedElicitationModes()).toEqual([]);
});

test("form capability needs the declaring channel, not just any channel", () => {
  // A url-only channel plus a permission-only channel must still read as no
  // form support: the mode must come from the SAME runtime that renders.
  const registry = new MessageChannelRegistry([
    elicitationChannel("urlish", ["url"]),
    permissionOnlyChannel("approver"),
  ]);
  expect(registry.hasElicitationFormCapability()).toBe(false);
  expect(registry.hasPermissionInteractionCapability()).toBe(true);
});

test("declared form mode with an implementation is support", () => {
  const registry = new MessageChannelRegistry([elicitationChannel("renderer", ["form"])]);
  expect(registry.hasElicitationFormCapability()).toBe(true);
  expect(registry.supportedElicitationModes()).toEqual(["form"]);
});

test("a url-only channel advertises NO mode, because M1 has no URL renderer", () => {
  // Regression: the plugin-facing mode union used to be ACP's `form | url`, so
  // a channel declaring `"url"` was reported as supporting a mode core cannot
  // deliver — `ChannelElicitationRequest` carries form data only and the RFD's
  // URL rules (target-host display, consent before navigating, `elicitationId`)
  // are unimplemented. That is a capability lie in the published plugin API, so
  // the union is deliberately narrower than ACP's.
  const registry = new MessageChannelRegistry([elicitationChannel("renderer", ["url"])]);
  expect(registry.supportedElicitationModes()).toEqual([]);
  expect(registry.hasElicitationFormCapability()).toBe(false);
});

test("modes are the union across form-capable channels, deduplicated", () => {
  const registry = new MessageChannelRegistry([
    elicitationChannel("renderer-a", ["form"]),
    elicitationChannel("renderer-b", ["form", "url"]),
    baseChannel("textonly"),
  ]);
  // The `url` declaration is ignored rather than forwarded: reporting it would
  // let an agent pick a mode xacpx cannot render.
  expect(registry.supportedElicitationModes()).toEqual(["form"]);
});
