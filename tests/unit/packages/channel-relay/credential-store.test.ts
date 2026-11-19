import { expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialStore } from "../../../../packages/channel-relay/src/credential-store";

test("load returns null before save; save/load/clear roundtrip with 0600 file", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "relay-cred-")), "nested", "credential.json");
  const store = new CredentialStore(filePath);
  expect(store.load()).toBeNull();
  const credential = { instanceId: "i-1", credential: "secret", relayUrl: "ws://h:8788" };
  store.save(credential);
  expect(store.load()).toEqual(credential);
  store.clear();
  expect(store.load()).toBeNull();
  store.clear(); // idempotent
});

test("load tolerates corrupt file content", () => {
  const filePath = join(mkdtempSync(join(tmpdir(), "relay-cred-")), "credential.json");
  writeFileSync(filePath, "{corrupt", "utf8");
  expect(new CredentialStore(filePath).load()).toBeNull();
});

test("writes the credential file with 0600 perms", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-"));
  const path = join(dir, "credential.json");
  new CredentialStore(path).save({ instanceId: "i", credential: "c", relayUrl: "ws://x" });
  // Windows cannot clear the read bits (chmod only toggles the write bit), so
  // the mode check is POSIX-only; the store still chmods on every platform.
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(new CredentialStore(path).load()?.instanceId).toBe("i");
});

test("re-tightens perms when overwriting a loosened file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-"));
  const path = join(dir, "credential.json");
  writeFileSync(path, "{}", { mode: 0o644 });
  const store = new CredentialStore(path);
  store.save({ instanceId: "i", credential: "c", relayUrl: "ws://x" });
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(store.load()?.instanceId).toBe("i");
});
