import { describe, expect, test } from "bun:test";

import type {
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  MessageChannelRuntime,
} from "../../../src/channels/types.js";
import {
  PermissionInteractionBroker,
  resetGlobalPermissionBrokerForTests,
  type PermissionInteractionBrokerOptions,
} from "../../../src/permissions/permission-interaction-broker.js";
import type { TurnInteractionContext } from "../../../src/permissions/permission-types.js";
import { summarizePermissionRequest } from "../../../src/permissions/permission-summary.js";

function turn(overrides: Partial<TurnInteractionContext> = {}): TurnInteractionContext {
  return {
    interactionId: `ix-${Math.random().toString(36).slice(2, 10)}`,
    chatKey: "discord:default:g:c1",
    accountId: "default",
    replyContextToken: "msg-1",
    senderId: "user-A",
    senderName: "Ada",
    isOwner: true,
    origin: "human",
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}): {
  logicalSessionId: string;
  sessionKey: string;
  requestId: string;
  toolCallId: string;
  title: string;
  kind: string;
  rawInput: unknown;
  policyGeneration: number;
  workerGeneration: string;
  interactionId?: string;
  availableOutcomes?: Array<"allow_once" | "reject_once">;
} {
  return {
    logicalSessionId: "sess-1",
    sessionKey: "sess-1",
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    toolCallId: "tool-1",
    title: "Run shell command",
    kind: "execute",
    rawInput: { command: "npm run test" },
    policyGeneration: 0,
    workerGeneration: "worker-1",
    ...overrides,
  };
}

function fakeChannel(
  behavior: (request: ChannelPermissionRequest) => Promise<ChannelPermissionDecision>,
  seen: ChannelPermissionRequest[] = [],
): MessageChannelRuntime {
  return {
    id: "fake",
    isLoggedIn: () => true,
    login: async () => "ok",
    logout: async () => {},
    start: async () => {},
    notifyTaskCompletion: async () => {},
    notifyTaskProgress: async () => {},
    sendCoordinatorMessage: async () => {},
    requestPermission: async (request) => {
      seen.push(request);
      return behavior(request);
    },
  };
}
/** Allow decision that correctly reports the requesting initiator (built-in channel behavior). */
function allowAsInitiator(request: ChannelPermissionRequest): Promise<ChannelPermissionDecision> {
  return Promise.resolve({ outcome: "allow_once", responderId: request.requester.senderId });
}

