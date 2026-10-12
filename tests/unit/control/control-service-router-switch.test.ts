import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";
import type { RouterAvailability } from "@ganglion/xacpx-relay-protocol";

const READY: RouterAvailability = { status: "ready", configPath: "conversations.router" };
const DISABLED: RouterAvailability = {
  status: "disabled-by-config",
  configPath: "conversations.router",
  reason: { code: "disabled", message: "Automatic collaboration is off." },
};

function makeDeps(conversationRouter?: { setEnabled: (enabled: boolean) => Promise<RouterAvailability> }) {
  return {
    sessions: { listAllResolvedSessions: () => [] },
    agents: { list: () => [], catalog: () => [] },
    workspaces: { list: () => [], create: async () => ({ name: "n", cwd: "/n" }), remove: async () => {} },
    events: { emit: () => {} },
    ...(conversationRouter ? { conversationRouter } : {}),
  } as never;
}

test("setConversationRouterEnabled returns the availability the daemon resolved", async () => {
  const seen: boolean[] = [];
  const control = new ControlService(makeDeps({
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
    setEnabled: async () => {
      throw new Error("refusing to modify /root/.xacpx/config.json: it is not valid JSON");
    },
  }));
  await expect(control.setConversationRouterEnabled(true)).rejects.toThrow("not valid JSON");
});
