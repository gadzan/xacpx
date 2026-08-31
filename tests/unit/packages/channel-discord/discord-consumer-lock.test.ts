import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

test("core-injected lockFilePath anchors the per-token files beside it", async () => {
  const dir = mkdtempSync(path.join(fakeHome, "injected-"));
  const injected = { lockFilePath: path.join(dir, "discord-consumer.lock.json") };
  const chA = channelWith({ a: { token: "tok-INJ-A" } });
  const chB = channelWith({ a: { token: "tok-INJ-B" } });

  const lockA = chA.createConsumerLock(injected);
  const lockB = chB.createConsumerLock(injected);

  // Distinct tokens under the SAME injected path must NOT share one file.
  await lockA.acquire(meta());
  await lockB.acquire(meta());

  const files = readdirSync(dir).filter((f) => f.startsWith("discord-consumer-") && f.endsWith(".lock.json"));
  expect(files.length).toBe(2);

  await acquireExpectConflict(channelWith({ a: { token: "tok-INJ-A" } }).createConsumerLock(injected));

  await lockA.release();
  await lockB.release();
});
