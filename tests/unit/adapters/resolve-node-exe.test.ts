import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveStableNodeExecutable } from "../../../src/adapters/resolve-node-exe";

test("resolves an absolute executable node path", async () => {
  const root = await mkdtemp(join(tmpdir(), "node-resolver-"));
  try {
    const node = join(root, "bin", "node");
    await mkdir(join(root, "bin"));
    await writeFile(node, "#!/bin/sh\n");
    await chmod(node, 0o755);
    await expect(resolveStableNodeExecutable({ execPath: node, env: { PATH: "" } })).resolves.toBe(await realpath(node));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never persists Bun as Node and falls back only to a real node executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-node-resolver-"));
  try {
    const node = join(root, "node");
    await writeFile(node, "#!/bin/sh\n");
    await chmod(node, 0o755);
    await expect(resolveStableNodeExecutable({ execPath: "/opt/bin/bun", env: { PATH: root } }))
      .resolves.toBe(await realpath(node));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  await expect(resolveStableNodeExecutable({ execPath: "/opt/bin/bun", env: { PATH: "" } }))
    .rejects.toThrow("Bun cannot be used");
});
