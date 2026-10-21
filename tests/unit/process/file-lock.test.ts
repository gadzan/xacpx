import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireFileLock, FileLockBusyError } from "../../../src/process/file-lock";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("file ownership preserves content and inode and an old release cannot release its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-file-lock-"));
  roots.push(root);
  const path = join(root, "owner.lock");
  await writeFile(path, "diagnostic metadata", { mode: 0o644 });
  const before = await stat(path);
  const first = await acquireFileLock(path);
  try {
    await expect(acquireFileLock(path)).rejects.toBeInstanceOf(FileLockBusyError);
    await Promise.all([first.release(), first.release()]);
    const second = await acquireFileLock(path);
    try {
      await first.release();
      await expect(acquireFileLock(path)).rejects.toBeInstanceOf(FileLockBusyError);
      expect(await readFile(path, "utf8")).toBe("diagnostic metadata");
      const after = await stat(path);
      expect(after.ino).toBe(before.ino);
      if (process.platform !== "win32") expect(after.mode & 0o777).toBe(0o600);
    } finally {
      await second.release();
    }
  } finally {
    await first.release();
  }
});

test("a non-contention native failure propagates instead of masquerading as a live owner", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "xacpx-file-lock-error-"));
  roots.push(root);
  const failure = Object.assign(new Error("flock denied"), { code: "EACCES" });
  await expect(acquireFileLock(join(root, "owner.lock"), {
    loadFsExt: () => ({ flock: (_fd, _operation, callback) => callback(failure) }),
  })).rejects.toBe(failure);
});

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest("Windows file locks fold filename case when identifying the same resource", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-file-lock-case-"));
  roots.push(root);
  const holder = await acquireFileLock(join(root, "Owner.lock"));
  try {
    const alternate = await acquireFileLock(join(root, "OWNER.LOCK")).then(
      (lock) => ({ lock, error: undefined }),
      (error: unknown) => ({ lock: undefined, error }),
    );
    await alternate.lock?.release();
    expect(alternate.error).toBeInstanceOf(FileLockBusyError);
  } finally {
    await holder.release();
  }
});