function brokerWith(
  channels: Map<string, MessageChannelRuntime>,
  options: { timeoutMs?: number; logger?: PermissionInteractionBrokerOptions["logger"] } = {},
): PermissionInteractionBroker {
  return new PermissionInteractionBroker({
    getChannelByChatKey: (chatKey) => channels.get(chatKey) ?? null,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

describe("permission interaction broker", () => {
  test("T1 basic allow reaches the exact originating turn", async () => {
    const seen: ChannelPermissionRequest[] = [];
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(allowAsInitiator, seen)],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("allow_once");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.chatKey).toBe(ctx.chatKey);
      expect(seen[0]!.requester.senderId).toBe("user-A");
      expect(seen[0]!.title).toContain("Run shell command");
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("T2 basic reject", async () => {
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(async () => ({ outcome: "reject_once" }))],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("missing interaction route fails closed without touching a channel", async () => {
    let called = 0;
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(async (req) => {
        called += 1;
        return { outcome: "allow_once", responderId: req.requester.senderId };
      })],
    ]);
    const broker = brokerWith(channels);
    try {
      const res = await broker.requestPermission(baseInput());
    } finally {
      broker.shutdown();
    }
  });

  test("T10 non-human origins never invoke channel UI", async () => {
    for (const origin of ["scheduled", "peer", "orchestration"] as const) {
      let called = 0;
      const channels = new Map([
        ["discord:default:g:c1", fakeChannel(async (req) => {
          called += 1;
          return { outcome: "allow_once", responderId: req.requester.senderId };
        })],
      ]);
      const broker = brokerWith(channels);
      const ctx = turn({ origin });
      const dispose = broker.bindTurn(ctx);
      try {
        const res = await broker.requestPermission({
          ...baseInput(),
          interactionId: ctx.interactionId,
        });
        expect(res.outcome).toBe("reject_once");
        expect(called).toBe(0);
      } finally {
        dispose();
        broker.shutdown();
      }
    }
  });

  test("T9 unsupported channel fails closed", async () => {
    const channels = new Map<string, MessageChannelRuntime>([
      ["discord:default:g:c1", {
        id: "legacy",
        isLoggedIn: () => true,
        login: async () => "ok",
        logout: async () => {},
        start: async () => {},
        notifyTaskCompletion: async () => {},
        notifyTaskProgress: async () => {},
        sendCoordinatorMessage: async () => {},
      }],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("missing initiator identity fails closed", async () => {
    let called = 0;
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(async () => {
        called += 1;
        return { outcome: "allow_once" };
      })],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn({ senderId: undefined });
    const withId = { ...ctx, senderId: undefined as unknown as string };
    delete (withId as Partial<TurnInteractionContext>).senderId;
    const dispose = broker.bindTurn(withId);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
      expect(called).toBe(0);
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("T12 channel failure fails closed and cleans pending state", async () => {
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(async () => {
        throw new Error("ui down");
      })],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("malformed channel decision fails closed", async () => {
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(async () => ({ outcome: "bogus" }) as unknown as ChannelPermissionDecision)],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
    } finally {
      dispose();
      broker.shutdown();
    }
  });
  test("T11 duplicate request id fails closed", async () => {
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(() => new Promise<ChannelPermissionDecision>(() => {}))],
    ]);
    const broker = brokerWith(channels, { timeoutMs: 5000 });
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const first = broker.requestPermission({ ...baseInput({ requestId: "dup-1" }), interactionId: ctx.interactionId });
      const second = await broker.requestPermission({ ...baseInput({ requestId: "dup-1" }), interactionId: ctx.interactionId });
      expect(second.outcome).toBe("reject_once");
      dispose();
      const firstRes = await first;
      expect(firstRes.outcome).toBe("reject_once");
    } finally {
      broker.shutdown();
    }
  });

  test("T14 stale disposer cannot delete a newer binding", async () => {
    const broker = new PermissionInteractionBroker({
      getChannelByChatKey: (chatKey) => {
        if (chatKey === "discord:default:g:chatB") {
          return fakeChannel(allowAsInitiator);
        }
        return null;
      },
    });
    const sharedId = "shared-ix";
    const disposeFirst = broker.bindTurn(turn({ interactionId: sharedId, chatKey: "discord:default:g:chatB" }));
    expect(() => broker.bindTurn(turn({ interactionId: sharedId }))).toThrow();
    disposeFirst();
    const liveCtx = turn({ interactionId: sharedId, chatKey: "discord:default:g:chatB" });
    const disposeLive = broker.bindTurn(liveCtx);
    // The stale first disposer is already consumed; invoking it again is a
    // no-op and the live binding still routes.
    disposeFirst();
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: sharedId,
    });
    expect(res.outcome).toBe("allow_once");
    disposeLive();
    broker.shutdown();
    resetGlobalPermissionBrokerForTests();
  });

  test("T13 shutdown aborts pending requests", async () => {
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(() => new Promise<ChannelPermissionDecision>(() => {}))],
    ]);
    const broker = brokerWith(channels, { timeoutMs: 5000 });
    const ctx = turn();
    broker.bindTurn(ctx);
    const pending = broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    broker.shutdown();
    const res = await pending;
    expect(res.outcome).toBe("reject_once");
    const after = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    expect(after.outcome).toBe("reject_once");
  });

  test("T7 queued turn on the same session cannot steal the route", async () => {
    const seen: ChannelPermissionRequest[] = [];
    const channels = new Map([
      ["discord:default:g:chatA", fakeChannel(allowAsInitiator, seen)],
      ["discord:default:g:chatB", fakeChannel(allowAsInitiator, seen)],
    ]);
    const broker = brokerWith(channels);
    const turnA = turn({ chatKey: "discord:default:g:chatA", senderId: "user-A" });
    const turnB = turn({ chatKey: "discord:default:g:chatB", senderId: "user-B" });
    const disposeA = broker.bindTurn(turnA);
    const disposeB = broker.bindTurn(turnB);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: turnA.interactionId,
      });
      expect(res.outcome).toBe("allow_once");
      expect(seen).toHaveLength(1);
      expect(seen[0]!.chatKey).toBe("discord:default:g:chatA");
      expect(seen[0]!.requester.senderId).toBe("user-A");
    } finally {
      disposeA();
      disposeB();
      broker.shutdown();
    }
  });

  test("T8 cross-channel session reuse routes to the exact origin only", async () => {
    const discordSeen: ChannelPermissionRequest[] = [];
    const relaySeen: ChannelPermissionRequest[] = [];
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(allowAsInitiator, discordSeen)],
      ["relay:node1:chat9", fakeChannel(allowAsInitiator, relaySeen)],
    ]);
    const broker = brokerWith(channels);
    const discordTurn = turn({ chatKey: "discord:default:g:c1", senderId: "user-A" });
    const relayTurn = turn({ chatKey: "relay:node1:chat9", senderId: "user-R" });
    const disposeD = broker.bindTurn(discordTurn);
    const disposeR = broker.bindTurn(relayTurn);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: discordTurn.interactionId,
      });
      expect(res.outcome).toBe("allow_once");
      expect(discordSeen).toHaveLength(1);
      expect(relaySeen).toHaveLength(0);
    } finally {
      disposeD();
      disposeR();
      broker.shutdown();
    }
  });

  test("allow_always is rejected when the ACP options do not offer it", async () => {
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(async () => ({ outcome: "allow_always" }))],
    ]);
    const broker = brokerWith(channels);
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput({ availableOutcomes: ["allow_once", "reject_once"] }),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("T4 timeout fails closed and a late allow cannot resurrect it", async () => {
    let release: ((d: ChannelPermissionDecision) => void) | null = null;
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(() => new Promise<ChannelPermissionDecision>((resolve) => {
        release = resolve;
      }))],
    ]);
    const broker = brokerWith(channels, { timeoutMs: 40 });
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    try {
      const res = await broker.requestPermission({
        ...baseInput(),
        interactionId: ctx.interactionId,
      });
      expect(res.outcome).toBe("reject_once");
      release?.({ outcome: "allow_once", responderId: "user-A" });
      expect(broker.pendingCount).toBe(0);
    } finally {
      dispose();
      broker.shutdown();
    }
  });

  test("T3 turn disposal aborts the pending request", async () => {
    let release: ((d: ChannelPermissionDecision) => void) | null = null;
    const channels = new Map([
      ["discord:default:g:c1", fakeChannel(() => new Promise<ChannelPermissionDecision>((resolve) => {
        release = resolve;
      }))],
    ]);
    const broker = brokerWith(channels, { timeoutMs: 5000 });
    const ctx = turn();
    const dispose = broker.bindTurn(ctx);
    const pending = broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    dispose();
    const res = await pending;
    expect(res.outcome).toBe("reject_once");
    release?.({ outcome: "allow_once", responderId: "user-A" });
    broker.shutdown();
  });
  test("T15 bounded presentation never dumps raw input", () => {
    const huge = "x".repeat(50_000);
    const nested = { command: huge, env: { SECRET: huge, nested: { deep: huge } } };
    const summary = summarizePermissionRequest({ title: "Run shell command", kind: "execute", rawInput: nested });
    expect(summary.title).toBe("Run shell command");
    const total = `${summary.title ?? ""}${summary.kind ?? ""}${summary.summary ?? ""}`;
    expect(total.length).toBeLessThan(1200);
    expect(total).not.toContain("SECRET");
    expect(JSON.stringify(summary).length).toBeLessThan(1500);
  });
});

