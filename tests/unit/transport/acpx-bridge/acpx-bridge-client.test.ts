import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  AcpxBridgeClient,
  bridgeRequestTimeoutMs,
  buildBridgeSpawnEnv,
  buildBridgeSpawnSpec,
  manageBridgeChild,
} from "../../../../src/transport/acpx-bridge/acpx-bridge-client";
import {
  normalizeBridgePermissionPolicy,
  normalizeBridgeSessionInitTimeoutMs,
} from "../../../../src/bridge/bridge-env";
import { encodeBridgeRequest } from "../../../../src/transport/acpx-bridge/acpx-bridge-protocol";
import { PromptCommandError } from "../../../../src/transport/prompt-output";
import { MissingOptionalDepError } from "../../../../src/recovery/errors";

test("encodes a bridge request as ndjson", () => {
  expect(
    encodeBridgeRequest({
      id: "1",
      method: "ping",
      params: {},
    }),
  ).toBe('{"id":"1","method":"ping","params":{}}\n');
});

test("resolves responses by request id", async () => {
  const writes: string[] = [];
  const client = new AcpxBridgeClient((line) => {
    writes.push(line);
  });

  const pending = client.request("ping", {});
  client.handleLine('{"id":"1","ok":true,"result":{}}');

  await expect(pending).resolves.toEqual({});
  expect(writes).toEqual(['{"id":"1","method":"ping","params":{}}\n']);
});

test("rejects responses with bridge error payloads", async () => {
  const client = new AcpxBridgeClient(() => {});

  const pending = client.request("ping", {});
  client.handleLine('{"id":"1","ok":false,"error":{"code":"PING_FAILED","message":"boom"}}');

  await expect(pending).rejects.toThrow("boom");
});

test("reconstructs prompt command diagnostics from bridge error payloads", async () => {
  const client = new AcpxBridgeClient(() => {});

  const pending = client.request("prompt", {});
  client.handleLine(
    '{"id":"1","ok":false,"error":{"code":"BRIDGE_INTERNAL_ERROR","message":"command failed with exit code 5","details":{"exitCode":5,"stdout":"partial stdout","stderr":"partial stderr"}}}',
  );

  try {
    await pending;
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PromptCommandError);
    expect((error as PromptCommandError).exitCode).toBe(5);
    expect((error as PromptCommandError).stdout).toBe("partial stdout");
    expect((error as PromptCommandError).stderr).toBe("partial stderr");
  }
});

test("rejects pending requests when the bridge exits before replying", async () => {
  const client = new AcpxBridgeClient(() => {});

  const pending = client.request("ping", {});
  client.handleExit(new Error("bridge process exited before responding"));

  await expect(pending).rejects.toThrow("bridge process exited before responding");
});

test("delivers prompt segment events before resolving the final response", async () => {
  const events: string[] = [];
  const client = new AcpxBridgeClient(() => {});

  const pending = client.request("prompt", {}, (event) => {
    if (event.type === "prompt.segment") {
      events.push(event.text);
    }
  });
  client.handleLine('{"id":"1","event":"prompt.segment","text":"hello"}');
  client.handleLine('{"id":"1","ok":true,"result":{"text":"done"}}');

  await expect(pending).resolves.toEqual({ text: "done" });
  expect(events).toEqual(["hello"]);
});

test("uses direct node execution instead of `node run` when spawning the bridge", () => {
  expect(
    buildBridgeSpawnSpec({
      execPath: "/usr/local/bin/node",
      bridgeEntryPath: "/app/dist/bridge/bridge-main.js",
    }),
  ).toEqual({
    command: "/usr/local/bin/node",
    args: ["/app/dist/bridge/bridge-main.js"],
  });
});

test("keeps bun's `run` subcommand when spawning the bridge under bun", () => {
  expect(
    buildBridgeSpawnSpec({
      execPath: "/usr/local/bin/bun",
      bridgeEntryPath: "/app/src/bridge/bridge-main.ts",
    }),
  ).toEqual({
    command: "/usr/local/bin/bun",
    args: ["run", "/app/src/bridge/bridge-main.ts"],
  });
});

test("ignores malformed bridge output and keeps the pending request alive", async () => {
  const client = new AcpxBridgeClient(() => {});

  const pending = client.request("ping", {});
  expect(() => client.handleLine("not-json")).not.toThrow();
  client.handleLine('{"id":"1","ok":true,"result":{}}');

  await expect(pending).resolves.toEqual({});
});

test("rejects new requests after the bridge exits", async () => {
  const client = new AcpxBridgeClient(() => {});
  client.handleExit(new Error("bridge exited"));

  await expect(client.request("ping", {})).rejects.toThrow("bridge exited");
});

