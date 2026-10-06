import { expect, test } from "bun:test";

import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";
import { RelayClient } from "../../../../packages/channel-relay/src/relay-client";
import type { RelayFatalReason } from "../../../../packages/channel-relay/src/relay-client";

/**
 * A terminal connector failure must fail `RelayChannel.start()`.
 *
 * WHY THIS IS A CAPABILITY BUG AND NOT A COSMETIC ONE
 *
 * `MessageChannelRegistry.supportedElicitationModes()` decides whether the daemon
 * advertises form support, and it drops a channel only when that channel is in
 * `failedStartupChannels`. The registry adds a channel there when `start()`
 * throws. `RelayClient` already treated these cases as permanent — no credential
 * and no pairing token, a hub-rejected handshake (stale credential, used or
 * expired pairing token), a protocol error, a protocol version mismatch — but it
 * only logged and closed its socket, so `start()` kept waiting on the daemon's
 * abort signal and never rejected.
 *
 * The consequence was a channel advertising `form` forever while every
 * `requestElicitation()` failed against a client that was not ready: the declared
 * half said the capability existed, the live half said nothing, and the
 * declared-minus-live audit had no defect to see. That is the shape M5's
 * truthfulness work exists to remove, so the failure has to propagate out of
 * `start()`.
 *
 * Ordinary disconnects are deliberately NOT covered here: they keep their own
 * reconnect path and must not fail a start, which is exactly why the fatal signal
 * is a separate callback rather than a reuse of `onDisconnected`.
 */

class MemoryCredentialStore {
  constructor(private value: RelayCredential | null = null) {}
  load(): RelayCredential | null {
    return this.value;
  }
  save(credential: RelayCredential): void {
    this.value = credential;
  }
  clear(): void {
    this.value = null;
  }
}

/** The minimum `ChannelStartInput` the relay channel needs to reach its client. */
function startInput(abortSignal: AbortSignal): unknown {
  return {
    agent: { chat: async () => ({ text: "" }) },
    quota: {},
    logger: {
      info: async () => {},
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    },
    control: {
      events: { subscribe: () => () => {} },
      listSessions: () => [],
    },
    coreVersion: "0.11.0",
    abortSignal,
  };
}

/**
 * The options the built channel hands to `createClient` — read through a single
 * validated seam rather than inline-cast at each call site, because every test
 * here reaches the `onFatal` handler through it.
 */
type ClientOptions = { onFatal?: (reason: RelayFatalReason) => void };

/** A stub client that does nothing but stand in for the real `RelayClient`. */
function inertClient(): unknown {
  return {
    start: () => {},
    stop: () => {},
    sendEvent: () => {},
    isReady: () => false,
    sendRequest: () => new Promise<never>(() => {}),
  };
}

/**
 * A `createClient` that fires the given fatal reason through the handler the
 * channel itself installed — the same call the real `RelayClient` makes, so the
 * tests drive production wiring rather than a private hook.
 */
function fatalOnCreateClient(reason: RelayFatalReason): (opts: unknown) => unknown {
  // Unchecked cast is deliberate: this is the DI boundary where a stub stands
  // in for `RelayClientOptions`, which is not exported from the package.
  return (opts: unknown) => {
    const handler = (opts as ClientOptions).onFatal;
    queueMicrotask(() => handler?.(reason));
    return inertClient();
  };
}

