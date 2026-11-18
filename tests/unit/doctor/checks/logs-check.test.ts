import { join, sep } from "node:path";

import { expect, test } from "bun:test";

import { checkLogs } from "../../../../src/doctor/checks/logs-check";

const MB = 1024 * 1024;

interface ProbeOptions {
  /** runtime dirs that exist. */
  directories: string[];
  /** path -> on-disk size in bytes. Presence implies the file exists. */
  sizes?: Record<string, number>;
  /** files that throw when stat'd (e.g. unreadable / vanished). */
  unreadable?: string[];
}

function createLogsProbe(options: ProbeOptions): {
  stat: (path: string) => Promise<{ isDirectory: () => boolean; size: number }>;
  readdir: (path: string) => Promise<string[]>;
} {
  const directories = new Set(options.directories);
  const sizes = options.sizes ?? {};
  const unreadable = new Set(options.unreadable ?? []);

  return {
    async stat(path: string) {
      if (directories.has(path)) {
        return { isDirectory: () => true, size: 0 };
      }
      if (unreadable.has(path)) {
        throw createErrno("EACCES", path);
      }
      const size = sizes[path];
      if (size === undefined) {
        throw createErrno("ENOENT", path);
      }
      return { isDirectory: () => false, size };
    },
    async readdir(path: string) {
      if (!directories.has(path)) {
        throw createErrno("ENOENT", path);
      }
      // Return entries that live directly under this dir (base names only).
      // `sep`, not a literal "/": `join` emits the platform separator, so a
      // hardcoded "/" matches nothing on Windows and every dir reads empty.
      const prefix = `${path}${sep}`;
      const names = new Set<string>();
      for (const candidate of [...Object.keys(sizes), ...(options.unreadable ?? [])]) {
        if (candidate.startsWith(prefix)) {
          names.add(candidate.slice(prefix.length));
        }
      }
      return [...names];
    },
  };
}

function createErrno(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function runtimeDirOf(home: string): string {
  return join(home, ".xacpx", "runtime");
}

test("logs check skips when the runtime dir does not exist", async () => {
  const home = "/home/user";
  const probe = createLogsProbe({ directories: [] });

  const result = await checkLogs({ home, probe });

  expect(result.id).toBe("logs");
  expect(result.severity).toBe("skip");
  expect(result.summary.toLowerCase()).toContain("no runtime logs");
});

test("logs check passes when all files are under threshold and reports the total", async () => {
  const home = "/home/user";
  const runtimeDir = runtimeDirOf(home);
  const probe = createLogsProbe({
    directories: [runtimeDir],
    sizes: {
      [join(runtimeDir, "app.log")]: 1 * MB,
      [join(runtimeDir, "stdout.log")]: 2 * MB,
      [join(runtimeDir, "stderr.log")]: 3 * MB,
    },
  });

  const result = await checkLogs({ home, probe });

  expect(result.severity).toBe("pass");
  expect(result.summary).toContain("6");
  expect(result.details?.join("\n") ?? "").toContain("app.log");
});

test("logs check warns when a single log file exceeds the single-file threshold", async () => {
  const home = "/home/user";
  const runtimeDir = runtimeDirOf(home);
  const probe = createLogsProbe({
    directories: [runtimeDir],
    sizes: {
      [join(runtimeDir, "app.log")]: 60 * MB,
      [join(runtimeDir, "stdout.log")]: 1 * MB,
    },
  });

  const result = await checkLogs({
    home,
    probe,
    singleFileWarnBytes: 50 * MB,
    totalWarnBytes: 200 * MB,
  });

  expect(result.severity).toBe("warn");
  expect(result.suggestions?.join("\n") ?? "").toContain("rotation");
});

test("logs check warns when the total exceeds the total threshold even with no single file over", async () => {
  const home = "/home/user";
  const runtimeDir = runtimeDirOf(home);
  const probe = createLogsProbe({
    directories: [runtimeDir],
    sizes: {
      [join(runtimeDir, "app.log")]: 40 * MB,
      [join(runtimeDir, "stdout.log")]: 40 * MB,
      [join(runtimeDir, "stderr.log")]: 40 * MB,
    },
  });

  const result = await checkLogs({
    home,
    probe,
    singleFileWarnBytes: 50 * MB,
    totalWarnBytes: 100 * MB,
  });

  expect(result.severity).toBe("warn");
});

test("logs check counts rotation siblings toward the total", async () => {
  const home = "/home/user";
  const runtimeDir = runtimeDirOf(home);
  const probe = createLogsProbe({
    directories: [runtimeDir],
    sizes: {
      [join(runtimeDir, "app.log")]: 10 * MB,
      [join(runtimeDir, "app.log.1")]: 10 * MB,
      [join(runtimeDir, "app.log.2")]: 10 * MB,
    },
  });

  const result = await checkLogs({
    home,
    probe,
    singleFileWarnBytes: 50 * MB,
    totalWarnBytes: 25 * MB,
  });

  // 30 MB total > 25 MB threshold thanks to the two rotation siblings.
  expect(result.severity).toBe("warn");
  const details = result.details?.join("\n") ?? "";
  expect(details).toContain("app.log.1");
  expect(details).toContain("app.log.2");
});

test("logs check tolerates an unreadable individual file and still sums the rest", async () => {
  const home = "/home/user";
  const runtimeDir = runtimeDirOf(home);
  const probe = createLogsProbe({
    directories: [runtimeDir],
    sizes: {
      [join(runtimeDir, "app.log")]: 5 * MB,
      [join(runtimeDir, "stderr.log")]: 5 * MB,
    },
    unreadable: [join(runtimeDir, "stdout.log")],
  });

  const result = await checkLogs({ home, probe });

  expect(result.severity).toBe("pass");
  // 10 MB summed from the two readable files; the unreadable one is skipped.
  expect(result.summary).toContain("10");
});

test("logs check skips with a could-not-read summary (not 'no logs') when the runtime dir is unreadable", async () => {
  const home = "/home/user";
  const runtimeDir = runtimeDirOf(home);
  const probe = createLogsProbe({
    directories: [],
    // The runtime dir itself stats with EACCES — present but unreadable.
    unreadable: [runtimeDir],
  });

  const result = await checkLogs({ home, probe });

  expect(result.severity).toBe("skip");
  expect(result.summary).toContain("could not be read");
  expect(result.summary.toLowerCase()).not.toContain("no runtime logs");
  expect(result.details?.join("\n") ?? "").toContain("EACCES");
});
