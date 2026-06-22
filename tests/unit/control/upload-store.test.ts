import { mkdtemp, readFile, stat, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { UploadStore } from "../../../src/control/upload-store";

async function freshRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "upload-store-test-"));
}

describe("UploadStore", () => {
  it("writes base64 bytes to a sandboxed file and returns an absolute path + size", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    const bytes = Buffer.from("hello world");
    const res = await store.save("note.txt", bytes.toString("base64"), "text/plain");

    expect(res.path.startsWith(root)).toBe(true);
    expect(res.filename).toBe("note.txt");
    expect(res.size).toBe(bytes.byteLength);
    expect(res.id).toMatch(/.+/);
    expect((await readFile(res.path)).equals(bytes)).toBe(true);
  });

  it("sanitizes path-traversal filenames to a basename", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    const res = await store.save("../../etc/passwd", Buffer.from("x").toString("base64"), "text/plain");

    expect(res.filename).toBe("passwd");
    expect(res.path.startsWith(root)).toBe(true);
    expect(res.path.includes("..")).toBe(false);
  });

  it("rejects files over the byte cap", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root, maxBytes: 8 });
    await expect(store.save("big.bin", Buffer.alloc(9).toString("base64"), "application/octet-stream")).rejects.toThrow(
      "file-too-large",
    );
  });

  it("rejects an oversized base64 string before decoding it", async () => {
    const root = await freshRoot();
    const maxBytes = 8;
    const store = new UploadStore({ rootDir: root, maxBytes });
    // A base64 string longer than the pre-decode threshold is rejected without ever
    // allocating the decoded buffer (the string itself stays tiny relative to a 10MB+
    // payload, but exceeds the cheap length bound).
    const threshold = Math.ceil((maxBytes * 4) / 3) + 4;
    const oversized = "A".repeat(threshold + 1);
    await expect(store.save("big.bin", oversized, "application/octet-stream")).rejects.toThrow("file-too-large");
  });

  it("exposes the configured rootDir via root", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    expect(store.root).toBe(root);
  });

  it("rejects empty content", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root });
    await expect(store.save("empty.txt", "", "text/plain")).rejects.toThrow("empty-file");
  });

  it("cleanup() removes upload dirs older than the TTL and keeps fresh ones", async () => {
    const root = await freshRoot();
    const store = new UploadStore({ rootDir: root, ttlMs: 1000 });
    const stale = await store.save("old.txt", Buffer.from("old").toString("base64"), "text/plain");
    const fresh = await store.save("new.txt", Buffer.from("new").toString("base64"), "text/plain");

    // Backdate the stale entry's directory mtime well beyond the TTL.
    const staleDir = join(stale.path, "..");
    const past = new Date(Date.now() - 60_000);
    await utimes(staleDir, past, past);

    const removed = await store.cleanup();
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(stat(stale.path)).rejects.toThrow();
    expect((await stat(fresh.path)).isFile()).toBe(true);
    expect((await readdir(root)).length).toBe(1);
  });
});
