import { test, expect } from "bun:test";
import { ControlService } from "../../../src/control/control-service";

function make(enabled: boolean, calls: string[]) {
  // Point one real workspace at a temp dir so WorkspaceFs.resolve() succeeds; but we
  // assert the GATE, so a disabled service must never reach WorkspaceFs. We spy by
  // pointing the workspace list at a non-existent dir: if the gate lets the call
  // through it fails with a WorkspaceFs error (not "files-write-disabled").
  const deps: any = {
    workspaces: { list: () => [{ name: "ws", cwd: "/nonexistent-xacpx-test" }] },
    filesWriteEnabled: () => enabled,
    events: { emit() {}, subscribe() { return () => {}; } },
  };
  return new ControlService(deps);
}

test("fsCreate is rejected with files-write-disabled when the gate is off", async () => {
  const svc = make(false, []);
  await expect(svc.fsCreate("ws", "x.txt", "file")).rejects.toThrow("files-write-disabled");
});
test("fsDelete/fsRename/fsCopy are gated too", async () => {
  const svc = make(false, []);
  await expect(svc.fsDelete("ws", "x.txt")).rejects.toThrow("files-write-disabled");
  await expect(svc.fsRename("ws", "x.txt", "y.txt")).rejects.toThrow("files-write-disabled");
  await expect(svc.fsCopy("ws", "x.txt")).rejects.toThrow("files-write-disabled");
});
test("fsDownload is NOT gated (reaches WorkspaceFs, fails on missing workspace root)", async () => {
  const svc = make(false, []);
  // gate off, but download must still attempt the read → WorkspaceFs error, NOT the gate error
  await expect(svc.fsDownload("ws", "x.txt")).rejects.not.toThrow("files-write-disabled");
});
