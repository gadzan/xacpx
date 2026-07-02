import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, realpath, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFs } from "../../../src/control/workspace-fs";

let rootDir: string;      // realpath'd workspace root
let fs: WorkspaceFs;

beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(join(tmpdir(), "wfs-w-")));
  await mkdir(join(rootDir, "sub"));
  await writeFile(join(rootDir, "a.txt"), "hello");
  fs = new WorkspaceFs(() => [{ name: "ws", cwd: rootDir }]);
});
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

// resolveParent is private — exercise it through the public write methods (Task 2/3).
// This task's tests assert the *containment + name validation* behavior those methods inherit.
test("createFile rejects an absolute target path", async () => {
  await expect(fs.createFile("ws", "/etc/passwd")).rejects.toThrow("path-must-be-relative");
});
test("createFile rejects a parent that escapes via ..", async () => {
  await expect(fs.createFile("ws", "../escape.txt")).rejects.toThrow("path-escapes-workspace");
});
test("createFile rejects a name containing a path separator", async () => {
  await expect(fs.createFile("ws", "sub/deep/x.txt")).rejects.toThrow(); // parent "sub/deep" missing → not-found
  await expect(fs.createFile("ws", "a/b")).rejects.toThrow();
});
test("createFile rejects '.' and '..' as the final segment", async () => {
  await expect(fs.createFile("ws", ".")).rejects.toThrow("bad-target");
  await expect(fs.createFile("ws", "..")).rejects.toThrow();
});
test("createFile rejects creating at the workspace root (empty path)", async () => {
  await expect(fs.createFile("ws", "")).rejects.toThrow("bad-target");
});
