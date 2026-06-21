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
 *  missing files are ignored. acpx tolerates the now-stale index.json entry and
 *  self-heals it on its next `sessions` operation, so we do not rewrite the index. */
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
  const streamFiles = entries.filter(
    (name) =>
      name === `${safeId}.stream.ndjson` ||
      name === `${safeId}.stream.lock` ||
      name.startsWith(`${safeId}.stream.`),
  );
  for (const name of streamFiles) {
    await unlink(join(dir, name)).catch(() => undefined);
  }
}
