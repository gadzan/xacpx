import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acpxRecordFileNameMatches,
  parseAcpxSessionRecord,
  scanAcpxSessionRecords,
} from "../../../src/transport/acpx-record-discovery";

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "acpx.session.v1",
    acpx_record_id: "rec-1",
    acp_session_id: "acp-1",
    agent_command: "codex",
    cwd: "C:\\ws",
    created_at: "2026-10-01T00:00:00Z",
    last_used_at: "2026-10-02T00:00:00Z",
    last_seq: 0,
    updated_at: "2026-10-02T00:00:00Z",
    messages: [],
    ...overrides,
  };
}

describe("parseAcpxSessionRecord", () => {
  test("accepts a canonical record whose filename matches the encoded id", () => {
    const parsed = parseAcpxSessionRecord("rec-1.json", validRecord());
    expect(parsed).toMatchObject({
      acpxRecordId: "rec-1",
      acpSessionId: "acp-1",
      agentCommand: "codex",
      cwd: "C:\\ws",
      closed: false,
    });
  });

  test("encodes ids with reserved characters into the filename", () => {
    const payload = validRecord({ acpx_record_id: "a b/c" });
    expect(parseAcpxSessionRecord(`${encodeURIComponent("a b/c")}.json`, payload)).not.toBeNull();
    expect(acpxRecordFileNameMatches(`${encodeURIComponent("a b/c")}.json`, "a b/c")).toBe(true);
    expect(acpxRecordFileNameMatches("a b/c.json", "a b/c")).toBe(false);
  });

  test("rejects a record whose filename does not match its id", () => {
    expect(parseAcpxSessionRecord("mismatched.json", validRecord())).toBeNull();
  });

  test("rejects records with missing core fields, bad last_seq, or non-array messages", () => {
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ acp_session_id: undefined }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ agent_command: "" }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ last_seq: -1 }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ last_seq: 1.5 }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ messages: {} }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ updated_at: undefined }))).toBeNull();
  });

  test("rejects wrong schema and mistyped optional fields", () => {
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ schema: "acpx.session.v2" }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ name: 42 }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ closed: "yes" }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", validRecord({ agent_session_id: 7 }))).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", null)).toBeNull();
    expect(parseAcpxSessionRecord("rec-1.json", [validRecord()])).toBeNull();
  });

  test("keeps optional closed state and provider session id when valid", () => {
    const parsed = parseAcpxSessionRecord("rec-1.json", validRecord({
      closed: true,
      closed_at: "2026-10-03T00:00:00Z",
      agent_session_id: "rollout-9",
    }));
    expect(parsed).toMatchObject({ closed: true, closedAt: "2026-10-03T00:00:00Z", agentSessionId: "rollout-9" });
  });
});

describe("scanAcpxSessionRecords", () => {
  test("scans valid records, skips the legacy index, invalid shapes, and corrupt files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpx-scan-"));
    const diagnostics: string[] = [];
    writeFileSync(join(dir, "rec-1.json"), JSON.stringify(validRecord()));
    writeFileSync(join(dir, "rec-2.json"), JSON.stringify(validRecord({ acpx_record_id: "rec-2", acp_session_id: "acp-2", name: "other" })));
    writeFileSync(join(dir, "index.json"), JSON.stringify({ entries: [] }));
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeFileSync(join(dir, "wrongname.json"), JSON.stringify(validRecord({ acpx_record_id: "rec-3" })));
    writeFileSync(join(dir, "notes.txt"), "ignored");

    const records = await scanAcpxSessionRecords({
      sessionsDir: dir,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(records.map((r) => r.acpxRecordId)).toEqual(["rec-1", "rec-2"]);
    // Diagnostics fire per skipped candidate in I/O-completion order; the set is
    // the contract, not the sequence.
    expect(diagnostics.length).toBe(2);
    expect(diagnostics.some((d) => d.includes("broken.json"))).toBe(true);
    expect(diagnostics.some((d) => d.includes("wrongname.json"))).toBe(true);
  });

  test("skips oversized records with a diagnostic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpx-scan-"));
    const diagnostics: string[] = [];
    writeFileSync(join(dir, "rec-1.json"), JSON.stringify(validRecord()));

    const records = await scanAcpxSessionRecords({
      sessionsDir: dir,
      maxFileBytes: 8,
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(records).toEqual([]);
    expect(diagnostics).toEqual([expect.stringContaining("oversized")]);
  });

  test("scans every canonical record, including the 513th", async () => {
    // acpx's own discovery has no file-count cap; truncating here would make
    // sessions past the cut unreachable for history and agent-command lookup.
    const dir = mkdtempSync(join(tmpdir(), "acpx-scan-"));
    const ids = Array.from({ length: 600 }, (_, i) => `rec-${String(i + 1).padStart(4, "0")}`);
    for (const id of ids) {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(validRecord({ acpx_record_id: id, acp_session_id: `acp-${id}` })));
    }

    const records = await scanAcpxSessionRecords({ sessionsDir: dir });

    expect(records).toHaveLength(ids.length);
    expect(records.map((r) => r.acpxRecordId)).toEqual(ids);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing directory yields no records without diagnostics; other readdir failures report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acpx-scan-"));
    const missingDiagnostics: string[] = [];
    expect(await scanAcpxSessionRecords({
      sessionsDir: join(dir, "nope"),
      onDiagnostic: (d) => missingDiagnostics.push(d),
    })).toEqual([]);
    expect(missingDiagnostics).toEqual([]);

    writeFileSync(join(dir, "afile"), "x");
    const failedDiagnostics: string[] = [];
    expect(await scanAcpxSessionRecords({
      sessionsDir: join(dir, "afile"),
      onDiagnostic: (d) => failedDiagnostics.push(d),
    })).toEqual([]);
    expect(failedDiagnostics).toEqual([expect.stringContaining("cannot read sessions directory")]);
  });
});
