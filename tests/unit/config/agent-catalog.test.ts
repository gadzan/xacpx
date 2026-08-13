import { createAgentRegistry } from "acpx/runtime";
import { expect, test } from "bun:test";
import { listAgentCatalog } from "../../../src/config/agent-catalog";
import { listAgentTemplates } from "../../../src/config/agent-templates";
import { getAgentTemplate } from "../../../src/config/agent-templates";
import { isLocalAgentBinDriver } from "../../../src/config/local-agent-bin";
import { resolveRuntimeAgentCommand } from "../../../src/config/resolve-agent-command";
import type { AppConfig } from "../../../src/config/types";

function cfg(agents: Record<string, { driver: string }>): AppConfig {
  return { agents, workspaces: {} } as unknown as AppConfig;
}

const registry = createAgentRegistry();
function catalog(
  config: AppConfig,
  options: { probe?: (binary: string) => boolean; registry?: typeof registry | null } = {},
) {
  return listAgentCatalog(config, { registry, ...options });
}

test("grok-build and mux are explicit usable templates", () => {
  expect(getAgentTemplate("grok-build")).toEqual({ driver: "grok-build" });
  expect(getAgentTemplate("mux")).toEqual({ driver: "mux" });
  expect(listAgentTemplates()).toContain("grok-build");
  expect(listAgentTemplates()).toContain("mux");
});

// hermes is not in acpx's registry; resolveRuntimeAgentCommand supplies the shim
// command at spawn time, so the template itself stays command-free (config-portable).
test("hermes template is command-free (runtime shim supplies the command)", () => {
  expect(getAgentTemplate("hermes")).toEqual({ driver: "hermes" });
  expect(listAgentTemplates()).toContain("hermes");
});

test("hermes is 'yes' when the hermes binary is on PATH, else 'unknown'", () => {
  const yes = catalog(cfg({}), { probe: (bin) => bin === "hermes" });
  expect(yes.find((e) => e.driver === "hermes")!.installed).toBe("yes");
  const no = catalog(cfg({}), { probe: () => false });
  expect(no.find((e) => e.driver === "hermes")!.installed).toBe("unknown");
});

test("codex and claude are always builtin and configured-aware", () => {
  const cat = catalog(cfg({ codex: { driver: "codex" } }), { probe: () => false });
  const codex = cat.find((e) => e.driver === "codex")!;
  const claude = cat.find((e) => e.driver === "claude")!;
  expect(codex.installed).toBe("builtin");
  expect(codex.configured).toBe(true);
  expect(claude.installed).toBe("builtin");
  expect(claude.configured).toBe(false);
});

test("non-builtin driver is 'yes' when its binary is on PATH, else 'unknown'", () => {
  const cat = catalog(cfg({}), { probe: (bin) => bin === "gemini" });
  expect(cat.find((e) => e.driver === "gemini")!.installed).toBe("yes");
  expect(cat.find((e) => e.driver === "qwen")!.installed).toBe("unknown");
});

test("cursor probes the cursor-agent binary, not 'cursor'", () => {
  const seen: string[] = [];
  catalog(cfg({}), { probe: (bin) => { seen.push(bin); return false; } });
  expect(seen).toContain("cursor-agent");
  expect(seen).not.toContain("cursor");
});

// Regression: qoder's CLI is `qodercli`; probing "qoder" mislabelled an installed
// agent as "CLI not detected" in the web new-session dialog.
test("qoder is 'yes' when only the qodercli binary is on PATH", () => {
  const cat = catalog(cfg({}), { probe: (bin) => bin === "qodercli" });
  expect(cat.find((e) => e.driver === "qoder")!.installed).toBe("yes");
});

test("npx-launched drivers are builtin, not PATH-probed", () => {
  const seen: string[] = [];
  const cat = catalog(cfg({}), { probe: (bin) => { seen.push(bin); return false; } });
  for (const driver of ["pi", "kilocode", "opencode"]) {
    expect(cat.find((e) => e.driver === driver)!.installed).toBe("builtin");
    expect(seen).not.toContain(driver);
  }
});

test("configured is true when a config agent uses the driver under a different name", () => {
  const cat = catalog(cfg({ "my-gem": { driver: "gemini" } }), { probe: () => false });
  expect(cat.find((e) => e.driver === "gemini")!.configured).toBe(true);
});