test("B4 turn abort invalidates pending UI even when transport cancel hangs", async () => {
  // The channel promise never settles on its own (a wedged transport.cancel
  // would leave the prompt promise pending forever); the turn abort alone
  // must still fail the request closed immediately.
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(() => new Promise<ChannelPermissionDecision>(() => {}))],
  ]);
  const broker = brokerWith(channels, { timeoutMs: 5000 });
  const abort = new AbortController();
  const ctx = turn();
  const dispose = broker.bindTurn(ctx, abort.signal);
  try {
    const pending = broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    abort.abort();
    const res = await pending;
    expect(res.outcome).toBe("reject_once");
    expect(broker.pendingCount).toBe(0);
  } finally {
    dispose();
    broker.shutdown();
  }
});

test("B4 pre-aborted turn fails closed without touching a channel", async () => {
  let called = 0;
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(async (req) => {
      called += 1;
      return { outcome: "allow_once", responderId: req.requester.senderId };
    })],
  ]);
  const broker = brokerWith(channels, { timeoutMs: 5000 });
  const abort = new AbortController();
  abort.abort();
  const ctx = turn();
  const dispose = broker.bindTurn(ctx, abort.signal);
  try {
    // Per I6 a pre-aborted turn has exactly one legal outcome, and the
    // pre-aborted bind must not leave a route behind.
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    expect(res.outcome).toBe("reject_once");
    expect(called).toBe(0);
    expect(broker.pendingCount).toBe(0);
  } finally {
    dispose();
    broker.shutdown();
  }
});