test("keeps the request pending when the writer signals backpressure (write returned false)", async () => {
  // Writable.write returning false means "queued above the high-water mark" —
  // the line is still delivered, so the request must NOT fail.
  const writes: string[] = [];
  const client = new AcpxBridgeClient((line) => {
    writes.push(line);
    return false;
  });

  const pending = client.request("ping", {});
  client.handleLine('{"id":"1","ok":true,"result":{}}');

  await expect(pending).resolves.toEqual({});
  expect(writes).toEqual(['{"id":"1","method":"ping","params":{}}\n']);
});

test("rejects the request when the write callback reports a real write error", async () => {
  const client = new AcpxBridgeClient((_line, onWriteError) => {
    onWriteError?.(new Error("write EPIPE"));
    return false;
  });

  await expect(client.request("ping", {})).rejects.toThrow("write EPIPE");
});

test("a late write-callback error after the response resolved is ignored", async () => {
  let reportError: ((error?: Error | null) => void) | undefined;
  const client = new AcpxBridgeClient((_line, onWriteError) => {
    reportError = onWriteError;
  });

  const pending = client.request("ping", {});
  client.handleLine('{"id":"1","ok":true,"result":{}}');
  await expect(pending).resolves.toEqual({});

  expect(() => reportError?.(new Error("write EPIPE"))).not.toThrow();
});

test("survives an 'error' event on the bridge stdin and keeps serving requests", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, pid: 12345 });

  const client = manageBridgeChild(child);

  // Per Node stream semantics a failed write is reported through the write
  // callback AND as an 'error' event on the stream. Without a listener the
  // event becomes an uncaught exception that kills the daemon.
  expect(() => stdin.emit("error", new Error("write EPIPE"))).not.toThrow();

  // The client must keep functioning after the stdin error.
  const pending = client.request("ping", {});
  stdout.write('{"id":"1","ok":true,"result":{}}\n');
  await expect(pending).resolves.toEqual({});
});

test("includes the permission policy in the bridge spawn env and round-trips it", () => {
  const env = buildBridgeSpawnEnv({ permissionPolicy: "C:/policies/weacpx-policy.json" });

  expect(env.XACPX_BRIDGE_PERMISSION_POLICY).toBe("C:/policies/weacpx-policy.json");
  expect(normalizeBridgePermissionPolicy(env.XACPX_BRIDGE_PERMISSION_POLICY)).toBe(
    "C:/policies/weacpx-policy.json",
  );
});

test("includes the session init timeout in the bridge spawn env and round-trips it", () => {
  const env = buildBridgeSpawnEnv({ sessionInitTimeoutMs: 120_000 });

  expect(env.XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS).toBe("120000");
  expect(normalizeBridgeSessionInitTimeoutMs(env.XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS)).toBe(120_000);
});

test("omits the session init timeout from the bridge spawn env when unset or invalid", () => {
  expect("XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS" in buildBridgeSpawnEnv({})).toBe(false);
  expect(
    "XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS" in buildBridgeSpawnEnv({ sessionInitTimeoutMs: Number.NaN }),
  ).toBe(false);
  expect(
    "XACPX_BRIDGE_SESSION_INIT_TIMEOUT_MS" in buildBridgeSpawnEnv({ sessionInitTimeoutMs: 0 }),
  ).toBe(false);
});

test("omits the permission policy from the bridge spawn env when unset", () => {
  const env = buildBridgeSpawnEnv({});

  expect("XACPX_BRIDGE_PERMISSION_POLICY" in env).toBe(false);
  expect(env.XACPX_BRIDGE_PERMISSION_MODE).toBe("approve-all");
  expect(env.XACPX_BRIDGE_NON_INTERACTIVE_PERMISSIONS).toBe("deny");
  expect(env.XACPX_BRIDGE_ACPX_COMMAND).toBe("acpx");
});

test("hands the CLI command down to the bridge so its mcp-stdio launcher targets the CLI, not bridge-main", () => {
  // The bridge's queue-owner launcher runs inside bridge-main.js; left to its own
  // process.argv[1] it would point each agent's `mcp-stdio` coordinator server at
  // bridge-main.js (which only speaks the bridge protocol → 30s MCP handshake stall per
  // prompt). The console must therefore pass its real CLI command via XACPX_CLI_COMMAND.
  const env = buildBridgeSpawnEnv({ cliCommand: "/usr/bin/node /opt/xacpx/dist/cli.js" });
  expect(env.XACPX_CLI_COMMAND).toBe("/usr/bin/node /opt/xacpx/dist/cli.js");
  expect(env.XACPX_CLI_COMMAND).not.toContain("bridge-main");
});

