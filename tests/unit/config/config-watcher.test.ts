import { expect, test } from "bun:test";
import type { FSWatcher } from "node:fs";

import { startConfigWatcher } from "../../../src/config/config-watcher";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A fake node:fs `watch` that captures the listener so tests can drive directory
// events synchronously — no real filesystem, no timing flake on the logic paths.
function fakeWatch() {
  const state = { closed: 0, watchedPath: "" };
  let listener: ((event: string, filename: string | null) => void) | undefined;
  const factory = ((dir: string, _opts: unknown, cb: (e: string, f: string | null) => void) => {
    state.watchedPath = dir;
    listener = cb;
    return { close: () => { state.closed += 1; }, on: () => {} } as unknown as FSWatcher;
  }) as never;
  return { factory, state, emit: (filename: string | null) => listener?.("change", filename) };
}

test("coalesces a burst of events on the config file into one debounced callback", async () => {
  const fake = fakeWatch();
  let fired = 0;
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => { fired += 1; }, debounceMs: 20, watchFactory: fake.factory });
  // One logical save emits several directory events (temp create, rename, attrs).
  fake.emit("config.json");
  fake.emit("config.json");
  fake.emit("config.json");
  await delay(50);
  expect(fired).toBe(1);
  w.close();
});

test("ignores changes to unrelated directory entries", async () => {
  const fake = fakeWatch();
  let fired = 0;
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => { fired += 1; }, debounceMs: 20, watchFactory: fake.factory });
  fake.emit("state.json");
  fake.emit("config.json.lock");
  fake.emit("config.json.tmp-12345");
  await delay(50);
  expect(fired).toBe(0);
  w.close();
});

test("still fires when the platform reports a null filename", async () => {
  const fake = fakeWatch();
  let fired = 0;
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => { fired += 1; }, debounceMs: 20, watchFactory: fake.factory });
  fake.emit(null);
  await delay(50);
  expect(fired).toBe(1);
  w.close();
});

test("close() clears a pending callback and closes the underlying watcher", async () => {
  const fake = fakeWatch();
  let fired = 0;
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => { fired += 1; }, debounceMs: 20, watchFactory: fake.factory });
  fake.emit("config.json");
  w.close();
  await delay(50);
  expect(fired).toBe(0);
  expect(fake.state.closed).toBe(1);
});

test("default debounce is short enough for next-message pickup (fires within 200ms)", async () => {
  // The router no longer reloads config per message; the watcher is the ONLY
  // path for out-of-band edits (ownerIds!) to reach a running daemon. The
  // default debounce must stay well under a human message round-trip so an
  // edit is live by the next message. 200ms would catch a regression back to
  // the old 250ms default while giving the 100ms timer real margin.
  const fake = fakeWatch();
  let fired = 0;
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => { fired += 1; }, watchFactory: fake.factory });
  fake.emit("config.json");
  await delay(200);
  expect(fired).toBe(1);
  w.close();
});

test("a throwing onChange is swallowed and does not crash the watcher", async () => {
  const fake = fakeWatch();
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => { throw new Error("boom"); }, debounceMs: 10, watchFactory: fake.factory });
  fake.emit("config.json");
  await delay(40);
  // No unhandled rejection / throw escaped; reaching here is the assertion.
  expect(fake.state.closed).toBe(0);
  w.close();
});

test("a failing fs.watch start degrades gracefully (no throw, close is a no-op)", () => {
  const throwingFactory = (() => { throw new Error("ENOSYS: watch not supported"); }) as never;
  const w = startConfigWatcher({ configPath: "/x/config.json", onChange: () => {}, watchFactory: throwingFactory });
  expect(() => w.close()).not.toThrow();
});

test("watches the parent DIRECTORY, not the config file itself", () => {
  // Config writes go through write-file-atomic (temp + rename), which replaces the
  // file's inode — a watch bound to the file would go deaf after one save. Watching
  // the containing directory survives every atomic replace; assert we do exactly that.
  const fake = fakeWatch();
  const w = startConfigWatcher({ configPath: "/home/u/.xacpx/config.json", onChange: () => {}, watchFactory: fake.factory });
  expect(fake.state.watchedPath).toBe("/home/u/.xacpx");
  w.close();
});
