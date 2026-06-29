import { expect, test } from "bun:test";
import { ControlService } from "../../../src/control/control-service";
import { registerKnownChannelId } from "../../../src/channels/channel-scope";

// The listSessions display-alias stripping requires the channel id to be registered.
registerKnownChannelId("relay");

const session = {
  alias: "relay:internal-backend",
  agent: "codex",
  workspace: "w",
  transportSession: "t",
  cwd: "/c",
  displayName: "My label",
};

function makeDeps() {
  const calls: string[] = [];
  const deps = {
    sessions: {
      resolveAliasForChat: async (_chatKey: string, alias: string) => `relay:internal-${alias}`,
      getSession: async (internalAlias: string) => (internalAlias === "relay:internal-backend" ? session : null),
      setDisplayName: async (alias: string, name?: string) => { calls.push(`persist:${alias}:${name ?? ""}`); },
      listAllResolvedSessions: () => [session],
    },
    activeTurns: { isActiveAnywhere: () => false },
    events: { emit: () => {} },
  };
  return { deps, calls };
}

test("setSessionDisplayName resolves the alias and persists the label", async () => {
  const { deps, calls } = makeDeps();
  const control = new ControlService(deps as never);
  await control.setSessionDisplayName("relay:acc", "backend", "My label");
  expect(calls).toEqual(["persist:relay:internal-backend:My label"]);
});

test("setSessionDisplayName throws when the session is not found", async () => {
  const { deps } = makeDeps();
  (deps.sessions as { getSession: unknown }).getSession = async () => null;
  const control = new ControlService(deps as never);
  await expect(control.setSessionDisplayName("relay:acc", "missing", "x")).rejects.toThrow("session not found");
});

test("listSessions carries displayName in display form", async () => {
  const { deps } = makeDeps();
  const control = new ControlService(deps as never);
  const list = control.listSessions("relay:acc");
  expect(list[0]?.alias).toBe("internal-backend");
  expect(list[0]?.displayName).toBe("My label");
});
