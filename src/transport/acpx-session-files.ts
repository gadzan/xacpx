import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DeleteAcpxSessionFilesOptions {
  acpxRecordId: string;
  /** Override for the acpx sessions dir (tests). Defaults to `<home>/.acpx/sessions`. */
  sessionsDir?: string;
}

/** Best-effort delete of a single acpx session's on-disk files: the record json and
 *  its event-stream artifacts. Mirrors acpx's per-record file layout
 *  (`<encodeURIComponent(acpxRecordId)>.json` + `<safeId>.stream.*`). Idempotent —
 *  missing files are ignored.
 *
 *  Deleting the `.json` record leaves a dangling index.json entry, but acpx rebuilds
 *  its index from the surviving `.json` files on its next `sessions` operation, so we
 *  do not rewrite the index ourselves.
 *
 *  The `.stream.*` unlinks are NOT guaranteed to take effect: acpx keeps a warm
 *  queue-owner alive via `--ttl`, so `sessions close` returning does not mean the
 *  backing process has released those files. On POSIX the unlink drops the directory
 *  entry and the owner keeps writing to the now-unlinked inode until `--ttl` expires
 *  (no visible orphan). On Windows the unlink of a still-open file rejects and is
 *  swallowed below, leaving the `.stream.*` file as a true orphan. acpx does NOT
 *  auto-reclaim such an orphan — index rebuild scans only `.json` files, and
 *  `sessions prune` skips stream files unless run with `--include-history` — so a
 *  Windows orphan persists until a manual prune. This is an accepted residual risk:
 *  the queue-owner is a third-party process we cannot reap or await from here. */
export async function deleteAcpxSessionFiles(options: DeleteAcpxSessionFilesOptions): Promise<void> {
  const dir = options.sessionsDir ?? join(homedir(), ".acpx", "sessions");
  const safeId = encodeURIComponent(options.acpxRecordId);

  await unlink(join(dir, `${safeId}.json`)).catch(() => undefined);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir gone → nothing more to remove
  }
  const streamFiles = entries.filter((name) => name.startsWith(`${safeId}.stream.`));
  for (const name of streamFiles) {
    await unlink(join(dir, name)).catch(() => undefined);
  }
}
