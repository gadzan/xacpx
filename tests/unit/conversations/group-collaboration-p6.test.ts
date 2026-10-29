import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BotService } from "../../../src/bots/bot-service";
import { groupWorkspaceMode } from "../../../src/conversations/conversation-types";
import {
  canonicalizePhysicalPath,
  canExecuteAlongside,
  physicalResourceKey,
  ResourceReservationTable,
} from "../../../src/conversations/conversation-resource-admission";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import { isEffectConcurrencySafe } from "../../../src/conversations/conversation-filesystem-policy";

const NOW = "2026-10-05T00:00:00.000Z";

class MemoryStateStore {
  async save(_state: AppState): Promise<void> {}
}

function createService(state = createEmptyState()) {
  let n = 0;
  const service = new BotService(
    { agents: { codex: { driver: "codex" } }, workspaces: { backend: { cwd: "/tmp/backend" } } },
    state,
    new MemoryStateStore() as never,
    { now: () => new Date(NOW), createId: () => `bot_${(n += 1)}` },
  );
  return { service, state };
}

// ---------------------------------------------------------------- default
test("P6: a new Group without workspaceMode defaults to per-member; explicit shared is kept", async () => {
  const { service } = createService();
  const a = await service.createBot({ name: "A", agent: "codex", workspace: "backend" });
  const b = await service.createBot({ name: "B", agent: "codex", workspace: "backend" });
  const def = await service.createGroup({ title: "Default", botIds: [a.id, b.id] });
  expect(def.workspaceMode).toBe("per-member");
  expect(groupWorkspaceMode(def)).toBe("per-member");
  const shared = await service.createGroup({ title: "Shared", botIds: [a.id, b.id], workspaceMode: "shared" });
  expect(shared.workspaceMode).toBe("shared");
  // A new per-member Group takes no Topic target, unlike a shared Group.
  expect(service.getGroup(def.id).workspaceMode).toBe("per-member");
});

test("P6: stored Groups without workspaceMode are NOT migrated by the new default", async () => {
  const state = createEmptyState();
  // A legacy row, exactly as persisted before P6: no workspaceMode field.
  state.conversations.legacy_group = { id: "legacy_group", kind: "group", title: "Legacy",
    botIds: ["bot_a", "bot_b"], createdAt: NOW, updatedAt: NOW };
  const { service } = createService(state);
  const stored = service.getGroup("legacy_group");
  expect(stored.workspaceMode).toBeUndefined();
  // Absent still reads as shared (groupWorkspaceMode), and no createGroup
  // call — hence no migration — was involved in reading it.
  expect(groupWorkspaceMode(stored)).toBe("shared");
});

// ---------------------------------------------------------------- physical admission
test("P6: a symlink alias of one directory canonicalizes to the same physical key", () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-p6-real-"));
  const link = join(tmpdir(), `xacpx-p6-link-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(dir, link, "dir");
    const real = canonicalizePhysicalPath(dir);
    const aliased = canonicalizePhysicalPath(link);
    expect(real).not.toBe("");
    expect(aliased).toBe(real);
    expect(physicalResourceKey({ cwd: aliased, isolation: "shared" }))
      .toBe(physicalResourceKey({ cwd: real, isolation: "shared" }));
  } finally {
    rmSync(link, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P6: two writers on the same normalized physical directory conflict; different directories do not", () => {
  const dir = mkdtempSync(join(tmpdir(), "xacpx-p6-a-"));
  const other = mkdtempSync(join(tmpdir(), "xacpx-p6-b-"));
  const link = join(tmpdir(), `xacpx-p6-link2-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(dir, link, "dir");
    const writer = { identity: { cwd: canonicalizePhysicalPath(dir), isolation: "shared" as const }, reader: false };
    const writerViaAlias = { identity: { cwd: canonicalizePhysicalPath(link), isolation: "shared" as const }, reader: false };
    const writerElsewhere = { identity: { cwd: canonicalizePhysicalPath(other), isolation: "shared" as const }, reader: false };
    expect(canExecuteAlongside(writerViaAlias, writer)).toBe(false);
    expect(canExecuteAlongside(writerElsewhere, writer)).toBe(true);
    // The reservation table is the dispatcher's cross-Run fence on the same key.
    const table = new ResourceReservationTable();
    table.add({ key: physicalResourceKey(writer.identity), runId: "run_1", memberTurnId: "turn_1",
      dispatchId: "dispatch_1", identity: writer.identity, reader: false });
    expect(table.conflicts(writerViaAlias.identity, false)).toBeDefined();
    expect(table.conflicts(writerElsewhere.identity, false)).toBeUndefined();
  } finally {
    rmSync(link, { force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("P6: proven read-only turns on the same directory may overlap; unproven turns may not", () => {
  const reader = { identity: { cwd: "/tmp/same-dir", isolation: "shared" as const }, reader: true };
  const writer = { identity: { cwd: "/tmp/same-dir", isolation: "shared" as const }, reader: false };
  expect(canExecuteAlongside(reader, reader)).toBe(true);
  expect(canExecuteAlongside(reader, writer)).toBe(false);
  expect(canExecuteAlongside(writer, reader)).toBe(false);
  // The filesystem-policy seam agrees: only read-only + declared-enforced
  // is concurrency-safe; a bare read-only claim without proof serializes.
  expect(isEffectConcurrencySafe("read-only", "shared", 1, "declared-enforced")).toBe(true);
  expect(isEffectConcurrencySafe("read-only", "shared", 1, undefined)).toBe(false);
  expect(isEffectConcurrencySafe("unknown", "shared", 1, undefined)).toBe(false);
  expect(isEffectConcurrencySafe("mutating", "shared", 1, undefined)).toBe(false);
});