test("always sets a non-empty XACPX_CLI_COMMAND even without an explicit cliCommand", () => {
  // Defaults to the console's resolved command; the key must be present so the bridge
  // never falls back to its own bridge-main.js argv[1].
  const env = buildBridgeSpawnEnv({});
  expect(typeof env.XACPX_CLI_COMMAND).toBe("string");
  expect(env.XACPX_CLI_COMMAND.length).toBeGreaterThan(0);
});

describe("AcpxBridgeClient", () => {
  test("delivers session.progress events to onEvent", async () => {
    const writes: string[] = [];
    const client = new AcpxBridgeClient((line) => { writes.push(line); return true; });
    const events: Array<{ type: string; stage?: string }> = [];
    const promise = client.request("ensureSession", {}, (event) => {
      events.push(event);
    });
    const req = JSON.parse(writes[0]);
    client.handleLine(JSON.stringify({ id: req.id, event: "session.progress", stage: "spawn" }));
    client.handleLine(JSON.stringify({ id: req.id, event: "session.progress", stage: "initializing" }));
    client.handleLine(JSON.stringify({ id: req.id, ok: true, result: {} }));
    await promise;
    expect(events).toEqual([
      { type: "session.progress", stage: "spawn" },
      { type: "session.progress", stage: "initializing" },
    ]);
  });

  test("rejects with MissingOptionalDepError when response has kind=missing_optional_dep", async () => {
    const writes: string[] = [];
    const client = new AcpxBridgeClient((line) => { writes.push(line); return true; });
    const promise = client.request("ensureSession", {});
    const req = JSON.parse(writes[0]);
    client.handleLine(JSON.stringify({
      id: req.id,
      ok: false,
      error: {
        code: "BRIDGE_INTERNAL_ERROR",
        message: "boom",
        kind: "missing_optional_dep",
        data: { package: "opencode-windows-x64", parentPackagePath: null },
      },
    }));
    await expect(promise).rejects.toBeInstanceOf(MissingOptionalDepError);
  });

  test("delivers session.note events to onEvent", async () => {
    const writes: string[] = [];
    const client = new AcpxBridgeClient((line) => { writes.push(line); return true; });
    const events: Array<{ type: string; text?: string }> = [];
    const promise = client.request("ensureSession", {}, (event) => events.push(event));
    const req = JSON.parse(writes[0]);
    client.handleLine(JSON.stringify({ id: req.id, event: "session.note", text: "[acpx] hello" }));
    client.handleLine(JSON.stringify({ id: req.id, ok: true, result: {} }));
    await promise;
    expect(events).toEqual([{ type: "session.note", text: "[acpx] hello" }]);
  });

  test("ignores late session.progress after response arrives", async () => {
    const writes: string[] = [];
    const client = new AcpxBridgeClient((line) => { writes.push(line); return true; });
    const events: Array<unknown> = [];
    const promise = client.request("ensureSession", {}, (event) => events.push(event));
    const req = JSON.parse(writes[0]);
    client.handleLine(JSON.stringify({ id: req.id, ok: true, result: {} }));
    await promise;
    // Now a late event — pending entry already deleted, should be silently dropped
    client.handleLine(JSON.stringify({ id: req.id, event: "session.progress", stage: "ready" }));
    expect(events).toHaveLength(0);
  });

  test("delivers prompt.thought events to onEvent", async () => {
    const writes: string[] = [];
    const client = new AcpxBridgeClient((line) => { writes.push(line); return true; });
    const events: Array<{ type: string; text?: string }> = [];
    const promise = client.request("prompt", {}, (event) => events.push(event));
    const req = JSON.parse(writes[0]);
    client.handleLine(JSON.stringify({ id: req.id, event: "prompt.thought", text: "deliberating" }));
    client.handleLine(JSON.stringify({ id: req.id, ok: true, result: { text: "done" } }));
    await promise;
    expect(events).toEqual([{ type: "prompt.thought", text: "deliberating" }]);
  });

  test("delivers prompt.plan events to onEvent", async () => {
    const writes: string[] = [];
    const client = new AcpxBridgeClient((line) => { writes.push(line); return true; });
    const events: Array<unknown> = [];
    const promise = client.request("prompt", {}, (event) => events.push(event));
    const req = JSON.parse(writes[0]);
    const entries = [
      { content: "Read the file", status: "completed", priority: "high" },
      { content: "Make the edit", status: "in_progress" },
    ];
    client.handleLine(JSON.stringify({ id: req.id, event: "prompt.plan", entries }));
    client.handleLine(JSON.stringify({ id: req.id, ok: true, result: { text: "done" } }));
    await promise;
    expect(events).toEqual([{ type: "prompt.plan", entries }]);
  });
});

// ── per-request timeout backstop ─────────────────────────────────────────────

