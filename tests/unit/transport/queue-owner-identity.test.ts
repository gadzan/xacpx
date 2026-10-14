import { describe, expect, test } from "bun:test";

import {
  parseQueueOwnerLock,
  posixLstartProbeEnv,
  posixLstartToUtc,
  proveQueueOwnerLock,
  sameQueueOwnerLock,
  type QueueOwnerLock,
} from "../../../src/transport/queue-owner-identity";

const LSTART_UTC = "2026-10-13T09:15:30.000Z";

function lock(overrides: Partial<QueueOwnerLock> = {}): QueueOwnerLock {
  return {
    pid: 4242,
    sessionId: "rec-1",
    ownerGeneration: 7,
    processIdentity: { kind: "posix-lstart", value: LSTART_UTC },
    ...overrides,
  };
}

const psSeam = (output: string | null) => async () => output;

describe("parseQueueOwnerLock", () => {
  test("parses a 0.19 lease with birth identity", () => {
    expect(parseQueueOwnerLock({
      pid: 42,
      sessionId: "rec-1",
      ownerGeneration: 3,
      processIdentity: { kind: "posix-lstart", value: LSTART_UTC },
    })).toEqual(lock({ pid: 42, ownerGeneration: 3 }));
  });

  test("parses a 0.16 lease without birth identity", () => {
    expect(parseQueueOwnerLock({ pid: 42, sessionId: "rec-1", ownerGeneration: 3 })).toEqual({
      pid: 42,
      sessionId: "rec-1",
      ownerGeneration: 3,
    });
  });

  test("keeps retirement: null distinct from an absent field", () => {
    // Upstream reads the bare key: absent = not retiring, null = incomplete
    // retirement (every lease refresh is refused), object = receipt.
    expect(parseQueueOwnerLock({ pid: 42, sessionId: "rec-1", retirement: null })).toEqual({
      pid: 42,
      sessionId: "rec-1",
      retirement: null,
    });
    expect(parseQueueOwnerLock({ pid: 42, sessionId: "rec-1", retirement: { state: "pending" } })).toEqual({
      pid: 42,
      sessionId: "rec-1",
      retirement: { state: "pending" },
    });
    expect(Object.hasOwn(parseQueueOwnerLock({ pid: 42, sessionId: "rec-1" })!, "retirement")).toBe(false);
  });

  test("rejects malformed leases", () => {
    expect(parseQueueOwnerLock(null)).toBeNull();
    expect(parseQueueOwnerLock({ pid: 0, sessionId: "rec-1" })).toBeNull();
    expect(parseQueueOwnerLock({ pid: 1.5, sessionId: "rec-1" })).toBeNull();
    expect(parseQueueOwnerLock({ pid: 42 })).toBeNull();
    expect(parseQueueOwnerLock({ pid: 42, sessionId: "" })).toBeNull();
    expect(parseQueueOwnerLock({ pid: 42, sessionId: "rec-1", processIdentity: 5 })).toBeNull();
    expect(parseQueueOwnerLock({ pid: 42, sessionId: "rec-1", processIdentity: { value: LSTART_UTC } })).toBeNull();
  });
});

