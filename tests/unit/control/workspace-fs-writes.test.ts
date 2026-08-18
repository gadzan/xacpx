import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  realpath,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFs, copyName } from "../../../src/control/workspace-fs";
import { stat, readFile as readFileFs } from "node:fs/promises";

let rootDir: string; // realpath'd workspace root
let fs: WorkspaceFs;

beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(join(tmpdir(), "wfs-w-")));
  await mkdir(join(rootDir, "sub"));
  await writeFile(join(rootDir, "a.txt"), "hello");
  fs = new WorkspaceFs(() => [{ name: "ws", cwd: rootDir }]);
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

// resolveParent is private — exercise it through the public write methods (Task 2/3).
// This task's tests assert the *containment + name validation* behavior those methods inherit.
test("createFile rejects an absolute target path", async () => {
  await expect(fs.createFile("ws", "/etc/passwd")).rejects.toThrow(
    "path-must-be-relative",
  );
});
test("createFile rejects a parent that escapes via ..", async () => {
  await expect(fs.createFile("ws", "../escape.txt")).rejects.toThrow(
    "path-escapes-workspace",
  );
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

test("createFile creates an empty file and returns its rel path", async () => {
  const r = await fs.createFile("ws", "sub/new.txt");
  expect(r.path).toBe("sub/new.txt");
  const listed = await readdir(join(rootDir, "sub"));
  expect(listed).toContain("new.txt");
});
test("createFile on an existing path throws already-exists", async () => {
  await expect(fs.createFile("ws", "a.txt")).rejects.toThrow("already-exists");
});
test("createDir creates a directory", async () => {
  const r = await fs.createDir("ws", "sub/kid");
  expect(r.path).toBe("sub/kid");
  const listed = await readdir(join(rootDir, "sub"));
  expect(listed).toContain("kid");
});
test("createDir on an existing path throws already-exists", async () => {
  await expect(fs.createDir("ws", "sub")).rejects.toThrow("already-exists");
});

test("copyName inserts 'copy' before the extension and avoids collisions", () => {
  expect(copyName(new Set(["a.txt"]), "a.txt")).toBe("a copy.txt");
  expect(copyName(new Set(["a.txt", "a copy.txt"]), "a.txt")).toBe(
    "a copy 2.txt",
  );
  expect(copyName(new Set(["notes"]), "notes")).toBe("notes copy"); // no extension
  expect(copyName(new Set([".env"]), ".env")).toBe(".env copy"); // dotfile: no ext split
});

test("rename changes a file's name in the same directory", async () => {
  const r = await fs.rename("ws", "a.txt", "b.txt");
  expect(r.path).toBe("b.txt");
  const listed = await readdir(rootDir);
  expect(listed).toContain("b.txt");
  expect(listed).not.toContain("a.txt");
});
test("rename rejects when the target name already exists", async () => {
  await writeFile(join(rootDir, "c.txt"), "x");
  await expect(fs.rename("ws", "a.txt", "c.txt")).rejects.toThrow(
    "already-exists",
  );
});
test("rename rejects the workspace root", async () => {
  await expect(fs.rename("ws", "", "x")).rejects.toThrow();
});
test("rename rejects a newName with a separator", async () => {
  await expect(fs.rename("ws", "a.txt", "../evil")).rejects.toThrow(
    "bad-target",
  );
});

test("duplicate creates a sibling copy", async () => {
  const r = await fs.duplicate("ws", "a.txt");
  expect(r.path).toBe("a copy.txt");
  const listed = await readdir(rootDir);
  expect(listed).toContain("a copy.txt");
});
test("duplicate copies a directory recursively", async () => {
  await writeFile(join(rootDir, "sub", "inner.txt"), "deep");
  const r = await fs.duplicate("ws", "sub");
  expect(r.path).toBe("sub copy");
  const listed = await readdir(join(rootDir, "sub copy"));
  expect(listed).toContain("inner.txt");
});

test("remove deletes a file", async () => {
  await fs.remove("ws", "a.txt");
  const listed = await readdir(rootDir);
  expect(listed).not.toContain("a.txt");
});
test("remove deletes a directory recursively", async () => {
  await fs.remove("ws", "sub");
  const listed = await readdir(rootDir);
  expect(listed).not.toContain("sub");
});
test("remove refuses to delete the workspace root", async () => {
  await expect(fs.remove("ws", "")).rejects.toThrow("refuse-delete-root");
});

test("readFileBytes returns base64 + size + mimeType", async () => {
  const r = await fs.readFileBytes("ws", "a.txt");
  expect(Buffer.from(r.base64, "base64").toString("utf8")).toBe("hello");
  expect(r.size).toBe(5);
  expect(r.mimeType).toBe("text/plain");
});
test("readFileBytes rejects a file over 5 MiB", async () => {
  await writeFile(join(rootDir, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
  await expect(fs.readFileBytes("ws", "big.bin")).rejects.toThrow(
    "file-too-large",
  );
});

test("readFile returns an mtimeMs token", async () => {
  const r = await fs.readFile("ws", "a.txt");
  expect(typeof r.mtimeMs).toBe("number");
  expect(r.mtimeMs).toBeGreaterThan(0);
});

test("writeFile saves new content when the token matches", async () => {
  const before = await fs.readFile("ws", "a.txt");
  const res = await fs.writeFile("ws", "a.txt", "goodbye", {
    mtimeMs: before.mtimeMs,
    size: before.size,
  });
  expect(res.path).toBe("a.txt");
  expect(await readFileFs(join(rootDir, "a.txt"), "utf8")).toBe("goodbye");
  const onDisk = await stat(join(rootDir, "a.txt"));
  expect(res.mtimeMs).toBe(onDisk.mtimeMs);
  expect(res.size).toBe(onDisk.size);
});

test("writeFile rejects a stale token (size changed on disk)", async () => {
  const before = await fs.readFile("ws", "a.txt");
  await writeFile(join(rootDir, "a.txt"), "changed-by-agent");
  await expect(
    fs.writeFile("ws", "a.txt", "mine", {
      mtimeMs: before.mtimeMs,
      size: before.size,
    }),
  ).rejects.toThrow("stale-write");
});

test("writeFile rejects a path that escapes the workspace", async () => {
  await expect(
    fs.writeFile("ws", "../escape.txt", "x", { mtimeMs: 1, size: 1 }),
  ).rejects.toThrow();
});

test("writeFile rejects a directory target", async () => {
  await expect(
    fs.writeFile("ws", "sub", "x", { mtimeMs: 1, size: 1 }),
  ).rejects.toThrow("not-a-file");
});

test("writeFile rejects content containing a NUL byte", async () => {
  const before = await fs.readFile("ws", "a.txt");
  await expect(
    fs.writeFile("ws", "a.txt", "a\u0000b", {
      mtimeMs: before.mtimeMs,
      size: before.size,
    }),
  ).rejects.toThrow("is-binary");
});

test("writeFile rejects content over the size cap", async () => {
  const before = await fs.readFile("ws", "a.txt");
  const huge = "x".repeat(256 * 1024 + 1);
  await expect(
    fs.writeFile("ws", "a.txt", huge, {
      mtimeMs: before.mtimeMs,
      size: before.size,
    }),
  ).rejects.toThrow("file-too-large");
});

test("writeFile rejects saving over a file whose on-disk size exceeds the read cap (truncated-target guard)", async () => {
  // write a >256 KiB file, read it back (its read is truncated), then attempt to save small content with the matching token
  const big = "x".repeat(256 * 1024 + 500);
  await writeFile(join(rootDir, "big.txt"), big);
  const before = await fs.readFile("ws", "big.txt");
  expect(before.truncated).toBe(true);
  await expect(
    fs.writeFile("ws", "big.txt", "small", {
      mtimeMs: before.mtimeMs,
      size: before.size,
    }),
  ).rejects.toThrow("file-too-large");
});
