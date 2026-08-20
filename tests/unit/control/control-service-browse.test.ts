import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, chmod } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep, dirname } from "node:path";
import { ControlService } from "../../../src/control/control-service";

const deps = {} as never; // browseDirectories touches no deps

test("browseDirectories defaults to home and reports home/sep/parent", async () => {
  const control = new ControlService(deps);
  const r = await control.browseDirectories();
  expect(r.path).toBe(homedir());
  expect(r.home).toBe(homedir());
  expect(r.sep).toBe(sep === "\\" ? "\\" : "/");
  expect(r.parent).toBe(dirname(homedir()));
});

test("browseDirectories lists only directories, sorted, including hidden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-"));
  await mkdir(join(dir, "b-dir"));
  await mkdir(join(dir, "A-dir"));
  await mkdir(join(dir, ".hidden"));
  await mkdir(join(dir, "sub", "nested"), { recursive: true }); // nested only visible inside sub
  await writeFile(join(dir, "file.txt"), "x");
  const control = new ControlService(deps);
  const r = await control.browseDirectories(dir);
  expect(r.dirs.map((d) => d.name)).toEqual([".hidden", "A-dir", "b-dir", "sub"]);
  expect(r.dirs.every((d) => d.path.startsWith(dir))).toBe(true);
  expect(r.truncated).toBe(false);
});

test("browseDirectories expands ~ and resolves relative against home", async () => {
  const control = new ControlService(deps);
  const r = await control.browseDirectories("~");
  expect(r.path).toBe(homedir());
});

test("browseDirectories follows symlinks to directories, skips broken ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-link-"));
  await mkdir(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "alias"));
  await symlink(join(dir, "nowhere"), join(dir, "broken"));
  const control = new ControlService(deps);
  const r = await control.browseDirectories(dir);
  expect(r.dirs.map((d) => d.name).sort()).toEqual(["alias", "real"]);
});

test("browseDirectories truncates at 1000 entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "browse-cap-"));
  // 1000 dirs + 1 over cap; mkdir 1001 tiny dirs is fast enough (~50ms)
  await Promise.all(Array.from({ length: 1001 }, (_, i) => mkdir(join(dir, `d${String(i).padStart(5, "0")}`))));
  const control = new ControlService(deps);
  const r = await control.browseDirectories(dir);
  expect(r.dirs.length).toBe(1000);
  expect(r.truncated).toBe(true);
});

test("browseDirectories reports null parent at a filesystem root", async () => {
  const control = new ControlService(deps);
  const r = await control.browseDirectories(sep);
  expect(r.parent).toBeNull();
});

test("browseDirectories throws ENOENT for a missing path", async () => {
  const control = new ControlService(deps);
  const missing = join(tmpdir(), "browse-nope-" + Date.now());
  await expect(control.browseDirectories(missing)).rejects.toThrow(/ENOENT|no such file/i);
});
