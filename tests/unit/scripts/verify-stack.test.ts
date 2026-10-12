import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildIsolatedConfig,
  daemonEnv,
  manifestPath,
  parseAccessToken,
  planPluginHome,
  removeStateDir,
  statePaths,
} from "../../../scripts/verify-stack.mjs";

describe("verify-stack planPluginHome", () => {
  it("resolves the connector closure from the repo and skips platform bridges", () => {
    const { plan, missing } = planPluginHome();
    const names = plan.map((entry) => entry.name);
    expect(names).toContain("@ganglion/xacpx-channel-relay");
    expect(names).toContain("@ganglion/xacpx-relay-protocol");
    expect(names.some((name) => name.includes("rmux-bridge"))).toBe(false);
    expect(missing).toEqual([]);
  });

  it("keeps every target inside the isolated plugin home", () => {
    const { plan } = planPluginHome();
    for (const entry of plan) {
      expect(entry.target.startsWith(statePaths().plugins)).toBe(true);
    }
  });
});

describe("verify-stack buildIsolatedConfig", () => {
  const paths = statePaths(18787);

  it("redirects every daemon write into the state dir", () => {
    const config = buildIsolatedConfig({ port: 18787, token: "t0ken", workdir: paths.root });
    expect(config.channels[0].options.url).toBe("ws://127.0.0.1:18787");
    expect(config.channels[0].options.pairingToken).toBe("t0ken");
    expect(config.transport.permissionMode).toBe("approve-all");
    expect(config.transport.nonInteractivePermissions).toBe("deny");
    expect(config.conversations).toBeUndefined();
  });

  it("enables the router only when a restricted command is supplied", () => {
    const config = buildIsolatedConfig({
      port: 18787,
      token: "t0ken",
      workdir: paths.root,
      routerCommand: paths.router,
    });
    expect(config.conversations.router).toEqual({ enabled: true, command: paths.router });
  });
});

describe("verify-stack helpers", () => {
  it("parses the access token printed once by add token", () => {
    expect(parseAccessToken("created token abc123\naccess token: xacpx_relay_deadbeef\n")).toBe(
      "xacpx_relay_deadbeef",
    );
    expect(parseAccessToken("no token here")).toBeNull();
  });

  it("isolates HOME so the real relay credential is never reused", () => {
    const env = daemonEnv(statePaths());
    expect(env.HOME).toBe(statePaths().home);
    expect(env.WEACPX_CONFIG).toBe(statePaths().config);
    expect(env.WEACPX_STATE).toBe(statePaths().state);
    expect(env.XACPX_PLUGIN_HOME).toBe(statePaths().plugins);
  });

  it("keeps the manifest inside the temp state root", () => {
    const root = statePaths().root;
    expect(manifestPath().startsWith(root)).toBe(true);
    expect(manifestPath().endsWith("manifest.json")).toBe(true);
  });
});

describe("verify-stack removeStateDir", () => {
  it("removes every entry including the manifest", () => {
    const root = join(statePaths().root, "remove-test");
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "relay.db"), "db");
    writeFileSync(join(root, "runtime", "app.log"), "log");
    writeFileSync(join(root, "manifest.json"), "{}");
    expect(removeStateDir(root)).toEqual([]);
    expect(existsSync(root)).toBe(false);
    // leave no empty scaffold behind; a live stack keeps the parent non-empty
    try {
      rmdirSync(statePaths().root);
    } catch {
      /* parent still in use */
    }
  });
});
