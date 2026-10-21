import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function collectTests(rootDir, listEntries = defaultListEntries) {
  return walk(rootDir, listEntries).map((file) => resolve(file));
}

// Files exercising native filesystem, locking, process, and SQLite behavior.
const MACOS_TEST_FILES = [
  "tests/unit/adapters/adapter-locks.test.ts",
  "tests/unit/bootstrap.test.ts",
  "tests/unit/bridge/engine/runtime/runtime-engine.test.ts",
  "tests/unit/bridge/engine/runtime/runtime-worker-fence.test.ts",
  "tests/unit/bridge/engine/runtime/runtime-worker-shutdown.test.ts",
  "tests/unit/config/config-store.test.ts",
  "tests/unit/conversations/conversation-concurrency-sqlite.test.ts",
  "tests/unit/conversations/conversation-effect-sqlite.test.ts",
  "tests/unit/conversations/conversation-resource-admission.test.ts",
  "tests/unit/conversations/sqlite-conversation-store.test.ts",
  "tests/unit/control/control-service-browse.test.ts",
  "tests/unit/control/workspace-fs.test.ts",
  "tests/unit/control/workspace-git.test.ts",
  "tests/unit/daemon/runtime-consumer-lock.test.ts",
  "tests/unit/main.test.ts",
  "tests/unit/packages/channel-relay/terminal-registry-store.test.ts",
  "tests/unit/process/ipc-guard.test.ts",
];

export function buildTestPlan(rootDir, collect = collectTests) {
  const files = rootDir === "--macos" ? MACOS_TEST_FILES.map((file) => resolve(file)) : collect(rootDir);
  return [
    {
      command: "node",
      args: ["./node_modules/typescript/bin/tsc", "--noEmit"],
    },
    // G13 (plan §61): only runtime-adapter.ts may import acpx/runtime — no
    // private acpx/dist or acpx/src imports anywhere in src.
    {
      command: "node",
      args: ["./scripts/lint-acpx-imports.mjs"],
    },
    ...files.map((file) => ({
      command: "bun",
      args: ["test", file],
    })),
    ...(rootDir === "--macos" ? [{ command: "node", args: ["./scripts/smoke-terminal-conpty.mjs"] }] : []),
  ];
}

function walk(dir, listEntries) {
  const files = [];

  for (const entry of listEntries(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...walk(fullPath, listEntries));
      continue;
    }

    if (entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

function defaultListEntries(dir) {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const fullPath = join(dir, name);
      return {
        name,
        isDirectory: statSync(fullPath).isDirectory(),
      };
    });
}