describe("sameQueueOwnerLock", () => {
  test("ignores heartbeat-only differences", () => {
    expect(sameQueueOwnerLock(lock(), lock())).toBe(true);
    expect(sameQueueOwnerLock(lock(), lock({ ownerGeneration: 8 }))).toBe(false);
    expect(sameQueueOwnerLock(lock(), lock({ pid: 4243 }))).toBe(false);
  });

  test("a retirement receipt appearing between reads is a difference", () => {
    // Lifecycle state, not a heartbeat: an unlink decision must not treat a
    // lease that gained a receipt as the state it proved earlier.
    const receipt = { state: "pending" };
    expect(sameQueueOwnerLock(lock({ retirement: receipt }), lock({ retirement: receipt }))).toBe(true);
    expect(sameQueueOwnerLock(lock(), lock({ retirement: receipt }))).toBe(false);
    expect(sameQueueOwnerLock(lock({ retirement: receipt }), lock())).toBe(false);
    expect(sameQueueOwnerLock(lock({ retirement: { state: "pending" } }), lock({ retirement: { state: "draining" } }))).toBe(false);
  });

  test("absent, null, and a receipt are three different lease states", () => {
    // acpx refuses every lease refresh for `retirement: null` (its
    // incomplete-retirement state), so null is not "same as absent".
    expect(sameQueueOwnerLock(lock({ retirement: null }), lock({ retirement: null }))).toBe(true);
    expect(sameQueueOwnerLock(lock(), lock({ retirement: null }))).toBe(false);
    expect(sameQueueOwnerLock(lock({ retirement: null }), lock())).toBe(false);
    expect(sameQueueOwnerLock(lock({ retirement: null }), lock({ retirement: { state: "pending" } }))).toBe(false);
  });
});

describe("posixLstartToUtc", () => {
  test("mirrors acpx's lstart-to-UTC conversion", () => {
    expect(posixLstartToUtc("Tue Oct 13 09:15:30 2026")).toBe(LSTART_UTC);
    expect(posixLstartToUtc("Tue Oct  5 09:15:30 2026")).toBe("2026-10-05T09:15:30.000Z");
  });

  test("rejects unparseable output", () => {
    expect(posixLstartToUtc("garbage")).toBeUndefined();
    expect(posixLstartToUtc("Tue Xxx 13 09:15:30 2026")).toBeUndefined();
  });
});