test("B4 aborted turn cannot mint new approval UI while transport still hangs", async () => {
  let called = 0;
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(async (req) => {
      called += 1;
      return { outcome: "allow_once", responderId: req.requester.senderId };
    })],
  ]);
  const broker = brokerWith(channels, { timeoutMs: 5000 });
  const abort = new AbortController();
  const ctx = turn();
  const dispose = broker.bindTurn(ctx, abort.signal);
  // Turn is cancelled while transport.cancel() hangs: the prompt never
  // settles, so dispose() never runs. A second permission request from the
  // same worker on the same interaction id must still fail closed WITHOUT
  // invoking the channel — the abort made the route itself terminal.
  abort.abort();
  try {
    const first = await broker.requestPermission({
      ...baseInput({ requestId: "perm-after-abort-1" }),
      interactionId: ctx.interactionId,
    });
    expect(first.outcome).toBe("reject_once");
    const second = await broker.requestPermission({
      ...baseInput({ requestId: "perm-after-abort-2" }),
      interactionId: ctx.interactionId,
    });
    expect(second.outcome).toBe("reject_once");
    expect(called).toBe(0);
    expect(broker.pendingCount).toBe(0);
  } finally {
    dispose();
    broker.shutdown();
  }
});

test("H1 responder mismatch fails closed even when the outcome is allow", async () => {
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(async () => ({ outcome: "allow_once", responderId: "user-INTRUDER" }))],
  ]);
  const broker = brokerWith(channels);
  const ctx = turn({ senderId: "user-A" });
  const dispose = broker.bindTurn(ctx);
  try {
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    expect(res.outcome).toBe("reject_once");
  } finally {
    dispose();
    broker.shutdown();
  }
});

test("H1 matching responderId is accepted; missing responderId fails closed", async () => {
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(async () => ({ outcome: "allow_once", responderId: "user-A" }))],
    ["discord:default:g:c2", fakeChannel(async () => ({ outcome: "allow_once" }))],
  ]);
  const broker = brokerWith(channels);
  const ctxA = turn({ chatKey: "discord:default:g:c1", senderId: "user-A" });
  const disposeA = broker.bindTurn(ctxA);
  try {
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctxA.interactionId,
    });
    expect(res.outcome).toBe("allow_once");
  } finally {
    disposeA();
  }
  // responderId is REQUIRED: a decision that does not prove WHO clicked
  // fails closed even when the outcome itself is allow.
  const ctxB = turn({ chatKey: "discord:default:g:c2", senderId: "user-B" });
  const disposeB = broker.bindTurn(ctxB);
  try {
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctxB.interactionId,
    });
    expect(res.outcome).toBe("reject_once");
  } finally {
    disposeB();
    broker.shutdown();
  }
});

