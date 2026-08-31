import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { ConsumerLockMetadata } from "../../../../src/channels/types";

// Review round 3 (#4 follow-up): the lock must be PER TOKEN (F6: one Gateway
// session per token), not a hash of the whole accountId:token set. Overlapping
// token sets, a token moved to a different accountId, and rollback of partial
// acquisition must all hold. Lock files live under coreHomeDir(homedir()), so
// HOME/USERPROFILE is pointed at a temp dir to keep the real ~/.xacpx clean.

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let fakeHome: string;

beforeAll(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  fakeHome = mkdtempSync(path.join(tmpdir(), "discord-lock-test-"));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function meta(): ConsumerLockMetadata {
  return { pid: process.pid, mode: "start" } as unknown as ConsumerLockMetadata;
}

function channelWith(accounts: Record<string, { token: string }>): DiscordChannel {
  return new DiscordChannel({ accounts }, {});
}

// Dual-package hazard: from inside packages/*, `xacpx/plugin-api` resolves to
// the bundled dist entry, so the thrown class is not identity-equal to the
// source module's class. Assert by name + message instead of instanceof.
function expectConflict(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("ActiveConsumerLockError");
  expect((error as Error).message).toContain("lock held");
}

async function acquireExpectConflict(lock: { acquire: (m: ConsumerLockMetadata) => Promise<void> }): Promise<void> {
  let conflict: unknown = null;
  try {
    await lock.acquire(meta());
  } catch (error) {
    conflict = error;
  }
  expectConflict(conflict);
}

test("same token contends; disjoint tokens coexist", async () => {
  const chA1 = channelWith({ a: { token: "tok-A" } });
  const chA2 = channelWith({ a: { token: "tok-A" } });
  const chB = channelWith({ a: { token: "tok-B" } });

  const lockA1 = chA1.createConsumerLock();
  const lockA2 = chA2.createConsumerLock();
  const lockB = chB.createConsumerLock();

  await lockA1.acquire(meta());
  await acquireExpectConflict(lockA2);

  await lockB.acquire(meta());
  await lockB.release();
  await lockA1.release();

  // After release the same-token lock can be acquired again.
  await lockA2.acquire(meta());
  await lockA2.release();
});

test("overlapping token sets contend ({X} blocks {X,Y})", async () => {
  const chX = channelWith({ a: { token: "tok-X" } });
  const chXY = channelWith({ a: { token: "tok-X" }, b: { token: "tok-Y" } });

  const lockX = chX.createConsumerLock();
  const lockXY = chXY.createConsumerLock();

  await lockX.acquire(meta());
  // The old set-hash naming let {X,Y} coexist with {X} and start tok-X twice.
  // Per-token locking must reject it.
  await acquireExpectConflict(lockXY);

  await lockX.release();
  await lockXY.acquire(meta());
  await lockXY.release();
});

test("accountId re-homing does not bypass the token lock", async () => {
  const ch1 = channelWith({ primary: { token: "tok-X" } });
  const ch2 = channelWith({ secondary: { token: "tok-X" } });

  const lock1 = ch1.createConsumerLock();
  const lock2 = ch2.createConsumerLock();

  await lock1.acquire(meta());
  await acquireExpectConflict(lock2);
  await lock1.release();
});

test("failed multi-token acquire rolls back locks already held", async () => {
  const chXY = channelWith({ a: { token: "tok-X" }, b: { token: "tok-Y" } });
  const chYZ = channelWith({ a: { token: "tok-Y" }, b: { token: "tok-Z" } });
  const chZ = channelWith({ a: { token: "tok-Z" } });
  const chX = channelWith({ a: { token: "tok-X" } });

  const lockXY = chXY.createConsumerLock();
  await lockXY.acquire(meta());

  // chYZ overlaps on tok-Y: must fail AND release any lock it took before
  // hitting the conflict, so tok-Z is not left stranded.
  await acquireExpectConflict(chYZ.createConsumerLock());

  const lockZ = chZ.createConsumerLock();
  await lockZ.acquire(meta());
  await lockZ.release();

  // tok-X is still held by lockXY.
  await acquireExpectConflict(chX.createConsumerLock());

  await lockXY.release();

  // Everything free again after release.
  await lockXY.acquire(meta());
  await lockXY.release();
});

test("one token shared by two accounts never reaches the lock layer", () => {
  // Round 4: config validation rejects duplicate resolved tokens across
  // enabled accounts, so one process cannot start two Gateway clients for
  // one token. createConsumerLock() still de-dups the token set as
  // defense-in-depth, but here construction itself must fail.
  expect(() => channelWith({ a: { token: "tok-S" }, b: { token: "tok-S" } })).toThrow(/duplicates the bot token/);
});

// Round 7 (High): core injects a config-scoped lock path, so it must not anchor
// the token namespace. `tokenLockPath()` repeats the naming rule instead of
// asking the implementation where it wrote: if the fence ever moves out of the
// user-global core home, this path stops matching and the tests below fail loudly
// rather than silently protecting nothing.
function tokenLockPath(token: string): string {
  const fingerprint = createHash("sha256").update(token).digest("hex").slice(0, 16);
  return path.join(fakeHome, ".xacpx", "runtime", `discord-consumer-${fingerprint}.lock.json`);
}

test("the same token contends across two config roots", async () => {
  const dirA = mkdtempSync(path.join(fakeHome, "config-A-"));
  const dirB = mkdtempSync(path.join(fakeHome, "config-B-"));
  const lockA = channelWith({ a: { token: "tok-CROSS" } }).createConsumerLock({
    lockFilePath: path.join(dirA, "discord-consumer.lock.json"),
  });
  const lockB = channelWith({ a: { token: "tok-CROSS" } }).createConsumerLock({
    lockFilePath: path.join(dirB, "discord-consumer.lock.json"),
  });

  await lockA.acquire(meta());
  await acquireExpectConflict(lockB);
  // The conflict is real contention, not a path artefact: B takes it once A lets go.
  await lockA.release();
  await lockB.acquire(meta());
  await lockB.release();

  // And the fence never lived in either injected config dir.
  expect(readdirSync(dirA)).toEqual([]);
  expect(readdirSync(dirB)).toEqual([]);
  expect(existsSync(tokenLockPath("tok-CROSS"))).toBe(false);
});

test("different tokens in different config roots still coexist", async () => {
  const dirA = mkdtempSync(path.join(fakeHome, "config-A-"));
  const dirB = mkdtempSync(path.join(fakeHome, "config-B-"));
  const lockA = channelWith({ a: { token: "tok-E1" } }).createConsumerLock({
    lockFilePath: path.join(dirA, "discord-consumer.lock.json"),
  });
  const lockB = channelWith({ a: { token: "tok-E2" } }).createConsumerLock({
    lockFilePath: path.join(dirB, "discord-consumer.lock.json"),
  });

  await lockA.acquire(meta());
  await lockB.acquire(meta());
  await lockA.release();
  await lockB.release();
});

test("the per-token fence is created in the user-global core home", async () => {
  const dir = mkdtempSync(path.join(fakeHome, "injected-"));
  const lock = channelWith({ a: { token: "tok-GLOBAL" } }).createConsumerLock({
    lockFilePath: path.join(dir, "discord-consumer.lock.json"),
  });

  await lock.acquire(meta());
  expect(existsSync(tokenLockPath("tok-GLOBAL"))).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
  await lock.release();
});

// Round 7 (High): the holder creates the file with "wx" and writes its JSON
// afterwards, so a reader can catch it empty. Deleting what cannot be parsed was
// how a live holder's lock got stolen out from under it.
test("an existing lock with unreadable metadata fails closed and is never removed", async () => {
  for (const [name, contents] of [["empty", ""], ["partial", '{"pid":123'], ["garbage", "not json"]] as const) {
    const lockPath = tokenLockPath(`tok-UNREADABLE-${name}`);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, contents, "utf8");
    const token = `tok-UNREADABLE-${name}`;

    let failure: unknown = null;
    try {
      await channelWith({ a: { token } }).createConsumerLock().acquire(meta());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("unreadable");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(contents);
    rmSync(lockPath, { force: true });
  }
});

test("a readable lock left by a dead pid is still reclaimed", async () => {
  const token = "tok-STALE-RECLAIM";
  const lockPath = tokenLockPath(token);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify({
    pid: 999_999,
    mode: "daemon",
    startedAt: "2026-08-30T00:00:00.000Z",
    configPath: path.join(fakeHome, "config.json"),
    statePath: path.join(fakeHome, "state.json"),
    lockId: "left-by-a-dead-process",
  }, null, 2)}\n`, "utf8");

  const lock = channelWith({ a: { token } }).createConsumerLock();
  await lock.acquire(meta());
  expect(existsSync(lockPath)).toBe(true);
  await lock.release();
  expect(existsSync(lockPath)).toBe(false);
});
