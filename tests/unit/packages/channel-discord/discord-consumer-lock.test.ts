import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscordChannel } from "../../../../packages/channel-discord/src/channel";
import type { ConsumerLockMetadata } from "../../../../src/channels/types";

// Review round 2 #4: the consumer lock must be scoped by the token set, not
// channel-wide. Same enabled token(s) -> same lock file -> second acquire is
// rejected; different tokens -> distinct lock files -> both coexist. The lock
// file lives under coreHomeDir(homedir()), so the test points HOME/USERPROFILE
// at a temp dir to keep the real ~/.xacpx untouched.

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

test("same token set contends on one lock; different tokens coexist", async () => {
  const chA1 = new DiscordChannel({ token: "tok-A" }, {});
  const chA2 = new DiscordChannel({ token: "tok-A" }, {});
  const chB = new DiscordChannel({ token: "tok-B" }, {});

  const lockA1 = chA1.createConsumerLock();
  const lockA2 = chA2.createConsumerLock();
  const lockB = chB.createConsumerLock();

  await lockA1.acquire(meta());

  // Second process with the SAME token must be rejected (F6).
  let conflict: unknown = null;
  try {
    await lockA2.acquire(meta());
  } catch (error) {
    conflict = error;
  }
  // Dual-package hazard: from inside packages/*, `xacpx/plugin-api` resolves to
  // the bundled dist entry, so the thrown class is not identity-equal to the
  // source import. Assert by name + message instead of instanceof.
  expect(conflict).toBeInstanceOf(Error);
  expect((conflict as Error).name === "ActiveConsumerLockError" || (conflict as Error).constructor.name === "ActiveConsumerLockError").toBe(true);
  expect((conflict as Error).message).toContain("lock held");

  // Different token -> distinct fingerprinted lock file -> coexists.
  await lockB.acquire(meta());

  await lockB.release();
  await lockA1.release();

  // After release the same-token lock can be acquired again.
  await lockA2.acquire(meta());
  await lockA2.release();
});

test("multi-account token sets are part of the lock scope", async () => {
  const chAB = new DiscordChannel({ accounts: { a: { token: "tok-A" }, b: { token: "tok-B" } } }, {});
  const chA = new DiscordChannel({ accounts: { a: { token: "tok-A" } } }, {});

  const lockAB = chAB.createConsumerLock();
  const lockA = chA.createConsumerLock();

  await lockAB.acquire(meta());
  // Different enabled-token set -> different lock file -> no conflict.
  await lockA.acquire(meta());
  await lockA.release();
  await lockAB.release();
});
