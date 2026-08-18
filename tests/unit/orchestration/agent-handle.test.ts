import { expect, test } from "bun:test";

import {
  decodeAgentHandle,
  encodeAgentHandle,
} from "../../../src/orchestration/agent-handle";

test("agent handle round-trips a canonical agent address", () => {
  const address = {
    nodeId: "node_157f9231-1b20-4c41-8a68-4d3d8b2164f5",
    endpointId: "157f9231-1b20-4c41-8a68-4d3d8b2164f5",
  };

  expect(encodeAgentHandle(address)).toBe(
    "agent:node_157f9231-1b20-4c41-8a68-4d3d8b2164f5:157f9231-1b20-4c41-8a68-4d3d8b2164f5",
  );
  expect(decodeAgentHandle(encodeAgentHandle(address))).toEqual(address);
});

test("agent handle decoder rejects malformed and overlong values", () => {
  expect(decodeAgentHandle("")).toBeNull();
  expect(decodeAgentHandle("agent:node_only")).toBeNull();
  expect(decodeAgentHandle("agent::endpoint")).toBeNull();
  expect(decodeAgentHandle("agent:node:endpoint:extra")).toBeNull();
  expect(decodeAgentHandle("session:node:endpoint")).toBeNull();
  expect(
    decodeAgentHandle(["agent", "a".repeat(129), "endpoint"].join(":")),
  ).toBeNull();
  expect(decodeAgentHandle("agent:node:endpoint/with/slashes")).toBeNull();
});
