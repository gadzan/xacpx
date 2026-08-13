import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dir, "../../..");

interface FreshProbeResult {
  known: string[];
  factories: string[];
  cliProviders: string[];
}

async function runFreshProbe(source: string): Promise<FreshProbeResult & Record<string, unknown>> {
  const tempDir = await mkdtemp(join(tmpdir(), "weacpx-channel-boundary-"));
  const probeFile = join(tempDir, "probe.ts");
  await writeFile(probeFile, source, "utf8");

  const proc = Bun.spawn({
    cmd: [process.execPath, probeFile],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await rm(tempDir, { recursive: true, force: true });

  if (exitCode !== 0) {
    throw new Error(`fresh channel probe failed with exit ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  return JSON.parse(stdout);
}

function moduleUrl(relativePath: string): string {
  return pathToFileURL(join(repoRoot, relativePath)).href;
}

test("fresh core exposes only weixin as a built-in channel before plugins load", async () => {
  const result = await runFreshProbe(`
    import { listKnownChannelIds } from ${JSON.stringify(moduleUrl("src/channels/channel-scope.ts"))};
    import { getRegisteredChannelTypes } from ${JSON.stringify(moduleUrl("src/channels/create-channel.ts"))};
    import { getRegisteredChannelCliProviderTypes } from ${JSON.stringify(moduleUrl("src/channels/cli/registry.ts"))};

    console.log(JSON.stringify({
      known: listKnownChannelIds().sort(),
      factories: getRegisteredChannelTypes().sort(),
      cliProviders: getRegisteredChannelCliProviderTypes().sort(),
    }));
  `);

  expect(result).toEqual({
    known: ["weixin"],
    factories: ["weixin"],
    cliProviders: ["weixin"],
  });
});

test("plugin registration dynamically adds channel id, factory, and CLI provider", async () => {
  const result = await runFreshProbe(`
    import { listKnownChannelIds } from ${JSON.stringify(moduleUrl("src/channels/channel-scope.ts"))};
    import { getRegisteredChannelTypes } from ${JSON.stringify(moduleUrl("src/channels/create-channel.ts"))};
    import { getRegisteredChannelCliProviderTypes } from ${JSON.stringify(moduleUrl("src/channels/cli/registry.ts"))};
    import { registerChannelPlugin } from ${JSON.stringify(moduleUrl("src/channels/plugin.ts"))};

    const runtime = {
      id: "guardrail-plugin",
      isLoggedIn: () => true,
      login: async () => "guardrail-plugin",
      logout: () => {},
      start: async () => {},
      notifyTaskCompletion: async () => {},
      notifyTaskProgress: async () => {},
      sendCoordinatorMessage: async () => {},
    };

    registerChannelPlugin({
      type: "guardrail-plugin",
      factory: () => runtime,
      cliProvider: {
        type: "guardrail-plugin",
        displayName: "Guardrail Plugin",
        supportsLogin: false,
        parseAddArgs: () => ({ ok: true, input: {} }),
        buildDefaultConfig: () => ({ id: "guardrail-plugin", type: "guardrail-plugin", enabled: true }),
        validateConfig: () => [],
        renderSummary: () => ["type: guardrail-plugin"],
        promptForMissingFields: async (input) => input,
      },
    });

    console.log(JSON.stringify({
      known: listKnownChannelIds().sort(),
      factories: getRegisteredChannelTypes().sort(),
      cliProviders: getRegisteredChannelCliProviderTypes().sort(),
    }));
  `);

  expect(result).toEqual({
    known: ["guardrail-plugin", "weixin"],
    factories: ["guardrail-plugin", "weixin"],
    cliProviders: ["guardrail-plugin", "weixin"],
  });
});

test("plugins cannot override the built-in weixin channel", async () => {
  const result = await runFreshProbe(`
    import { listKnownChannelIds } from ${JSON.stringify(moduleUrl("src/channels/channel-scope.ts"))};
    import { getRegisteredChannelTypes } from ${JSON.stringify(moduleUrl("src/channels/create-channel.ts"))};
    import { getRegisteredChannelCliProviderTypes } from ${JSON.stringify(moduleUrl("src/channels/cli/registry.ts"))};
    import { registerChannelPlugin } from ${JSON.stringify(moduleUrl("src/channels/plugin.ts"))};

    const runtime = {
      id: "weixin",
      isLoggedIn: () => true,
      login: async () => "weixin",
      logout: () => {},
      start: async () => {},
      notifyTaskCompletion: async () => {},
      notifyTaskProgress: async () => {},
      sendCoordinatorMessage: async () => {},
    };

    let factoryError = "";
    let providerError = "";

    try {
      registerChannelPlugin({ type: "weixin", factory: () => runtime });
    } catch (error) {
      factoryError = error instanceof Error ? error.message : String(error);
    }

    try {
      registerChannelPlugin({
        type: "guardrail-provider-only",
        factory: () => ({ ...runtime, id: "guardrail-provider-only" }),
        cliProvider: {
          type: "weixin",
          displayName: "Fake Weixin",
          supportsLogin: false,
          parseAddArgs: () => ({ ok: true, input: {} }),
          buildDefaultConfig: () => ({ id: "weixin", type: "weixin", enabled: true }),
          validateConfig: () => [],
          renderSummary: () => ["type: weixin"],
          promptForMissingFields: async (input) => input,
        },
      });
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
    }

    console.log(JSON.stringify({
      known: listKnownChannelIds().sort(),
      factories: getRegisteredChannelTypes().sort(),
      cliProviders: getRegisteredChannelCliProviderTypes().sort(),
      factoryError,
      providerError,
    }));
  `);

  expect(result.factoryError).toBe("channel type is already registered: weixin");
  expect(result.providerError).toBe("channel CLI provider is already registered: weixin");
  expect(result.factories).toEqual(["weixin"]);
  expect(result.cliProviders).toEqual(["weixin"]);
  expect(result.known).toEqual(["weixin"]);
});

test("core channel source files contain only weixin-specific implementations", async () => {
  const channelEntries = await readdir(join(repoRoot, "src/channels"), { withFileTypes: true });
  const forbiddenChannelFiles = channelEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith("-channel.ts") && name !== "weixin-channel.ts" && name !== "create-channel.ts")
    .sort();

  const cliEntries = await readdir(join(repoRoot, "src/channels/cli"), { withFileTypes: true });
  const forbiddenProviderFiles = cliEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith("-provider.ts") && name !== "weixin-provider.ts")
    .sort();

  expect(forbiddenChannelFiles).toEqual([]);
  expect(forbiddenProviderFiles).toEqual([]);
});

test("first-party channel packages live outside core", async () => {
  const packageEntries = await readdir(join(repoRoot, "packages"), { withFileTypes: true });
  const channelPackages = packageEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => basename(entry.name))
    .filter((name) => name.startsWith("channel-"))
    .sort();

  expect(channelPackages).toEqual(["channel-feishu", "channel-relay", "channel-yuanbao"]);
});

test("core does not import first-party channel plugin packages", async () => {
  const allowed = new Set([
    join(repoRoot, "src/plugins/known-plugins.ts"),
    join(repoRoot, "src/plugins/plugin-renames.ts"),
  ]);
  const hits: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (allowed.has(path)) continue;
      const source = await Bun.file(path).text();
      if (source.includes("@ganglion/xacpx-channel-relay")
        || source.includes("@ganglion/xacpx-channel-feishu")
        || source.includes("@ganglion/xacpx-channel-yuanbao")) {
        hits.push(path.slice(repoRoot.length + 1));
      }
    }
  }

  await walk(join(repoRoot, "src"));
  expect(hits).toEqual([]);
});
