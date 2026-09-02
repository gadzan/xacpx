import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PACKAGES,
  collectPublishVerificationFailures,
} from "../../../scripts/verify-publish.mjs";

type PublishPackageConfig = {
  id: string;
  dir: string;
  expectedName: string;
  requiredFiles: string[];
  requiredPeer?: string;
  forbiddenPeer?: string;
  expectedExportedName?: string;
  forbiddenPathPatterns?: string[];
};

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createTempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "weacpx-verify-publish-"));
  tempRoots.push(root);
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "packages/channel-feishu/dist"), { recursive: true });
  await mkdir(join(root, "packages/channel-feishu/src"), { recursive: true });
  await mkdir(join(root, "packages/channel-yuanbao/dist"), { recursive: true });
  await mkdir(join(root, "packages/channel-yuanbao/src"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });

  await writeJson(join(root, "package.json"), {
    name: "weacpx-console",
    files: ["dist", "README.md", "config.example.json"],
  });
  await writeFile(join(root, "README.md"), "# weacpx\n", "utf8");
  await writeFile(join(root, "config.example.json"), "{}\n", "utf8");
  await writeFile(join(root, "dist/cli.js"), "console.log('cli');\n", "utf8");
  await writeFile(join(root, "dist/plugin-api.js"), "export {};\n", "utf8");
  await writeFile(join(root, "dist/plugin-api.d.ts"), "export {};\n", "utf8");

  await writeJson(join(root, "packages/channel-feishu/package.json"), {
    name: "@ganglion/weacpx-channel-feishu",
    files: ["dist", "README.md"],
    peerDependencies: { "weacpx-console": ">=0.1.0" },
    peerDependenciesMeta: { "weacpx-console": { optional: true } },
  });
  await writeFile(join(root, "packages/channel-feishu/README.md"), "# feishu\n", "utf8");
  await writeFile(join(root, "packages/channel-feishu/dist/index.js"), "export default { name: '@ganglion/weacpx-channel-feishu' };\n", "utf8");
  await writeFile(join(root, "packages/channel-feishu/dist/index.d.ts"), "declare const plugin: unknown; export default plugin;\n", "utf8");
  await writeFile(join(root, "packages/channel-feishu/src/index.ts"), "import type { WeacpxPlugin } from 'weacpx-console/plugin-api';\nexport default { name: '@ganglion/weacpx-channel-feishu' } satisfies Partial<WeacpxPlugin>;\n", "utf8");

  await writeJson(join(root, "packages/channel-yuanbao/package.json"), {
    name: "@ganglion/weacpx-channel-yuanbao",
    files: ["dist", "README.md"],
    peerDependencies: { weacpx: ">=0.3.2" },
    peerDependenciesMeta: { weacpx: { optional: true } },
  });
  await writeFile(join(root, "packages/channel-yuanbao/README.md"), "# yuanbao\n", "utf8");
  await writeFile(join(root, "packages/channel-yuanbao/dist/index.js"), "export default { name: '@ganglion/weacpx-channel-yuanbao' };\n", "utf8");
  await writeFile(join(root, "packages/channel-yuanbao/dist/index.d.ts"), "declare const plugin: unknown; export default plugin;\n", "utf8");
  await writeFile(join(root, "packages/channel-yuanbao/src/index.ts"), "import type { WeacpxPlugin } from 'weacpx/plugin-api';\nexport default { name: '@ganglion/weacpx-channel-yuanbao' } satisfies Partial<WeacpxPlugin>;\n", "utf8");
  await writeFile(join(root, "docs/plugin-development.md"), "use weacpx-console/plugin-api\n", "utf8");

  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packageConfigs(): PublishPackageConfig[] {
  return [
    {
      id: "root",
      dir: ".",
      expectedName: "weacpx",
      requiredFiles: ["dist/cli.js", "dist/plugin-api.js", "dist/plugin-api.d.ts", "README.md", "config.example.json", "package.json"],
      forbiddenPathPatterns: [
        "^dist/channels/feishu/",
        "^dist/channels/cli/feishu-provider",
        "^dist/channels/yuanbao/",
        "^dist/channels/cli/yuanbao-provider",
      ],
    },
    {
      id: "channel-feishu",
      dir: "packages/channel-feishu",
      expectedName: "@ganglion/weacpx-channel-feishu",
      requiredFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
      requiredPeer: "weacpx",
      forbiddenPeer: "weacpx-console",
      expectedExportedName: "@ganglion/weacpx-channel-feishu",
    },
    {
      id: "channel-yuanbao",
      dir: "packages/channel-yuanbao",
      expectedName: "@ganglion/weacpx-channel-yuanbao",
      requiredFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
      requiredPeer: "weacpx",
      forbiddenPeer: "weacpx-console",
      expectedExportedName: "@ganglion/weacpx-channel-yuanbao",
    },
  ];
}