describe("per-request timeout", () => {
  type ArmedTimer = { fn: () => void; ms: number };

  function makeTimerSeams() {
    const armed: ArmedTimer[] = [];
    const cleared: unknown[] = [];
    return {
      armed,
      cleared,
      setTimeoutFn: (fn: () => void, ms: number) => {
        const timer = { fn, ms };
        armed.push(timer);
        return timer;
      },
      clearTimeoutFn: (timer: unknown) => {
        cleared.push(timer);
      },
    };
  }

  test("a management request whose response never arrives times out and rejects", async () => {
    const seams = makeTimerSeams();
    const client = new AcpxBridgeClient(() => {}, seams);

    const pending = client.request("cancel", {});
    expect(seams.armed).toHaveLength(1);
    // Management subprocess bound (30s) + client-side grace (15s).
    expect(seams.armed[0]!.ms).toBe(45_000);

    seams.armed[0]!.fn();
    await expect(pending).rejects.toThrow('bridge request "cancel" timed out after 45000ms');
  });

  test("a late response after the timeout fired is ignored (pending entry removed)", async () => {
    const seams = makeTimerSeams();
    const client = new AcpxBridgeClient(() => {}, seams);

    const pending = client.request("hasSession", {});
    seams.armed[0]!.fn();
    await expect(pending).rejects.toThrow(/timed out/);

    // The pending map entry is gone, so a straggler response must be a no-op.
    expect(() => client.handleLine('{"id":"1","ok":true,"result":{"exists":true}}')).not.toThrow();
  });

  test("prompt requests never arm a timeout (long agent turns are legitimate)", async () => {
    const seams = makeTimerSeams();
    const client = new AcpxBridgeClient(() => {}, seams);

    const pending = client.request("prompt", {});
    expect(seams.armed).toHaveLength(0);

    client.handleLine('{"id":"1","ok":true,"result":{"text":"done"}}');
    await expect(pending).resolves.toEqual({ text: "done" });
  });

  test("ensureSession timeout derives from sessionInitTimeoutMs plus grace", () => {
    const seams = makeTimerSeams();
    const client = new AcpxBridgeClient(() => {}, { ...seams, sessionInitTimeoutMs: 1_000 });

    void client.request("ensureSession", {}).catch(() => {});
    expect(seams.armed[0]!.ms).toBe(16_000);
  });

  test("bridgeRequestTimeoutMs tiers match the subprocess-side bounds", () => {
    expect(bridgeRequestTimeoutMs("prompt")).toBeUndefined();
    expect(bridgeRequestTimeoutMs("ensureSession")).toBe(135_000);
    expect(bridgeRequestTimeoutMs("resumeAgentSession")).toBe(135_000);
    // Two list runs (--filter-cwd capability fallback), each sessionInit-bounded.
    expect(bridgeRequestTimeoutMs("listAgentSessions")).toBe(255_000);
    // Two sequential management commands (sessions show + close / owner kill).
    expect(bridgeRequestTimeoutMs("deleteSession")).toBe(75_000);
    expect(bridgeRequestTimeoutMs("freeWarmProcess")).toBe(75_000);
    expect(bridgeRequestTimeoutMs("cancel")).toBe(45_000);
    expect(bridgeRequestTimeoutMs("hasSession")).toBe(45_000);
    expect(bridgeRequestTimeoutMs("setMode")).toBe(45_000);
  });

  test("a response arriving in time clears the armed timer", async () => {
    const seams = makeTimerSeams();
    const client = new AcpxBridgeClient(() => {}, seams);

    const pending = client.request("hasSession", {});
    client.handleLine('{"id":"1","ok":true,"result":{"exists":true}}');

    await expect(pending).resolves.toEqual({ exists: true });
    expect(seams.cleared).toEqual([seams.armed[0]]);
  });

  test("a bridge exit rejection clears the armed timer", async () => {
    const seams = makeTimerSeams();
    const client = new AcpxBridgeClient(() => {}, seams);

    const pending = client.request("hasSession", {});
    client.handleExit(new Error("bridge process exited before responding"));

    await expect(pending).rejects.toThrow("bridge process exited before responding");
    expect(seams.cleared).toEqual([seams.armed[0]]);
  });
});

test("reports malformed bridge output lines through onMalformedLine", async () => {
  const malformed: string[] = [];
  const client = new AcpxBridgeClient(() => {}, {
    onMalformedLine: (line) => malformed.push(line),
  });

  const pending = client.request("ping", {});
  client.handleLine("garbled-not-json");
  client.handleLine('{"id":"1","ok":true,"result":{}}');

  await expect(pending).resolves.toEqual({});
  expect(malformed).toEqual(["garbled-not-json"]);
});