/** Resolve with how a start() settled, or throw if it never settles. */
async function settle(started: Promise<void>, ms = 2000): Promise<"resolved" | "rejected"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`start() never settled within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("no credentials rejects start() even when the hub is unreachable", async () => {
  // The fail-fast half, driven through the REAL `RelayClient` rather than a seam:
  // the whole point is where the check sits relative to the network, which is the
  // client's own behaviour. `createSocket` is never expected to be called at all.
  //
  // With neither a stored credential nor a pairing token the connector can never
  // authenticate, so this is a permanent LOCAL configuration error — it must not
  // depend on the hub being reachable. The check therefore runs in
  // `RelayClient.start()` before any connection is attempted.
  //
  // Under the previous placement (inside `sendHandshake`, which only runs once the
  // socket emits `open`), an unreachable hub meant the fatal never fired, the
  // channel looped through reconnect forever, `start()` never rejected, and the
  // registry kept the form capability advertised for a channel that could not use
  // it.
  let socketAttempts = 0;
  const controller = new AbortController();
  // Driven at the `RelayClient` level, because the placement of the check relative
  // to the network is the client's own behaviour and the channel exposes no
  // `createSocket` seam to observe it with.
  let fatalReason: RelayFatalReason | undefined;
  const client = new RelayClient({
    url: "ws://127.0.0.1:1",
    credentialStore: new MemoryCredentialStore(),
    onRequest: () => {},
    onFatal: (reason) => {
      fatalReason = reason;
    },
    createSocket: () => {
      socketAttempts += 1;
      return {
        send: () => {},
        close: () => {},
        terminate: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        readyState: 0,
      } as never;
    },
  });

  client.start(controller.signal);
  // The fatal is synchronous with start(), before any socket exists.
  expect(fatalReason).toBe("no-credentials");
  // The decisive half: no connection was attempted at all.
  expect(socketAttempts).toBe(0);
  expect(client.isReady()).toBe(false);
});

test("start() rejects when the connector reports a terminal failure", async () => {
  // The core assertion. If start() merely parks on the abort signal here, the
  // channel is never recorded in `failedStartupChannels`, and the daemon keeps
  // advertising a form capability it cannot deliver.
  // The fatal is fired through the handler the channel itself installed on
  // `createClient`, which is the same call `RelayClient` makes.
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" },
    {
      credentialStore: new MemoryCredentialStore(),
      createClient: fatalOnCreateClient("handshake-rejected"),
    },
  );

  let message: string | undefined;
  const outcome = await settle(
    channel.start(startInput(new AbortController().signal) as never).then(
      () => undefined,
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        throw error;
      },
    ),
  );

  expect(outcome).toBe("rejected");
  // The reason must reach the operator, not a generic failure.
  expect(message).toContain("handshake-rejected");
});

test("a clean shutdown still resolves start() and is not mistaken for a fatal", async () => {
  // The counterpart: only the fatal path may reject. An ordinary stop resolves,
  // which is what keeps a normal daemon shutdown from being reported as a failed
  // startup.
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" },
    {
      credentialStore: new MemoryCredentialStore(),
      createClient: () => inertClient(),
    },
  );

  const controller = new AbortController();
  const started = channel.start(startInput(controller.signal) as never);

  // Let the channel reach its lifetime wait, then shut it down the normal way.
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();

  expect(await settle(started)).toBe("resolved");
});

test("the fatal teardown uses a stop reason core's channel contract defines", async () => {
  // The reason is not cosmetic: `MessageChannelRuntime.stop?(reason?)` is typed
  // `ChannelStopReason = "shutdown" | "disabled" | "removed" | "logout"`, so the
  // published plugin contract has exactly four members. Passing anything else
  // compiles now only because this package keeps its own local mirror of that
  // union — and the Linux CI leg catches it at `tsc -p
  // packages/channel-relay/tsconfig.json`, which is emitted declaration output,
  // so the error is "Argument of type '"error"' is not assignable" rather than
  // anything that names the contract.
  //
  // Pinned here so a future teardown reason cannot silently invent a fifth
  // member. The failing reason must still exist: it is what `start()` throws
  // with, and the registry reads it off `failedStartupChannels`.
  const stopped: Array<string | undefined> = [];
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" },
    {
      credentialStore: new MemoryCredentialStore(),
      createClient: fatalOnCreateClient("protocol-error"),
    },
  );

  const originalStop = channel.stop.bind(channel);
  channel.stop = async (reason?: "shutdown") => {
    stopped.push(reason);
    await originalStop(reason);
  };

  await expect(
    channel.start(startInput(new AbortController().signal) as never),
  ).rejects.toThrow(/protocol-error/);

  // Exactly one teardown, and its reason is a contract member. The fatal cause
  // itself travels in the thrown error, never as a fabricated stop reason.
  expect(stopped).toEqual(["shutdown"]);
});