describe("posixLstartProbeEnv", () => {
  test("renders lstart under the same locale and timezone acpx records it in", () => {
    // A missing TZ makes `ps lstart` render host-local time; the lease holds
    // UTC, so the mismatch reads as a reused pid on non-UTC hosts.
    const env = posixLstartProbeEnv();
    expect(env.TZ).toBe("UTC");
    expect(env.LC_ALL).toBe("C");
    // Inherited variables stay reachable (PATH and friends) without shadowing.
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe("proveQueueOwnerLock", () => {
  test("posix-lstart: matching birth time proves the current owner", async () => {
    expect(await proveQueueOwnerLock(lock(), "rec-1", {
      runPs: psSeam("Tue Oct 13 09:15:30 2026"),
    })).toEqual({ kind: "current-owner" });
  });

  test("posix-lstart: reused pid is not our owner", async () => {
    expect(await proveQueueOwnerLock(lock(), "rec-1", {
      runPs: psSeam("Wed Oct 14 11:00:00 2026"),
    })).toEqual({ kind: "unverifiable", reason: "pid was reused by a different process" });
  });

  test("posix-lstart: gone process means a stale lease", async () => {
    expect(await proveQueueOwnerLock(lock(), "rec-1", { runPs: psSeam(null) })).toEqual({ kind: "stale-owner" });
  });

  test("posix-lstart: unavailable probe fails closed", async () => {
    expect(await proveQueueOwnerLock(lock(), "rec-1", {
      runPs: async () => undefined,
    })).toEqual({ kind: "unverifiable", reason: "process start time could not be read" });
  });

  test("a lease naming another session is never ours", async () => {
    expect(await proveQueueOwnerLock(lock(), "rec-2", {
      runPs: psSeam("Tue Oct 13 09:15:30 2026"),
    })).toEqual({ kind: "unverifiable", reason: "lease names a different session" });
  });

  test("a retiring owner stays under acpx custody", async () => {
    expect(await proveQueueOwnerLock(lock({ retirement: { state: "pending" } }), "rec-1", {
      runPs: psSeam("Tue Oct 13 09:15:30 2026"),
    })).toEqual({ kind: "unverifiable", reason: "owner is retiring under acpx custody" });
  });

  test("an incomplete retirement (retirement: null) also stays under acpx custody", async () => {
    // acpx refuses every lease refresh for a null retirement, so the owner is
    // mid-retirement with unverifiable evidence — never ours to terminate.
    expect(await proveQueueOwnerLock(lock({ retirement: null }), "rec-1", {
      runPs: psSeam("Tue Oct 13 09:15:30 2026"),
    })).toEqual({ kind: "unverifiable", reason: "owner is retiring under acpx custody" });
  });

  test("a 0.16 lease without birth identity is not proof", async () => {
    expect(await proveQueueOwnerLock(
      lock({ processIdentity: undefined }),
      "rec-1",
      { runPs: psSeam("Tue Oct 13 09:15:30 2026") },
    )).toEqual({ kind: "unverifiable", reason: "lease carries no birth identity" });
  });

  test("linux-proc: matching scope and start ticks prove the current owner", async () => {
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "boot-1",
        pidNamespace: "pid:[4026531836]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    const stat = "4242 (node) S 1 4242 4242 0 -1 4194304 100 0 0 0 10 20 0 0 20 0 1 0 987654 100 0 0";
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-1\n" : stat),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
    })).toEqual({ kind: "current-owner" });
  });

  test("linux-proc: different start ticks mean the pid was reused", async () => {
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "boot-1",
        pidNamespace: "pid:[4026531836]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    const stat = "4242 (node) S 1 4242 4242 0 -1 4194304 100 0 0 0 10 20 0 0 20 0 1 0 111111 100 0 0";
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-1\n" : stat),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
    })).toEqual({ kind: "unverifiable", reason: "pid was reused by a different process" });
  });

  test("linux-proc: a different boot makes the lease stale", async () => {
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "boot-old",
        pidNamespace: "pid:[4026531836]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    const stat = "4242 (node) S 1 4242 4242 0 -1 4194304 100 0 0 0 10 20 0 0 20 0 1 0 987654 100 0 0";
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-new\n" : stat),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
    })).toEqual({ kind: "stale-owner" });
  });

  test("linux-proc: a gone process means a stale lease", async () => {
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "boot-1",
        pidNamespace: "pid:[4026531836]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-1\n" : null),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
      isPidGone: () => true,
    })).toEqual({ kind: "stale-owner" });
  });

  test("linux-proc: an invisible pid in another namespace keeps the lock", async () => {
    // Shared HOME, owner in a different PID namespace: the pid is not visible
    // here, but the owner is alive. Unproven scope MUST NOT read as stale.
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "boot-1",
        pidNamespace: "pid:[4026531844]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-1\n" : null),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
      isPidGone: () => true,
    })).toEqual({ kind: "unverifiable", reason: "observer pid namespace differs from the lease" });
  });

  test("linux-proc: invisibility without confirmed death fails closed", async () => {
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "boot-1",
        pidNamespace: "pid:[4026531836]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-1\n" : null),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
      isPidGone: () => false,
    })).toEqual({ kind: "unverifiable", reason: "owner pid is not visible and death is unconfirmed" });
  });

  test("linux-proc: malformed lease scope fails closed instead of stale", async () => {
    const linuxLock = lock({
      processIdentity: {
        kind: "linux-proc",
        bootId: "",
        pidNamespace: "pid:[4026531836]",
        timeNamespace: "unsupported",
        startTicks: "987654",
      },
    });
    expect(await proveQueueOwnerLock(linuxLock, "rec-1", {
      readProcFile: async (path) => (path.endsWith("boot_id") ? "boot-1\n" : null),
      readProcLink: async (path) => (path.endsWith("ns/pid") ? "pid:[4026531836]" : null),
      isPidGone: () => true,
    })).toEqual({ kind: "unverifiable", reason: "malformed boot id in lease" });
  });

  test("unsupported identity kinds fail closed", async () => {
    expect(await proveQueueOwnerLock(
      lock({ processIdentity: { kind: "windows-creation", value: "2026-10-13T09:15:30.1234567Z" } }),
      "rec-1",
      { runPs: psSeam("Tue Oct 13 09:15:30 2026") },
    )).toEqual({ kind: "unverifiable", reason: 'unsupported birth identity kind "windows-creation"' });
  });
});