// Drift guard against the REAL acpx dependency: every driver we offer must still be one
// acpx knows. `list()` is the canonical set; the two droid aliases are resolvable but not
// listed, so they fall back to the echo check — `resolve()` returns an unknown name
// unchanged instead of throwing, so a dropped name resolves to itself. (Membership first
// on purpose: the echo check alone would false-fail the day acpx ships a bare-invoked
// driver, which is acpx's argument style, not the thing under test.)
test("every template driver is still known to the acpx registry", () => {
  const registry = createAgentRegistry();
  const known = new Set(registry.list());
  // Drivers whose command xacpx itself supplies at runtime (e.g. the hermes shim,
  // or any local-fallback bin in LOCAL_AGENT_BINS like opencode/omp/reasonix) never
  // consult the acpx registry, so they are exempt from the drift guard.
  const dropped = listAgentTemplates().filter(
    (driver) =>
      !resolveRuntimeAgentCommand(driver, getAgentTemplate(driver)?.command, false) &&
      !known.has(driver) &&
      registry.resolve(driver) === driver &&
      !isLocalAgentBinDriver(driver),
  );
  expect(dropped).toEqual([]);
});

// The registry is loaded lazily and may be null: acpx is resolvable via PATH, in which case
// its runtime is not importable from here. That must degrade, never throw — src/main.ts pulls
// this module in on every command path, `doctor` included.
test("degrades to probing the bare driver name when acpx is unresolvable", () => {
  const seen: string[] = [];
  const cat = catalog(cfg({}), {
    probe: (bin) => { seen.push(bin); return bin === "qoder"; },
    registry: null,
  });
  expect(cat.find((e) => e.driver === "qoder")!.installed).toBe("yes");
  expect(seen).toContain("qoder");
  // Without the registry there is nothing to mark builtin, so npx drivers are probed by name.
  expect(cat.find((e) => e.driver === "opencode")!.installed).toBe("unknown");
  expect(cat).toHaveLength(listAgentTemplates().length);
});

test("every entry comes from listAgentTemplates and has the three fields", () => {
  const cat = catalog(cfg({}), { probe: () => false });
  expect(cat.length).toBeGreaterThanOrEqual(15);
  for (const e of cat) {
    expect(typeof e.driver).toBe("string");
    expect(typeof e.configured).toBe("boolean");
    expect(["builtin", "yes", "unknown"]).toContain(e.installed);
  }
});

// ── pool / zeroclaw templates ────────────────────────────────────────────────

test("pool and zeroclaw are command-free usable templates", () => {
  expect(getAgentTemplate("pool")).toEqual({ driver: "pool" });
  expect(getAgentTemplate("zeroclaw")).toEqual({ driver: "zeroclaw" });
  expect(listAgentTemplates()).toContain("pool");
  expect(listAgentTemplates()).toContain("zeroclaw");
});

// Registry drift guard: the pinned acpx must keep knowing pool/zeroclaw, else the
// templates would launch a driver acpx cannot resolve.
test("acpx registry knows pool and zeroclaw (drift guard)", () => {
  const names = listAgentTemplates();
  const registered = names.filter((name) => name === "pool" || name === "zeroclaw");
  const unknown = registered.filter((name) => {
    try {
      registry.resolve(name);
      return false;
    } catch {
      return true;
    }
  });
  expect(unknown).toEqual([]);
  // The registry's default commands are `pool acp` / `zeroclaw acp`.
  expect(registry.resolve("pool")).toEqual(["pool", "acp"]);
  expect(registry.resolve("zeroclaw")).toEqual(["zeroclaw", "acp"]);
});

test("pool and zeroclaw probe their own binaries when not builtin", () => {
  const cat = catalog(cfg({}), { probe: (bin) => bin === "pool" || bin === "zeroclaw" });
  expect(cat.find((e) => e.driver === "pool")!.installed).toBe("yes");
  expect(cat.find((e) => e.driver === "zeroclaw")!.installed).toBe("yes");
  const none = catalog(cfg({}), { probe: () => false });
  expect(none.find((e) => e.driver === "pool")!.installed).toBe("unknown");
  expect(none.find((e) => e.driver === "zeroclaw")!.installed).toBe("unknown");
});
