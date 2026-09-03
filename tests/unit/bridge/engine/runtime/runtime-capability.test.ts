import { expect, test } from "bun:test";
import { probeEngineCapabilities } from "../../../../../src/bridge/engine/runtime-capability";
import { BridgeServer } from "../../../../../src/bridge/bridge-server";
import { BridgeRuntime } from "../../../../../src/bridge/bridge-runtime";
import { AcpxBridgeTransport } from "../../../../../src/transport/acpx-bridge/acpx-bridge-transport";
import type { BridgeEngineCapabilities } from "../../../../../src/transport/acpx-bridge/acpx-bridge-protocol";

test("probeEngineCapabilities: returns failure when runtime import throws", async () => {
  const result = await probeEngineCapabilities({
    loadRuntime: () => {
      throw new Error("Module not found: acpx/runtime");
    },
    loadAcpxVersion: () => "0.13.1",
  });

  expect(result.runtimeAvailable).toBe(false);
  expect(result.runtimeImportOk).toBe(false);
  expect(result.contractProbeOk).toBe(false);
  expect(result.acpxVersion).toBe("0.13.1");
  expect(result.reason).toContain("acpx/runtime import failed: Module not found");
});

test("probeEngineCapabilities: returns failure when required exports are missing", async () => {
  const result = await probeEngineCapabilities({
    loadRuntime: () => ({
      createAcpRuntime: () => {},
      // createRuntimeStore missing
      createAgentRegistry: () => {},
    }),
    loadAcpxVersion: () => "0.13.1",
  });

  expect(result.runtimeAvailable).toBe(false);
  expect(result.runtimeImportOk).toBe(true);
  expect(result.contractProbeOk).toBe(false);
  expect(result.acpxVersion).toBe("0.13.1");
  expect(result.reason).toContain("missing required exports [createRuntimeStore]");
});

test("probeEngineCapabilities: returns failure when worker entry is missing", async () => {
  const result = await probeEngineCapabilities({
    loadRuntime: () => ({
      createAcpRuntime: () => {},
      createRuntimeStore: () => {},
      createAgentRegistry: () => {},
    }),
    loadAcpxVersion: () => "0.13.1",
    workerEntryPath: "/nonexistent/path/worker.js",
  });

  expect(result.runtimeAvailable).toBe(false);
  expect(result.runtimeImportOk).toBe(true);
  expect(result.contractProbeOk).toBe(true);
  expect(result.acpxVersion).toBe("0.13.1");
  expect(result.reason).toContain("runtime worker entry not found");
});

test("probeEngineCapabilities: returns failure when RuntimeEngine construction throws", async () => {
  const result = await probeEngineCapabilities({
    loadRuntime: () => ({
      createAcpRuntime: () => {},
      createRuntimeStore: () => {},
      createAgentRegistry: () => {},
    }),
    loadAcpxVersion: () => "0.13.1",
    createRuntimeEngine: () => {
      throw new Error("Construction failed: invalid state dir");
    },
  });

  expect(result.runtimeAvailable).toBe(false);
  expect(result.runtimeImportOk).toBe(true);
  expect(result.contractProbeOk).toBe(false);
  expect(result.acpxVersion).toBe("0.13.1");
  expect(result.reason).toContain("RuntimeEngine construction failed: Construction failed");
});

test("probeEngineCapabilities: returns success when all checks pass", async () => {
  const result = await probeEngineCapabilities({
    loadRuntime: () => ({
      createAcpRuntime: () => {},
      createRuntimeStore: () => {},
      createAgentRegistry: () => {},
    }),
    loadAcpxVersion: () => "0.13.1",
    createRuntimeEngine: () => ({}),
  });

  expect(result.runtimeAvailable).toBe(true);
  expect(result.runtimeImportOk).toBe(true);
  expect(result.contractProbeOk).toBe(true);
  expect(result.acpxVersion).toBe("0.13.1");
  expect(result.reason).toBeUndefined();
});

test("BridgeServer handles getEngineCapabilities dispatch", async () => {
  const mockCapabilities: BridgeEngineCapabilities = {
    runtimeAvailable: true,
    runtimeImportOk: true,
    contractProbeOk: true,
    acpxVersion: "0.13.1",
  };

  const runtime = new BridgeRuntime("acpx", async () => ({ code: 0, stdout: "", stderr: "" }));
  const server = new BridgeServer(runtime, 10_000, async () => mockCapabilities);

  const responseLine = await server.handleLine(
    JSON.stringify({
      id: "probe-req-1",
      method: "getEngineCapabilities",
      params: {},
    }),
  );

  expect(responseLine).not.toBeNull();
  const parsed = JSON.parse(responseLine!);
  expect(parsed).toEqual({
    id: "probe-req-1",
    ok: true,
    result: mockCapabilities,
  });
});

test("AcpxBridgeTransport.getEngineCapabilities calls bridge method", async () => {
  const mockCapabilities: BridgeEngineCapabilities = {
    runtimeAvailable: false,
    runtimeImportOk: false,
    contractProbeOk: false,
    acpxVersion: "0.13.1",
    reason: "worker missing",
  };

  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      requests.push({ method, params });
      return mockCapabilities as unknown as T;
    },
  };

  const transport = new AcpxBridgeTransport(client as never);
  const result = await transport.getEngineCapabilities();

  expect(requests).toEqual([{ method: "getEngineCapabilities", params: {} }]);
  expect(result).toEqual(mockCapabilities);
});