test("collectPublishVerificationFailures reports package metadata and stale API imports", async () => {
  const repoRoot = await createTempRepo();

  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: packageConfigs(),
    scanPaths: ["packages", "docs"],
    runDryRun: false,
  });

  expect(failures).toContain("root: package.json name must be weacpx, got weacpx-console");
  expect(failures).toContain("channel-feishu: package.json peerDependencies must include weacpx");
  expect(failures).toContain("channel-feishu: package.json peerDependencies must not include weacpx-console");
  expect(failures.some((failure) => failure.includes("packages/channel-feishu/src/index.ts") && failure.includes("weacpx-console/plugin-api"))).toBe(true);
  expect(failures.some((failure) => failure.includes("docs/plugin-development.md") && failure.includes("weacpx-console/plugin-api"))).toBe(true);
});

test("collectPublishVerificationFailures rejects tarball with forbidden stale paths", async () => {
  const repoRoot = await createTempRepo();
  await writeJson(join(repoRoot, "package.json"), {
    name: "weacpx",
    version: "0.3.3",
    files: ["dist", "README.md", "config.example.json"],
  });
  // Stage stale leftover files from before C2 that should never end up in the published tarball.
  await mkdir(join(repoRoot, "dist/channels/feishu"), { recursive: true });
  await mkdir(join(repoRoot, "dist/channels/cli"), { recursive: true });
  await writeFile(join(repoRoot, "dist/channels/feishu/channel.d.ts"), "export {};\n", "utf8");
  await writeFile(join(repoRoot, "dist/channels/cli/feishu-provider.d.ts"), "export {};\n", "utf8");
  // Plugins still need a valid package.json so verifyPackage doesn't choke on them.
  await writeJson(join(repoRoot, "packages/channel-feishu/package.json"), {
    name: "@ganglion/weacpx-channel-feishu",
    version: "0.3.3",
    files: ["dist", "README.md"],
    peerDependencies: { weacpx: ">=0.3.3" },
    peerDependenciesMeta: { weacpx: { optional: true } },
  });
  await writeFile(join(repoRoot, "packages/channel-feishu/src/index.ts"), "import type { WeacpxPlugin } from 'weacpx/plugin-api';\nexport default { name: '@ganglion/weacpx-channel-feishu' } satisfies Partial<WeacpxPlugin>;\n", "utf8");

  const rootOnly = packageConfigs().filter((cfg) => cfg.id === "root");
  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: rootOnly,
    scanPaths: [],
    runDryRun: true,
  });

  expect(failures.some((f) => f.includes("forbidden path dist/channels/feishu/channel.d.ts"))).toBe(true);
  expect(failures.some((f) => f.includes("forbidden path dist/channels/cli/feishu-provider.d.ts"))).toBe(true);
});

test("collectPublishVerificationFailures passes a valid publish layout without dry-run", async () => {
  const repoRoot = await createTempRepo();
  await writeJson(join(repoRoot, "package.json"), {
    name: "weacpx",
    files: ["dist", "README.md", "config.example.json"],
  });
  await writeJson(join(repoRoot, "packages/channel-feishu/package.json"), {
    name: "@ganglion/weacpx-channel-feishu",
    files: ["dist", "README.md"],
    peerDependencies: { weacpx: ">=0.3.2" },
    peerDependenciesMeta: { weacpx: { optional: true } },
  });
  await writeFile(join(repoRoot, "packages/channel-feishu/src/index.ts"), "import type { WeacpxPlugin } from 'weacpx/plugin-api';\nexport default { name: '@ganglion/weacpx-channel-feishu' } satisfies Partial<WeacpxPlugin>;\n", "utf8");
  await writeFile(join(repoRoot, "docs/plugin-development.md"), "use weacpx/plugin-api\n", "utf8");

  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: packageConfigs(),
    scanPaths: ["packages", "docs"],
    runDryRun: false,
  });

  expect(failures).toEqual([]);
});

// The tests above inject their own package fixture, so DEFAULT_PACKAGES is only
// ever exercised here: an unregistered package would ship completely unchecked.
test("DEFAULT_PACKAGES registers every publishable package under packages/", async () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const packagesRoot = join(repoRoot, "packages");
  const packageDirs = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const violations: string[] = [];
  let checked = 0;
  for (const dir of packageDirs) {
    const manifestPath = join(packagesRoot, dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: string;
      private?: boolean;
    };
    if (manifest.private === true) continue;
    checked += 1;
    const entry = DEFAULT_PACKAGES.find((pkg) => pkg.dir === `packages/${dir}`);
    if (!entry) {
      violations.push(`packages/${dir} (${manifest.name ?? "unnamed"}) is not registered in DEFAULT_PACKAGES`);
      continue;
    }
    if (entry.expectedName !== manifest.name) {
      violations.push(`packages/${dir} expectedName=${entry.expectedName} != package.json name=${manifest.name}`);
    }
  }

  expect(checked).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
