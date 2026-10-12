import { expect, test } from "bun:test";
import { ControlService, conversationKernel } from "../../../src/control/control-service";
import type {
  ConversationRouterConfigState,
  RouterAvailability,
} from "@ganglion/xacpx-relay-protocol";

const READY: RouterAvailability = { status: "ready", configPath: "conversations.router" };
const DISABLED: RouterAvailability = {
  status: "disabled-by-config",
  configPath: "conversations.router",
  reason: { code: "disabled", message: "Automatic collaboration is off." },
};

const CONFIG: ConversationRouterConfigState = {
  enabled: true,
  command: "/usr/bin/router",
  authEnv: "ROUTER_TOKEN",
};

type RouterDep = {
  readConfig: () => ConversationRouterConfigState;
  update: (patch: unknown) => Promise<RouterAvailability>;
  setEnabled: (enabled: boolean) => Promise<RouterAvailability>;
};

function makeDeps(conversationRouter?: RouterDep) {
  return {
    sessions: { listAllResolvedSessions: () => [] },
    agents: { list: () => [], catalog: () => [] },
    workspaces: { list: () => [], create: async () => ({ name: "n", cwd: "/n" }), remove: async () => {} },
    events: { emit: () => {} },
    ...(conversationRouter ? { conversationRouter } : {}),
  } as never;
}

function bindRuntime(control: ControlService, routerAvailability: RouterAvailability): void {
  conversationKernel(control).bindConversationRuntime({
    routerAvailability,
    assertOpen: () => {},
  } as never);
}

test("setConversationRouterEnabled returns the availability the daemon resolved", async () => {
  const seen: boolean[] = [];
  const control = new ControlService(makeDeps({
    readConfig: () => CONFIG,
    update: async () => READY,
    setEnabled: async (enabled) => {
      seen.push(enabled);
      return enabled ? READY : DISABLED;
    },
  }));
  expect(await control.setConversationRouterEnabled(true)).toEqual(READY);
  expect(await control.setConversationRouterEnabled(false)).toEqual(DISABLED);
  expect(seen).toEqual([true, false]);
});

test("setConversationRouterEnabled fails closed when the switch is not wired", async () => {
  const control = new ControlService(makeDeps());
  await expect(control.setConversationRouterEnabled(true)).rejects.toMatchObject({
    code: "router_control_unavailable",
  });
});

test("a failed write surfaces the daemon error instead of a fake success", async () => {
  const control = new ControlService(makeDeps({
    readConfig: () => CONFIG,
    update: async () => READY,
    setEnabled: async () => {
      throw new Error("refusing to modify /root/.xacpx/config.json: it is not valid JSON");
    },
  }));
  await expect(control.setConversationRouterEnabled(true)).rejects.toThrow("not valid JSON");
});

test("an empty patch composes the runtime snapshot with the persisted config and never writes", async () => {
  const touched: string[] = [];
  const control = new ControlService(makeDeps({
    readConfig: () => {
      touched.push("readConfig");
      return CONFIG;
    },
    update: async () => {
      touched.push("update");
      return READY;
    },
    setEnabled: async () => READY,
  }));
  bindRuntime(control, DISABLED);

  expect(await control.updateConversationRouter({})).toEqual({
    availability: DISABLED,
    config: CONFIG,
  });
  expect(touched).toEqual(["readConfig"]);
});

test("a non-empty patch forwards exactly what the caller named and composes the state", async () => {
  const seen: unknown[] = [];
  const control = new ControlService(makeDeps({
    readConfig: () => CONFIG,
    update: async (patch) => {
      seen.push(patch);
      return READY;
    },
    setEnabled: async () => DISABLED,
  }));
  bindRuntime(control, DISABLED);

  const patch = { command: "/opt/router", authEnv: null };
  expect(await control.updateConversationRouter(patch)).toEqual({
    availability: READY,
    config: CONFIG,
  });
  expect(seen).toEqual([patch]);
});

test("updateConversationRouter fails closed when the switch is not wired", async () => {
  const control = new ControlService(makeDeps());
  await expect(control.updateConversationRouter({})).rejects.toMatchObject({
    code: "router_control_unavailable",
  });
  await expect(control.updateConversationRouter({ enabled: true })).rejects.toMatchObject({
    code: "router_control_unavailable",
  });
});
