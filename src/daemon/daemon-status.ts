import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import writeFileAtomic from "write-file-atomic";

export interface DaemonStatus {
  pid: number;
  started_at: string;
  heartbeat_at: string;
  config_path: string;
  state_path: string;
  app_log: string;
  stdout_log: string;
  stderr_log: string;
}

export class DaemonStatusStore {
  constructor(private readonly path: string) {}

  async load(): Promise<DaemonStatus | null> {
    try {
      const content = await readFile(this.path, "utf8");
      if (content.trim() === "") {
        return null;
      }
      return decodeDaemonStatus(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  async save(status: DaemonStatus): Promise<void> {
    // status.json lives in the runtime dir, which must stay user-private
    // (0700) because it also holds the orchestration socket. The mode only
    // applies when this mkdir actually creates the dir; daemon startup
    // additionally chmod-repairs pre-existing dirs (private-runtime-dir.ts).
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.path, JSON.stringify(status, null, 2), { encoding: "utf8" });
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

function decodeDaemonStatus(value: unknown): DaemonStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (!Number.isSafeInteger(status.pid) || Number(status.pid) <= 0
    || !validIsoDate(status.started_at)
    || !validIsoDate(status.heartbeat_at)
    || !nonempty(status.config_path)
    || !nonempty(status.state_path)
    || !nonempty(status.app_log)
    || !nonempty(status.stdout_log)
    || !nonempty(status.stderr_log)) return null;
  return status as unknown as DaemonStatus;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validIsoDate(value: unknown): value is string {
  return nonempty(value) && Number.isFinite(Date.parse(value));
}
