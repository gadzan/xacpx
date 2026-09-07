import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { buildTestPlan, collectTests } from "../../../scripts/run-tests-lib.mjs";

test("collects test files recursively in sorted order", () => {
  const tree = {
    "b.test.ts": "file",
    alpha: {
      "c.test.ts": "file",
      "ignore.ts": "file",
    },
    beta: {
      nested: {
        "a.test.ts": "file",
      },
    },
  };

  expect(collectTests("tests/unit", walkTree(tree))).toEqual([
    resolve("tests/unit/alpha/c.test.ts"),
    resolve("tests/unit/b.test.ts"),
    resolve("tests/unit/beta/nested/a.test.ts"),
  ]);
});

test("builds a test plan with typecheck before unit tests", () => {
  expect(buildTestPlan("tests/unit", () => [
    resolve("tests/unit/a.test.ts"),
    resolve("tests/unit/b.test.ts"),
  ])).toEqual([
    { command: "node", args: ["./node_modules/typescript/bin/tsc", "--noEmit"] },
    { command: "node", args: ["./scripts/lint-acpx-imports.mjs"] },
    { command: "bun", args: ["test", resolve("tests/unit/a.test.ts")] },
    { command: "bun", args: ["test", resolve("tests/unit/b.test.ts")] },
  ]);
});

function walkTree(tree: Record<string, unknown>) {
  return (path: string) => {
    const node = resolveNode(tree, path);
    if (!node || typeof node !== "object") {
      throw new Error(`missing directory: ${path}`);
    }

    return Object.keys(node)
      .sort()
      .map((name) => ({
        name,
        isDirectory: typeof node[name] === "object",
      }));
  };
}

function resolveNode(tree: Record<string, unknown>, path: string): Record<string, unknown> | null {
  const parts = path.split(/[/\\\\]/).filter(Boolean).slice(2);
  let current: unknown = tree;

  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current && typeof current === "object" ? (current as Record<string, unknown>) : null;
}