test("B1 allow resolved from the abort signal still fails closed after the deadline", async () => {
  // A channel that resolves allow exactly when its signal aborts simulates
  // the critical race: both sides of the Promise.race settle on the same
  // tick, and iterable order would hand the stale allow to the winner.
  // The settled flag set by the deadline callback must win instead (I4/I5).
  const seen: ChannelPermissionRequest[] = [];
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel((request) => new Promise<ChannelPermissionDecision>((resolve) => {
      const allow = (): void => {
        resolve({ outcome: "allow_once", responderId: request.requester.senderId });
      };
      if (request.signal.aborted) allow();
      else request.signal.addEventListener("abort", allow, { once: true });
    }), seen)],
  ]);
  const broker = brokerWith(channels, { timeoutMs: 30 });
  const ctx = turn();
  const dispose = broker.bindTurn(ctx);
  try {
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    expect(res.outcome).toBe("reject_once");
    expect(seen).toHaveLength(1);
    expect(broker.pendingCount).toBe(0);
  } finally {
    dispose();
    broker.shutdown();
  }
});

test("B1 channel UI is never invoked when a seam stalls past the deadline", async () => {
  // A slow seam (here: logging) between route validation and channel
  // dispatch can carry the turn past expiresAt. The pre-dispatch
  // re-verification must fail closed WITHOUT invoking channel UI.
  let channelCalled = 0;
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(async (req) => {
      channelCalled += 1;
      return { outcome: "allow_once", responderId: req.requester.senderId };
    })],
  ]);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const broker = brokerWith(channels, {
    timeoutMs: 30,
    logger: {
      info: async () => { await sleep(100); },
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    } as never,
  });
  const ctx = turn();
  const dispose = broker.bindTurn(ctx);
  try {
    const res = await broker.requestPermission({
      ...baseInput(),
      interactionId: ctx.interactionId,
    });
    expect(res.outcome).toBe("reject_once");
    expect(channelCalled).toBe(0);
    expect(broker.pendingCount).toBe(0);
  } finally {
    dispose();
    broker.shutdown();
  }
});

test("approval summary surfaces the real command/path, not the ACP envelope", () => {
  // End-to-end presentation pin: given the worker-extracted ACP subject as
  // rawInput, the summary the approver sees must contain the command.
  const summary = summarizePermissionRequest({
    title: "Run command",
    kind: "execute",
    rawInput: { type: "command", command: "npm run test -- --watch", cwd: "/repo/backend" },
  });
  expect(summary.summary).toContain("npm run test");
  expect(JSON.stringify(summary)).not.toContain("sessionId");
});

test("committed allow is delivered without waiting for observability", async () => {
  // The resolved log must not sit between commit and delivery: a hanging
  // log chain would otherwise push delivery past the upstream watchdog even
  // though the decision already committed.
  const channels = new Map([
    ["discord:default:g:c1", fakeChannel(allowAsInitiator)],
  ]);
  const broker = brokerWith(channels, {
    timeoutMs: 5000,
    logger: {
      info: async (event: string) => {
        if (event === "permission.interaction.resolved") {
          await new Promise<never>(() => {});
        }
      },
      warn: async () => {},
      error: async () => {},
      debug: async () => {},
    } as never,
  });
  const ctx = turn();
  const dispose = broker.bindTurn(ctx);
  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("delivery waited for observability")), 2000);
      if (typeof timer.unref === "function") timer.unref();
    });
    const res = await Promise.race([
      broker.requestPermission({ ...baseInput(), interactionId: ctx.interactionId }),
      timeout,
    ]);
    expect(res.outcome).toBe("allow_once");
  } finally {
    dispose();
    broker.shutdown();
  }
});
