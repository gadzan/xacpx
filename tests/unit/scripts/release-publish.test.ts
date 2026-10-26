import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as releaseLib from "../../../scripts/release-lib.mjs";
import { listBridgePackageDirs } from "../../../scripts/sync-rmux-bridge-versions.mjs";

const source = readFileSync(new URL("../../../scripts/release.mjs", import.meta.url), "utf8");
const declarationsStart = source.indexOf("const {\n");
const invocationStart = source.lastIndexOf("\nmain().catch(");
if (declarationsStart < 0 || invocationStart < declarationsStart) {
  throw new Error("Could not isolate release.mjs declarations from its module imports and CLI invocation");
}
const declarations = source.slice(declarationsStart, invocationStart);

/**
 * One top-level `function name(...) { ... }` declaration, extracted verbatim.
 *
 * The sandbox needs a function without the module imports it closes over, and
 * `runInNewContext` cannot strip those — so the helper takes just the text it
 * needs and the caller supplies the bindings. Non-function declarations are not
 * supported on purpose: slicing those reliably would mean parsing the file.
 */
function isolatedDeclaration(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`release.mjs has no function ${name}`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`release.mjs: ${name} is not a top-level function`);
  return source.slice(start, end + 2);
}

/**
 * The sweep gate driven with a fixed set of dirty paths.
 *
 * `assertReleaseTreeIsSweepable` decides whether a release may commit, and the
 * only honest way to test it is to hand it a tree and see whether it refuses.
 */
function sweepableHarness(dirty: string[]) {
  const api = runInNewContext(
    `${source.slice(source.indexOf("const BRIDGE_PLATFORM_SUFFIXES = ["), source.indexOf("const REGISTRY_ATTEMPTS"))}`
    + `${isolatedDeclaration("assertReleaseTreeIsSweepable")}\n({ assertReleaseTreeIsSweepable });`,
    {
      dirtyPaths: () => dirty,
      COMPAT_MANIFEST: releaseLib.COMPAT_MANIFEST,
      PACKAGE_REGISTRY: releaseLib.PACKAGE_REGISTRY,
      CORE_FLOOR_TRACKERS: releaseLib.CORE_FLOOR_TRACKERS,
    },
  ) as { assertReleaseTreeIsSweepable: () => boolean };
  return api;
}
const version = "1.2.3";
const previousVersion = "1.2.2";
const root = "/release-fixture";

interface ReleasePlan {
  releases: Array<{ id: string; from: string; to: string; tag: string }>;
  waves: string[][];
}

interface ReleaseApi {
  reportRegistry: (npmName: string, version: string) => Promise<boolean>;
  buildPublishPlan: () => ReleasePlan;
  cmdPublish: (plan: ReleasePlan, options: { yes: boolean; skipGates: boolean }) => Promise<number>;
}

interface RegistryResponse {
  ok: boolean;
  json: () => Promise<Record<string, string>>;
}

type RegistryFetch = (url: string, options: { signal: AbortSignal }) => Promise<RegistryResponse>;

function virtualClock() {
  let now = 0;
  const timeouts: number[] = [];
  const sleeps: number[] = [];
  const requests = new WeakMap<AbortSignal, { controller: AbortController; milliseconds: number }>();
  return {
    performance: { now: () => now },
    AbortSignal: {
      timeout(milliseconds: number) {
        const controller = new AbortController();
        requests.set(controller.signal, { controller, milliseconds });
        timeouts.push(milliseconds);
        return controller.signal;
      },
    },
    setTimeout(callback: () => void, milliseconds: number) {
      sleeps.push(milliseconds);
      now += milliseconds;
      callback();
      return 0;
    },
    expire(signal: AbortSignal) {
      const request = requests.get(signal);
      if (!request) throw new Error("Fetch did not receive the request timeout signal");
      now += request.milliseconds;
      request.controller.abort(new Error("Registry request timed out"));
    },
    timeouts,
    sleeps,
  };
}

