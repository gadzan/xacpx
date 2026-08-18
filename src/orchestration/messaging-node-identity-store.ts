import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { withPrivateFileLock } from "../util/private-file.js";
import type { MessagingNodeIdentity } from "./agent-messaging-types";

const NODE_ID_PATTERN =
  /^node_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MessagingNodeIdentityStore {
  constructor(
    private readonly path: string,
    private readonly createId: () => string = randomUUID,
  ) {}

  async loadOrCreate(): Promise<MessagingNodeIdentity> {
    return await withPrivateFileLock(this.path, async (writeLocked) => {
      let raw: string;
      try {
        raw = await readFile(this.path, "utf8");
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }

        const identity = { nodeId: "node_" + this.createId() };
        await writeLocked(
          JSON.stringify({ version: 1, ...identity }, null, 2) + "\n",
        );
        return identity;
      }

      return parseIdentity(raw, this.path);
    });
  }
}

function parseIdentity(raw: string, path: string): MessagingNodeIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidIdentityError(path);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidIdentityError(path);
  }

  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.nodeId !== "string" ||
    !NODE_ID_PATTERN.test(record.nodeId)
  ) {
    throw invalidIdentityError(path);
  }

  return { nodeId: record.nodeId };
}

function invalidIdentityError(path: string): Error {
  return new Error("invalid Agent Messaging node identity at " + path);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
