import { expect, mock, test } from "bun:test";
import type { ResolvedSession } from "../../../../src/transport/types";
import { AcpxBridgeTransport } from "../../../../src/transport/acpx-bridge/acpx-bridge-transport";

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  model: "gpt-5.2[high]",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

test("ensureSession forwards the model to the bridge", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({ request });
  await transport.ensureSession(session);
  const params = request.mock.calls[0][1] as Record<string, unknown>;
  expect(params.model).toBe("gpt-5.2[high]");
});

test("ensureSession omits model when the session has none", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({ request });
  await transport.ensureSession({ ...session, model: undefined });
  const params = request.mock.calls[0][1] as Record<string, unknown>;
  expect("model" in params).toBe(false);
});

test("setModel proxies modelId and the new model", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({ request });
  await transport.setModel(session, "claude-opus-4-8");
  expect(request).toHaveBeenCalledWith("setModel", expect.objectContaining({ modelId: "claude-opus-4-8", model: "claude-opus-4-8" }));
});

test("getSessionModel proxies and returns the result", async () => {
  const request = mock(async () => ({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] }));
  const transport = new AcpxBridgeTransport({ request });
  const result = await transport.getSessionModel(session);
  expect(result).toEqual({ current: "gpt-5.2[high]", available: ["gpt-5.2[high]"] });
  expect(request.mock.calls[0][0]).toBe("getSessionModel");
});

test("getSessionEffort proxies and returns the result", async () => {
  const request = mock(async () => ({ current: "high", available: ["medium", "high"] }));
  const transport = new AcpxBridgeTransport({ request });
  await expect(transport.getSessionEffort(session)).resolves.toEqual({
    current: "high",
    available: ["medium", "high"],
  });
  expect(request.mock.calls[0][0]).toBe("getSessionEffort");
});

test("setSessionEffort proxies the selected value", async () => {
  const request = mock(async () => ({}));
  const transport = new AcpxBridgeTransport({ request });
  await transport.setSessionEffort(session, "xhigh");
  expect(request).toHaveBeenCalledWith("setSessionEffort", expect.objectContaining({ effort: "xhigh" }));
});