function harness(options: {
  pending?: string[];
  clean?: boolean;
  fetch?: RegistryFetch;
  failPushOf?: (tag: string) => boolean;
  remoteTags?: Set<string>;
  remoteProbeOutcome?: "error";
  workflowByTag?: Record<string, { status: string; conclusion?: string | null }>;
  workflowRun?: { status: string; conclusion?: string | null };
} = {}) {
  const clock = virtualClock();
  const remoteTags = options.remoteTags ?? new Set<string>();
  const pending = options.pending ?? ["relay-protocol", "relay"];
  const tags = new Set(releaseLib.PACKAGE_REGISTRY.map((pkg) =>
    releaseLib.tagFor(pkg.id, pending.includes(pkg.id) ? previousVersion : version),
  ));
  const manifests: Record<string, string> = Object.fromEntries(releaseLib.PACKAGE_REGISTRY.map((pkg) => [
    join(root, pkg.manifestPath),
    JSON.stringify({ version }),
  ]));
  const commands: string[][] = [];
  const events: string[] = [];
  const output: string[] = [];
  const fetch: RegistryFetch = async (url, request) => {
    events.push(`registry ${url}`);
    return options.fetch ? options.fetch(url, request) : { ok: true, json: async () => ({ latest: version }) };
  };
  const api = runInNewContext(`${declarations}\n({ reportRegistry, buildPublishPlan, cmdPublish });`, {
    ROOT: root,
    LIB: releaseLib,
    join,
    readFileSync(path: string) {
      const manifest = manifests[path];
      if (!manifest) throw new Error(`Unexpected file read: ${path}`);
      return manifest;
    },
    writeFileSync() {
      throw new Error("Publish tests must not write files");
    },
    existsSync() {
      throw new Error("Unexpected filesystem access");
    },
    execFileSync(command: string, args: string[]) {
      commands.push([command, ...args]);
      events.push([command, ...args].join(" "));
      if (command === "gh" && args[0] === "run" && args[1] === "list") {
        return JSON.stringify([...tags].map((tag) => {
          const outcome = fixture.workflowByTag[tag];
          return {
            headBranch: tag,
            name: "publish",
            status: outcome?.status ?? "completed",
            conclusion: outcome?.conclusion ?? "success",
          };
        }));
      }
      if (command === "gh" && args[0] === "run" && args[1] === "view") {
        const run = options.workflowRun ?? { status: "completed", conclusion: "success" };
        return JSON.stringify(run);
      }
      if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      if (args[0] === "branch") return "main";
      if (args[0] === "remote") return "";
      if (args[0] === "status") return options.clean ? "" : " M packages/relay/package.json\0";
      if (args[0] === "diff") return "";
      if (args[0] === "rev-parse") return "release-head";
      if (args[0] === "tag" && args[1] === "--list") {
        const pattern = args[2]!;
        return [...tags].filter((tag) => pattern.endsWith("*")
          ? tag.startsWith(pattern.slice(0, -1))
          : tag === pattern).sort().reverse().join("\n");
      }
      if (args[0] === "tag" && args[1] === "--delete") {
        tags.delete(args[2]!);
        return "";
      }
      if (args[0] === "tag") {
        tags.add(args[1]!);
        return "";
      }
      if (args[0] === "ls-remote") {
        if (fixture.remoteProbeOutcome === "error") {
          throw Object.assign(new Error("network unreachable"), { status: 128 });
        }
        if (fixture.remoteTags.has(args[4]!)) return `${args[4]!}\n`;
        throw Object.assign(new Error(`no such ref: ${args[4]!}`), { status: 2 });
      }
      if (args[0] === "push") {
        if (args[1] === "origin" && options.failPushOf?.(args[2]!)) {
          throw new Error("network unreachable");
        }
        fixture.remoteTags.add(args[2]!);
        return "";
      }
      if (["add", "commit"].includes(args[0]!)) return "";
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
    console: Object.fromEntries(["log", "warn", "error"].map((method) => [
      method,
      (...args: unknown[]) => output.push(args.join(" ")),
    ])),
    fetch,
    performance: clock.performance,
    AbortSignal: clock.AbortSignal,
    setTimeout: clock.setTimeout,
  }, { filename: "release.mjs" }) as ReleaseApi;
  const fixture = { api, clock, tags, remoteTags, workflowByTag: options.workflowByTag ?? {}, remoteProbeOutcome: options.remoteProbeOutcome, commands, events, output };
  return fixture;
}

const notFound = (): RegistryResponse => ({ ok: false, json: async () => ({}) });
const live = (): RegistryResponse => ({ ok: true, json: async () => ({ beta: version }) });
const protocol = releaseLib.PACKAGE_REGISTRY.find((pkg) => pkg.id === "relay-protocol")!;
const protocolTag = releaseLib.tagFor(protocol.id, version);
const publishOptions = { yes: true, skipGates: true };

test("registry polling limits each request and truncates its final request to the six-minute deadline", async () => {
  let attempts = 0;
  const fixture = harness({ fetch: async (_url, { signal }) => {
    attempts += 1;
    if (attempts <= 2) return notFound();
    fixture.clock.expire(signal);
    throw signal.reason;
  } });

  expect(await fixture.api.reportRegistry(protocol.npmName, version)).toBe(false);
  expect(attempts).toBeGreaterThan(2);
  expect(fixture.clock.timeouts.every((timeout) => timeout > 0 && timeout <= 10_000)).toBe(true);
  expect(fixture.clock.timeouts[0]).toBe(10_000);
  expect(fixture.clock.timeouts.at(-1)).toBe(5_000);
  expect(fixture.clock.performance.now()).toBe(360_000);
  expect(fixture.clock.performance.now()).toBeLessThanOrEqual(360_000);
  expect(fixture.output.join("\n")).toContain("is not visible yet");
});

test("the fetch timeout remains active while an immediate response waits for its JSON body", async () => {
  let attempts = 0;
  let bodySignal: AbortSignal | undefined;
  let bodyAborted = false;
  const fixture = harness({ fetch: async (_url, { signal }) => {
    attempts += 1;
    if (attempts > 1) return live();
    bodySignal = signal;
    return {
      ok: true,
      json() {
        const { promise, reject } = Promise.withResolvers<Record<string, string>>();
        signal.addEventListener("abort", () => {
          bodyAborted = true;
          reject(signal.reason);
        }, { once: true });
        queueMicrotask(() => fixture.clock.expire(signal));
        return promise;
      },
    };
  } });

  expect(await fixture.api.reportRegistry(protocol.npmName, version)).toBe(true);
  expect(bodySignal?.aborted).toBe(true);
  expect(bodyAborted).toBe(true);
  expect(attempts).toBe(2);
  expect(fixture.clock.performance.now()).toBe(25_000);
  expect(fixture.output.join("\n")).toContain("dist-tag: beta");
});

test("registry polling recovers from a temporary 404 and a thrown request", async () => {
  let attempts = 0;
  const fixture = harness({ fetch: async () => {
    attempts += 1;
    if (attempts === 1) return notFound();
    if (attempts === 2) throw new Error("temporary network failure");
    return live();
  } });

  expect(await fixture.api.reportRegistry(protocol.npmName, version)).toBe(true);
  expect(attempts).toBe(3);
  expect(fixture.clock.sleeps).toEqual([15_000, 15_000]);
  expect(fixture.output.join("\n")).not.toContain("is not visible yet");
});

test("an unconfirmed protocol wave leaves the relay tag uncreated and prints recovery steps", async () => {
  const fixture = harness({ fetch: async () => notFound() });
  const plan = fixture.api.buildPublishPlan();
  const relayTag = releaseLib.tagFor("relay", version);

  expect(plan.releases.map((release) => release.id)).toEqual(["relay-protocol", "relay"]);
  expect(await fixture.api.cmdPublish(plan, publishOptions)).toBe(1);
  expect(fixture.tags.has(protocolTag)).toBe(true);
  expect(fixture.tags.has(relayTag)).toBe(false);
  expect(fixture.commands.filter((args) => args[0] === "git" && args[1] === "tag" && args[2] !== "--list"))
    .toEqual([["git", "tag", protocolTag, "release-head"]]);
  expect(fixture.commands.filter((args) => args[0] === "git" && args[1] === "push"))
    .toEqual([["git", "push", "origin", "main"], ["git", "push", "origin", protocolTag]]);
  const createIndex = fixture.events.indexOf(`git tag ${protocolTag} release-head`);
  expect(fixture.events[createIndex + 1]).toBe(`git push origin ${protocolTag}`);
  expect(fixture.output.join("\n")).toContain("Not pushed: relay");
  expect(fixture.output.join("\n")).toContain("curl -s https://registry.npmjs.org/-/package/");
  expect(fixture.output.join("\n")).toContain("publish --yes");
});

for (const consumer of ["relay", "channel-relay"]) {
  test(`retrying ${consumer} after its protocol tag was pushed stops until the protocol is visible`, async () => {
    const fixture = harness({ pending: [consumer], clean: true, fetch: async () => notFound() });
    const plan = fixture.api.buildPublishPlan();
    const consumerTag = releaseLib.tagFor(consumer, version);

    expect(fixture.tags.has(protocolTag)).toBe(true);
    expect(plan.releases.map((release) => release.id)).toEqual([consumer]);
    expect(await fixture.api.cmdPublish(plan, publishOptions)).toBe(1);
    expect(fixture.events.some((event) => event.includes(`/-/package/${protocol.npmName.replace("/", "%2F")}/dist-tags`)))
      .toBe(true);
    expect(fixture.tags.has(consumerTag)).toBe(false);
    expect(fixture.commands.some((args) => args[0] === "git" && args[1] === "push")).toBe(false);
    expect(fixture.output.join("\n")).toContain("preceding protocol wave is still unconfirmed");
    expect(fixture.output.join("\n")).toContain("publish --yes");
  });

  test(`retrying ${consumer} confirms the already-tagged protocol before creating and pushing its tag`, async () => {
    const fixture = harness({ pending: [consumer], clean: true });
    const plan = fixture.api.buildPublishPlan();
    const consumerTag = releaseLib.tagFor(consumer, version);

    expect(plan.releases.map((release) => release.id)).toEqual([consumer]);
    expect(await fixture.api.cmdPublish(plan, publishOptions)).toBe(0);
    const registryIndex = fixture.events.findIndex((event) =>
      event.includes(`/-/package/${protocol.npmName.replace("/", "%2F")}/dist-tags`));
    const createIndex = fixture.events.indexOf(`git tag ${consumerTag} release-head`);
    const pushIndex = fixture.events.indexOf(`git push origin ${consumerTag}`);
    expect(registryIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(registryIndex);
    expect(pushIndex).toBe(createIndex + 1);
    expect(fixture.commands.some((args) => args[0] === "git" && args[1] === "tag" && args[2] === protocolTag)).toBe(false);
    expect(fixture.output.join("\n")).toContain("all tags pushed");
  });
}

test("a failed tag push whose remote has no tag deletes the local tag and names the package", async () => {
  const fixture = harness({ failPushOf: (tag) => tag === protocolTag });
  const plan = fixture.api.buildPublishPlan();

  await expect(fixture.api.cmdPublish(plan, publishOptions)).rejects.toThrow(
    "deleted the local tag so the next run re-tags this package",
  );
  expect(fixture.tags.has(protocolTag)).toBe(false);
  expect(fixture.remoteTags.has(protocolTag)).toBe(false);
});

test("a failed tag push whose remote already has the tag keeps it for a re-push", async () => {
  const fixture = harness({
    failPushOf: (tag) => tag === protocolTag,
    remoteTags: new Set([protocolTag]),
  });
  const plan = fixture.api.buildPublishPlan();

  await expect(fixture.api.cmdPublish(plan, publishOptions)).rejects.toThrow("network unreachable");
  expect(fixture.tags.has(protocolTag)).toBe(true);
  expect(fixture.output.join("\n")).not.toContain("deleted the local tag");
});

test("a failed push of a later tag leaves earlier pushed tags untouched", async () => {
  const relayTag = releaseLib.tagFor("relay", version);
  const fixture = harness({ failPushOf: (tag) => tag === relayTag });
  const plan = fixture.api.buildPublishPlan();

  await expect(fixture.api.cmdPublish(plan, publishOptions)).rejects.toThrow("deleted the local tag");
  expect(fixture.tags.has(protocolTag)).toBe(true);
  expect(fixture.tags.has(relayTag)).toBe(false);
  expect(fixture.remoteTags.has(protocolTag)).toBe(true);
});

test("a remote probe failure keeps the local tag and asks for a manual check", async () => {
  const fixture = harness({
    failPushOf: (tag) => tag === protocolTag,
    remoteProbeOutcome: "error",
  });
  const plan = fixture.api.buildPublishPlan();

  await expect(fixture.api.cmdPublish(plan, publishOptions)).rejects.toThrow("remote state is unknown");
  expect(fixture.tags.has(protocolTag)).toBe(true);
  expect(fixture.remoteTags.has(protocolTag)).toBe(false);
});

test("the registry is not polled until each tag's workflow run has completed", async () => {
  const fixture = harness({
    pending: ["relay-protocol"],
    clean: true,
    workflowByTag: { [protocolTag]: { status: "queued", conclusion: null } },
    workflowRun: { status: "completed", conclusion: "success" },
  });
  const plan = fixture.api.buildPublishPlan();

  expect(await fixture.api.cmdPublish(plan, publishOptions)).toBe(0);
  const viewIndex = fixture.events.findIndex((event) => event.startsWith("gh run view "));
  const registryIndex = fixture.events.findIndex((event) => event.startsWith("registry "));
  expect(viewIndex).toBeGreaterThanOrEqual(0);
  expect(registryIndex).toBeGreaterThan(viewIndex);
  expect(fixture.events).toContain(`git push origin ${protocolTag}`);
});

test("a failed publish workflow stops the run before the registry is polled", async () => {
  const relayTag = releaseLib.tagFor("relay", version);
  const fixture = harness({
    workflowByTag: { [protocolTag]: { status: "completed", conclusion: "failure" } },
  });
  const plan = fixture.api.buildPublishPlan();

  await expect(fixture.api.cmdPublish(plan, publishOptions)).rejects.toThrow("publish run concluded failure");
  expect(fixture.events.some((event) => event.startsWith("registry "))).toBe(false);
  expect(fixture.events.some((event) => event === `git push origin ${relayTag}`)).toBe(false);
});

test("lock reconciliation restores missing bridge pins and check rejects drift", () => {
  const prefix = "@ganglion/xacpx-rmux-bridge-";
  const optionalDependencies = Object.fromEntries(
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]
      .map((platform) => [`${prefix}${platform}`, version]),
  );
  const matching = { version, optional: true, resolved: "https://registry.example/bridge.tgz", integrity: "sha512-fixture" };
  let lock: { packages: Record<string, { optional?: boolean; version?: string; resolved?: string }> } = {
    packages: {
      [`node_modules/${prefix}darwin-x64`]: { optional: true },
      [`node_modules/${prefix}linux-arm64`]: { optional: true, version: previousVersion, resolved: "stale.tgz" },
      [`node_modules/${prefix}linux-x64`]: matching,
      "node_modules/unrelated": { version: previousVersion },
    },
  };
  const isolatedFunction = (name: string) => {
    const start = source.indexOf(`function ${name}() {`);
    return source.slice(start, source.indexOf("\n}", start) + 2);
  };
  const errors: string[] = [];
  const api = runInNewContext(
    `${isolatedFunction("syncLockfiles")}\n${isolatedFunction("cmdCheck")}\n({ syncLockfiles, cmdCheck });`,
    {
      ROOT: root,
      join,
      readJson(path: string) {
        if (path === "package-lock.json") return lock;
        if (path === "packages/channel-relay/package.json") return { version, optionalDependencies };
        throw new Error(`Unexpected file read: ${path}`);
      },
      readFileSync: () => JSON.stringify(lock),
      writeFileSync: (_path: string, contents: string) => { lock = JSON.parse(contents); },
      execFileSync() {},
      npm() {},
      reconcileBunLock() {},
      floorViolations: () => [],
      console: { log() {}, error: (message: string) => errors.push(message) },
    },
  ) as { syncLockfiles: () => void; cmdCheck: () => number };

  expect(api.cmdCheck()).toBe(1);
  expect(errors.some((line) => line.includes("darwin-arm64 is missing"))).toBe(true);
  expect(errors.some((line) => line.includes(`expected ${version}`))).toBe(true);
  api.syncLockfiles();
  for (const [name, pin] of Object.entries(optionalDependencies)) {
    expect(lock.packages[`node_modules/${name}`]).toMatchObject({ optional: true, version: pin });
  }
  expect(lock.packages[`node_modules/${prefix}linux-x64`]).toEqual(matching);
  expect(lock.packages[`node_modules/${prefix}linux-arm64`]?.resolved).toBeUndefined();
  expect(lock.packages["node_modules/unrelated"]).toEqual({ version: previousVersion });
  expect(api.cmdCheck()).toBe(0);
});

test("the bridge manifests apply bumps are all paths publish will sweep", () => {
  // `apply` rewrites every platform package manifest through
  // sync-rmux-bridge-versions.mjs, and `publish` refuses any modified path it
  // does not own. Drive the real predicate with a tree whose ONLY changes are
  // those manifests: a platform directory the sync script knows about but
  // TOOL_OWNED_PATHS does not would make the next release refuse its own apply.
  const bumped = listBridgePackageDirs(fileURLToPath(new URL("../../../", import.meta.url)))
    .map((dir) => `platform-packages/${dir}/package.json`);
  expect(bumped.length).toBeGreaterThan(0);

  const api = sweepableHarness(bumped);
  expect(api.assertReleaseTreeIsSweepable()).toBe(false);

  // ...and an unrelated edit inside the same directory is still refused: only
  // the manifests are owned, not the shipped binaries, checksums or docs.
  const unrelated = sweepableHarness([...bumped, "platform-packages/xacpx-rmux-bridge-linux-x64/checksums.json"]);
  expect(() => unrelated.assertReleaseTreeIsSweepable()).toThrow(/unrelated modified paths/);
});

test("npm is spawned through a resolved CLI entry, never by executable name", () => {
  // `npm` is a shell script on POSIX and `npm.cmd` on Windows; Node refuses to
  // execFileSync a .cmd without a shell and cannot resolve a bare "npm" there at
  // all, so both spellings break one platform. Assert the spawn the code
  // performs, not how the source spells it.
  const spawns: string[][] = [];
  // The test process is bun, whose execPath ships no npm — so this pins a real
  // node instead of inheriting the runner's. The guard that refuses bun is
  // covered by its own test.
  const nodeExecPath = process.env.RELEASE_TEST_NODE ?? "node";
  const realNode = spawnSync(nodeExecPath, ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).stdout;
  const api = runInNewContext(
    `${isolatedDeclaration("npmCliPath")}\n${isolatedDeclaration("npm")}\n({ npm, npmCliPath });`,
    {
      process: { execPath: realNode, versions: {} },
      realpathSync,
      existsSync,
      resolve,
      dirname,
      join,
      ROOT: root,
      execFileSync(command: string, args: string[]) {
        spawns.push([command, ...args]);
        return "";
      },
    },
  ) as { npm: (args: string[]) => void; npmCliPath: () => string };

  const entry = api.npmCliPath();
  expect(entry).toBe(join(dirname(realpathSync(realNode)), "node_modules", "npm", "bin", "npm-cli.js"));
  expect(existsSync(entry)).toBe(true);

  api.npm(["install", "--package-lock-only"]);
  expect(spawns).toEqual([[realNode, entry, "install", "--package-lock-only"]]);
  expect(spawns[0]?.[0]).not.toBe("npm");
});

test("the npm CLI entry is found from every installer layout", () => {
  // nvm/fnm/Homebrew put npm at <dir>/../lib/node_modules, the Windows
  // installer at <dir>/node_modules, and some global installs at
  // <dir>/../node_modules. Resolving only one of those trades the Windows bug
  // for a POSIX one. Paths are built with `join` so the assertion holds on any
  // host separator.
  const posixLayout = join("lib", "node_modules", "npm", "bin", "npm-cli.js");
  const api = runInNewContext(
    `${isolatedDeclaration("npmCliPath")}\n({ npmCliPath });`,
    {
      process: { execPath: join("fake", "bin", "node"), versions: {} },
      realpathSync: (path: string) => path,
      existsSync: (path: string) => path.endsWith(posixLayout),
      resolve: (path: string) => path,
      dirname,
      join,
    },
  ) as { npmCliPath: () => string };

  expect(api.npmCliPath().endsWith(posixLayout)).toBe(true);
});

test("a missing npm entry names every path it tried", () => {
  const api = runInNewContext(
    `${isolatedDeclaration("npmCliPath")}\n({ npmCliPath });`,
    {
      process: { execPath: "posix-bin-node", versions: {} },
      realpathSync: (path: string) => path,
      existsSync: () => false,
      resolve: (path: string) => path,
      dirname,
      join,
    },
  ) as { npmCliPath: () => string };

  const message = (() => { try { api.npmCliPath(); } catch (error) { return (error as Error).message; } return ""; })();
  expect(message).toContain("cannot locate npm");
  expect(message.match(/npm-cli\.js/g)?.length).toBe(3);
});

test("running under bun is refused with a message that says what to do", () => {
  // process.execPath under bun names the bun binary, which ships no npm, so the
  // candidate paths would all miss and the error would misdirect the operator.
  const api = runInNewContext(
    `${isolatedDeclaration("npmCliPath")}\n({ npmCliPath });`,
    {
      process: { execPath: "/fake/bun", versions: { bun: "1.4.2" } },
      realpathSync: (path: string) => path,
      existsSync: () => true,
      resolve: (path: string) => path,
      dirname,
      join,
    },
  ) as { npmCliPath: () => string };

  expect(() => api.npmCliPath()).toThrow(/run the release tool with node, not bun/);
});
