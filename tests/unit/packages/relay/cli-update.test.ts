// tests/unit/packages/relay/cli-update.test.ts
import { expect, test } from "bun:test";
import { handleRelayUpdate } from "../../../../packages/relay/src/cli-update";

function makeIo() {
  const lines: string[] = [];
  return { lines, print: (l: string) => lines.push(l) };
}

test("--check reports current vs latest and does NOT install", async () => {
  const io = makeIo();
  let installed = false;
  const code = await handleRelayUpdate(["--check"], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => "0.7.0",
    updateSelf: async () => { installed = true; },
    print: io.print,
  });
  expect(code).toBe(0);
  expect(installed).toBe(false);
  expect(io.lines.join("\n")).toContain("0.7.0");
});

test("update installs when a newer version exists", async () => {
  const io = makeIo();
  let installed = false;
  const code = await handleRelayUpdate([], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => "0.7.0",
    updateSelf: async () => { installed = true; },
    print: io.print,
  });
  expect(code).toBe(0);
  expect(installed).toBe(true);
  expect(io.lines.join("\n")).toContain("updated to v0.7.0");
});

test("update is a no-op when already current", async () => {
  const io = makeIo();
  let installed = false;
  const code = await handleRelayUpdate([], {
    readCurrentVersion: () => "0.7.0",
    getLatestVersion: async () => "0.7.0",
    updateSelf: async () => { installed = true; },
    print: io.print,
  });
  expect(code).toBe(0);
  expect(installed).toBe(false);
  expect(io.lines.join("\n")).toContain("already up to date");
});

test("update exits 1 when the latest version is unknown", async () => {
  const io = makeIo();
  const code = await handleRelayUpdate([], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => null,
    updateSelf: async () => { throw new Error("should not run"); },
    print: io.print,
  });
  expect(code).toBe(1);
});

test("--check exits 0 even when the latest version is unknown", async () => {
  const io = makeIo();
  const code = await handleRelayUpdate(["--check"], {
    readCurrentVersion: () => "0.6.0",
    getLatestVersion: async () => null,
    updateSelf: async () => {},
    print: io.print,
  });
  expect(code).toBe(0);
});
