import { expect, test } from "bun:test";

import { RelayChannel } from "../../../../packages/channel-relay/src/channel";
import type { RelayCredential } from "../../../../packages/channel-relay/src/credential-store";
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

test("start() rejects when the connector reports a terminal failure", async () => {
  // The core assertion. If start() merely parks on the abort signal here, the
  // channel is never recorded in `failedStartupChannels`, and the daemon keeps
  // advertising a form capability it cannot deliver.
  //
  // The fatal is fired through the handler the channel itself installed on
  // `createClient`, which is the same call `RelayClient` makes.
  const channel = new RelayChannel(
    { url: "ws://h:1", pairingToken: "t" },
    {
      credentialStore: new MemoryCredentialStore(),
      createClient: (opts: unknown) => {
        const handler = (opts as { onFatal?: (reason: RelayFatalReason) => void }).onFatal;
        queueMicrotask(() => handler?.("handshake-rejected"));
        return {
          start: () => {},
          stop: () => {},
          sendEvent: () => {},
          isReady: () => false,
          sendRequest: () => new Promise<never>(() => {}),
        } as never;
      },
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
      createClient: () =>
        ({
          start: () => {},
          stop: () => {},
          sendEvent: () => {},
          isReady: () => false,
          sendRequest: () => new Promise<never>(() => {}),
        }) as never,
    },
  );

  const controller = new AbortController();
  const started = channel.start(startInput(controller.signal) as never);

  // Let the channel reach its lifetime wait, then shut it down the normal way.
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();

  expect(await settle(started)).toBe("resolved");
});
