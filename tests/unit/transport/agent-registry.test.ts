import { expect, test } from "bun:test";
import { createAcpxAgentRegistryLoader } from "../../../src/transport/agent-registry";

test("registry load success returns the narrow resolver and is cached", () => {
  let attempts = 0;
  const registry = { resolve: (driver: string) => `npx ${driver}-acp` };
  const load = createAcpxAgentRegistryLoader({
    loadRuntime: () => ({
      createAgentRegistry: () => {
        attempts++;
        return registry;
      },
    }),
  });

  expect(load()?.resolve("codex")).toBe("npx codex-acp");
  expect(load()).toBe(registry);
  expect(attempts).toBe(1);
});

test("registry load failure is cached and logged once with the degraded behavior", () => {
  const errors: Array<{ event: string; message: string; error?: unknown }> = [];
  let attempts = 0;
  const load = createAcpxAgentRegistryLoader({
    loadRuntime: () => {
      attempts++;
      throw new Error("runtime unavailable");
    },
    logger: {
      error: async (event, message, data) => { errors.push({ event, message, error: data?.error }); },
    },
  });

  expect(load()).toBeNull();
  expect(load()).toBeNull();
  expect(attempts).toBe(1);
  expect(errors).toEqual([{
    event: "transport.agent_registry.unavailable",
    message: "could not read acpx's agent registry; install hints fall back to probing the driver name, so an installed CLI may show as not detected",
    error: "runtime unavailable",
  }]);
});
