import { expect, test } from "bun:test";

import {
  resolveTransportEngine,
  resolveTransportEngineWithEligibility,
} from "../../../src/sessions/transport-engine";

const baseConfig = {
  type: "acpx-bridge" as const,
  permissionMode: "approve-all" as const,
  nonInteractivePermissions: "deny" as const,
};

test("persisted binding wins over config for existing sessions", () => {
  expect(
    resolveTransportEngine({
      config: { ...baseConfig, engine: "cli" },
      session: { transport_engine: "runtime" },
    }),
  ).toEqual({
    engine: "runtime",
  });
  expect(
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      session: { transport_engine: "cli" },
    }),
  ).toEqual({
    engine: "cli",
  });
});

test("existing persisted runtime binding survives even with nonInteractivePermissions=fail", () => {
  expect(
    resolveTransportEngine({
      config: { ...baseConfig, engine: "cli", nonInteractivePermissions: "fail" },
      session: { transport_engine: "runtime" },
    }),
  ).toEqual({
    engine: "runtime",
  });
});

test("explicit transport.command forces cli and is reported under auto and cli", () => {
  const cliChoice = resolveTransportEngine({
    config: { ...baseConfig, engine: "cli", command: "/opt/acpx/bin" },
  });
  expect(cliChoice.engine).toBe("cli");
  expect(cliChoice.reason).toBe("explicit-acpx-command");

  const autoChoice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto", command: "/opt/acpx/bin" },
    runtimeAvailable: true,
  });
  expect(autoChoice.engine).toBe("cli");
  expect(autoChoice.reason).toBe("explicit-acpx-command");
});

test("strict runtime engine with explicit command throws configuration error", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime", command: "/opt/acpx/bin" },
      runtimeAvailable: true,
    }),
  ).toThrow(/conflicts with explicit transport.command/);
});

test("strict runtime engine without runtime support throws instead of silently binding cli", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      runtimeAvailable: false,
    }),
  ).toThrow(/requires acpx Runtime worker support/);
});

test("strict runtime engine binds runtime once runtimeAvailable is true", () => {
  expect(
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      runtimeAvailable: true,
    }),
  ).toEqual({
    engine: "runtime",
  });
});

test("auto mode stays on cli when runtime worker is absent", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    runtimeAvailable: false,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("runtime-import-failed");
});

test("auto mode selects runtime when runtime is available and eligible", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("runtime");
  expect(choice.reason).toBeUndefined();
});

test("missing engine field defaults to cli (development-phase default)", () => {
  expect(resolveTransportEngine({ config: baseConfig })).toEqual({ engine: "cli" });
});

test("strict runtime with nonInteractivePermissions=fail throws configuration error", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime", nonInteractivePermissions: "fail" },
      runtimeAvailable: true,
    }),
  ).toThrow(/is not eligible with nonInteractivePermissions = "fail"/);
});

test("auto mode with nonInteractivePermissions=fail falls back to cli with unsupported-permission-mode", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto", nonInteractivePermissions: "fail" },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("unsupported-permission-mode");
});

test("strict runtime with escalate policy and no interactive permissions throws", () => {
  expect(() =>
    resolveTransportEngine({
      config: {
        ...baseConfig,
        engine: "runtime",
        permissionPolicy: JSON.stringify({ escalate: ["edit"] }),
      },
      runtimeAvailable: true,
      permissionInteractionAvailable: false,
    }),
  ).toThrow(/is not eligible under current permission policy/);
});

test("auto mode with escalate policy and no interactive permissions falls back to cli", () => {
  const choice = resolveTransportEngine({
    config: {
      ...baseConfig,
      engine: "auto",
      permissionPolicy: JSON.stringify({ escalate: ["edit"] }),
    },
    runtimeAvailable: true,
    permissionInteractionAvailable: false,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("unsupported-permission-policy");
});

test("strict runtime with escalate policy and interactive permissions available binds runtime", () => {
  const choice = resolveTransportEngine({
    config: {
      ...baseConfig,
      engine: "runtime",
      permissionPolicy: JSON.stringify({ escalate: ["edit"] }),
    },
    runtimeAvailable: true,
    permissionInteractionAvailable: true,
  });
  expect(choice.engine).toBe("runtime");
});

test("auto mode with escalate policy and interactive permissions available selects runtime", () => {
  const choice = resolveTransportEngine({
    config: {
      ...baseConfig,
      engine: "auto",
      permissionPolicy: JSON.stringify({ escalate: ["edit"] }),
    },
    runtimeAvailable: true,
    permissionInteractionAvailable: true,
  });
  expect(choice.engine).toBe("runtime");
});

test("strict runtime with invalid permission policy JSON throws", () => {
  expect(() =>
    resolveTransportEngine({
      config: {
        ...baseConfig,
        engine: "runtime",
        permissionPolicy: "{ invalid json",
      },
      runtimeAvailable: true,
    }),
  ).toThrow(/permission policy error/);
});

test("auto mode with invalid permission policy falls back to cli", () => {
  const choice = resolveTransportEngine({
    config: {
      ...baseConfig,
      engine: "auto",
      permissionPolicy: "{ invalid json",
    },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("unsupported-permission-policy");
});

test("strict runtime with unsupported permissionMode throws", () => {
  expect(() =>
    resolveTransportEngine({
      config: {
        ...baseConfig,
        engine: "runtime",
        permissionMode: "custom-invalid" as unknown as typeof baseConfig.permissionMode,
      },
      runtimeAvailable: true,
    }),
  ).toThrow(/unsupported permissionMode/);
});

test("auto mode with unsupported permissionMode falls back to cli", () => {
  const choice = resolveTransportEngine({
    config: {
      ...baseConfig,
      engine: "auto",
      permissionMode: "custom-invalid" as unknown as typeof baseConfig.permissionMode,
    },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("unsupported-permission-mode");
});

test("strict runtime with unsupported session shape throws", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      session: { agent: "" },
      runtimeAvailable: true,
    }),
  ).toThrow(/unsupported session shape/);

  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      sessionShapeSupported: false,
      runtimeAvailable: true,
    }),
  ).toThrow(/unsupported session shape/);
});

