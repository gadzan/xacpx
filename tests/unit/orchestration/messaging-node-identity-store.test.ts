import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingNodeIdentityStore } from "../../../src/orchestration/messaging-node-identity-store";

test("creates one private node identity and reuses it after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xacpx-messaging-node-"));
  const path = join(directory, "agent-messaging", "node.json");

  try {
    const firstStore = new MessagingNodeIdentityStore(path);
    const first = await firstStore.loadOrCreate();
    const second = await new MessagingNodeIdentityStore(path).loadOrCreate();

    expect(first).toEqual(second);
    expect(first.nodeId).toMatch(/^node_[0-9a-f-]{36}$/);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      nodeId: first.nodeId,
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent first use to one node identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xacpx-messaging-node-"));
  const path = join(directory, "agent-messaging", "node.json");

  try {
    const [first, second] = await Promise.all([
      new MessagingNodeIdentityStore(path).loadOrCreate(),
      new MessagingNodeIdentityStore(path).loadOrCreate(),
    ]);

    expect(first).toEqual(second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed for a malformed persisted node identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xacpx-messaging-node-"));
  const path = join(directory, "node.json");

  try {
    await Bun.write(
      path,
      JSON.stringify({ version: 1, nodeId: "node_not-a-uuid" }),
    );

    await expect(
      new MessagingNodeIdentityStore(path).loadOrCreate(),
    ).rejects.toThrow("invalid Agent Messaging node identity");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