test("auto mode with unsupported session shape falls back to cli", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    session: { agent: "" },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("unsupported-session-shape");
});

test("strict runtime with recordCompatible=false throws", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      recordCompatible: false,
      runtimeAvailable: true,
    }),
  ).toThrow(/record compatibility check failed/);
});

test("auto mode with recordCompatible=false falls back to cli", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    recordCompatible: false,
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("record-compatibility-failed");
});

test("resolveTransportEngineWithEligibility alias works identically", () => {
  expect(
    resolveTransportEngineWithEligibility({
      config: { ...baseConfig, engine: "runtime" },
      runtimeAvailable: true,
    }),
  ).toEqual({ engine: "runtime" });
});

test("custom runtimeProbe callback is called when runtimeAvailable is omitted", () => {
  let probed = false;
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    runtimeProbe: () => {
      probed = true;
      return true;
    },
  });
  expect(probed).toBe(true);
  expect(choice.engine).toBe("runtime");
});

test("capability probe: worker file exists but import fails => auto mode selects cli with runtime-probe-failed", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    runtimeProbe: () => true,
    capability: {
      runtimeAvailable: false,
      runtimeImportOk: false,
      contractProbeOk: false,
      acpxVersion: "0.13.1",
      reason: "acpx/runtime import failed: Cannot find module",
    },
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("runtime-probe-failed");
});

test("capability probe: worker file exists but import fails => strict runtime throws before persistence", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      runtimeProbe: () => true,
      capability: {
        runtimeAvailable: false,
        runtimeImportOk: false,
        contractProbeOk: false,
        acpxVersion: "0.13.1",
        reason: "acpx/runtime import failed: Cannot find module",
      },
    }),
  ).toThrow(/failed runtime capability probe/);
});

test("capability probe: worker file exists but contract check fails => auto mode selects cli with runtime-probe-failed", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    runtimeProbe: () => true,
    capability: {
      runtimeAvailable: false,
      runtimeImportOk: true,
      contractProbeOk: false,
      acpxVersion: "0.13.1",
      reason: "missing required exports [createAgentRegistry]",
    },
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("runtime-probe-failed");
});

test("capability probe: worker file exists but contract check fails => strict runtime throws before persistence", () => {
  expect(() =>
    resolveTransportEngine({
      config: { ...baseConfig, engine: "runtime" },
      runtimeProbe: () => true,
      capability: {
        runtimeAvailable: false,
        runtimeImportOk: true,
        contractProbeOk: false,
        acpxVersion: "0.13.1",
        reason: "missing required exports [createAgentRegistry]",
      },
    }),
  ).toThrow(/failed runtime capability probe: missing required exports/);
});

test("capability probe: capability ok => auto mode selects runtime", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    capability: {
      runtimeAvailable: true,
      runtimeImportOk: true,
      contractProbeOk: true,
      acpxVersion: "0.13.1",
    },
  });
  expect(choice.engine).toBe("runtime");
  expect(choice.reason).toBeUndefined();
});

test("capability probe: capability ok => strict runtime selects runtime", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "runtime" },
    capability: {
      runtimeAvailable: true,
      runtimeImportOk: true,
      contractProbeOk: true,
      acpxVersion: "0.13.1",
    },
  });
  expect(choice.engine).toBe("runtime");
});

test("capability probe: capability is preferred over runtimeProbe callback", () => {
  let probeCalled = false;
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    runtimeProbe: () => {
      probeCalled = true;
      return true;
    },
    capability: {
      runtimeAvailable: false,
      runtimeImportOk: false,
      contractProbeOk: false,
      reason: "probe failed",
    },
  });
  expect(choice.engine).toBe("cli");
  expect(choice.reason).toBe("runtime-probe-failed");
  expect(probeCalled).toBe(false);
});

test("capability probe: persisted runtime session remains runtime even if capability fails", () => {
  const choice = resolveTransportEngine({
    config: { ...baseConfig, engine: "auto" },
    session: { transport_engine: "runtime" },
    capability: {
      runtimeAvailable: false,
      runtimeImportOk: false,
      contractProbeOk: false,
    },
  });
  expect(choice.engine).toBe("runtime");
});
test("acpx-cli transport forces cli for new sessions even when runtime is eligible", () => {
  const choice = resolveTransportEngine({
    config: { type: "acpx-cli", engine: "auto", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("cli");
});

test("acpx-cli transport with strict runtime throws configuration error", () => {
  expect(() =>
    resolveTransportEngine({
      config: { type: "acpx-cli", engine: "runtime", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
      runtimeAvailable: true,
    }),
  ).toThrow(/requires transport.type = "acpx-bridge"/);
});

test("persisted runtime binding survives transport type switch (existing affinity wins)", () => {
  const choice = resolveTransportEngine({
    config: { type: "acpx-cli", engine: "auto", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    session: { transport_engine: "runtime" },
    runtimeAvailable: true,
  });
  expect(choice.engine).toBe("runtime");
});
