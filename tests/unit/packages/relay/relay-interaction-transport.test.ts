import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MSG,
  RELAY_CAPABILITIES,
  type ControlEventDto,
} from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import { MessageStore } from "../../../../packages/relay/src/stores/messages";
import { createApp } from "../../../../packages/relay/src/http/app";
import { InteractionRegistry } from "../../../../packages/relay/src/interaction-registry";
import type { InteractionRequestDto } from "../../../../packages/relay-protocol/src/dtos";

/**
 * The hub's interaction transport, end to end and in the PRODUCTION direction.
 *
 * The chain under test is the one the M3 design requires, and every hop is the
 * real production code:
 *
 *   connector opens (POST interactionRequest)
 *     -> hub validates + registers the pending interaction
 *     -> hub broadcasts a REAL control-event to browsers
 *     -> browser answers (POST interactionRespond)
 *     -> hub stamps the responder from ITS OWN session
 *     -> the opening RPC resolves with that decision
 *
 * What is faked is only the network boundary: the "browser" is a test caller on
 * the hub's HTTP API, which is exactly what a browser is in production. There is
 * no injected renderer, no store-level fake event, and no hand-built frame
 * standing in for a protocol-produced one — the opening frame is validated by the
 * hub's own validator, and the frames it emits are captured off the broadcasts.
 */

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function silentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** The opening frame, built the way `RelayChannel` builds it from a core request. */
function interactionOpenFrame(overrides: Partial<InteractionRequestDto> = {}): InteractionRequestDto {
  return {
    requestId: "req-e2e-1",
    kind: "elicitation",
    expiresAt: Date.now() + 60_000,
    elicitation: {
      mode: "form",
      message: "Which region should I deploy to?",
      fields: [
        {
          kind: "text",
          key: "region",
          title: "Region",
          required: true,
        },
      ],
    },
    ...overrides,
  };
}

interface Harness {
  instanceId: string;
  accountId: string;
  cookie: string;
  open: (frame: InteractionRequestDto) => Deferred<{ status: number; body: unknown }>;
  respond: (payload: unknown) => Promise<{ status: number; body: unknown }>;
  broadcasts: ControlEventDto[];
  waitForEvents: (type: ControlEventDto["type"], count: number) => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "relay-interaction-"));
  const db = await createSqlDriver(join(dir, "hub.db"));
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const admin = accounts.createAccount("admin");
  const { token: loginToken } = accounts.createLoginToken(admin.id, "test");
  const created = instances.registerInstanceForAccount(admin.id, "home-pc");

  const broadcasts: ControlEventDto[] = [];
  const logger = silentLogger();
  const interactions = new InteractionRegistry({
    debug: (event) => {
      // The opened/closed lifecycle is produced by the registry regardless of the
      // HTTP path; capture the browser-facing ones only.
      void event;
    },
  });
  const app = createApp({
    accounts,
    instances,
    messages: new MessageStore(db),
    interactions,
    logger,
    gateway: {
      isOnline: () => true,
      sendRequest: async () => ({}),
      broadcastControlEvent: (_accountId, event) => {
        broadcasts.push(event);
      },
    },
  });

  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: loginToken }),
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";

  const rpc = async (type: string, payload: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await app.request(`/api/instances/${created.instanceId}/rpc`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ type, payload }),
    });
    return { status: res.status, body: await res.json() };
  };

  /**
   * Wait until `count` browser-facing broadcasts of `type` have been emitted.
   *
   * The opening RPC is answered asynchronously (it returns as soon as the
   * interaction is registered, not when it resolves), so a test that wants to
   * observe the published form must wait for it deterministically rather than
   * guessing at microtask ticks. Polling on a timer keeps the test off real
   * wall-clock sleeps; the deadline is the bound that keeps a failure a failure
   * instead of a hang.
   */
  const waitForEvents = async (
    type: ControlEventDto["type"],
    count: number,
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (broadcasts.filter((e) => e.type === type).length < count) {
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  return {
    instanceId: created.instanceId,
    accountId: admin.id,
    cookie,
    broadcasts,
    waitForEvents,
    open: (frame) => {
      const settled = deferred<{ status: number; body: unknown }>();
      void rpc(MSG.interactionRequest, frame).then((result) => settled.resolve(result));
      return settled;
    },
    respond: (payload) => rpc(MSG.interactionRespond, payload),
  };
}

describe("relay hub interaction transport (production direction)", () => {
  it("opens an interaction, tells the browsers, answers it, and resolves the opening call", async () => {
    const h = await makeHarness();
    const frame = interactionOpenFrame();
    const opening = h.open(frame);

    // The hub holds the opening call while the human is still deciding, and it
    // has ALREADY published the form. Publishing first is what makes the form
    // visible before the caller has an answer to show.
    await h.waitForEvents("interaction-opened", 1);
    const openedEvents = h.broadcasts.filter((e) => e.type === "interaction-opened");
    expect(openedEvents).toHaveLength(1);
    // The broadcast carries the hub's OWN validated copy of the frame, so a
    // browser cannot be shown a form the hub did not accept.
    const opened = openedEvents[0] as Extract<ControlEventDto, { type: "interaction-opened" }>;
    expect(opened.interaction.requestId).toBe(frame.requestId);
    expect(opened.interaction.elicitation?.fields).toHaveLength(1);
    expect(opened.chatKey).toBe(`relay:${h.accountId}`);

    // The human answers. The frame carries NO identity — that is the contract.
    const answered = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "accept",
      content: { region: "us-east" },
    });
    expect(answered.status).toBe(200);

    // The opening RPC resolves with the decision, with the hub's own identity.
    const result = await opening.promise;
    expect(result.body).toEqual({
      responded: true,
      response: {
        requestId: frame.requestId,
        kind: "elicitation",
        action: "accept",
        content: { region: "us-east" },
        responderId: h.accountId,
      },
    });

    // And every browser learns the form is closed.
    const closedEvents = h.broadcasts.filter((e) => e.type === "interaction-closed");
    expect(closedEvents).toHaveLength(1);
    const closed = closedEvents[0] as Extract<ControlEventDto, { type: "interaction-closed" }>;
    expect(closed.requestId).toBe(frame.requestId);
    expect(closed.reason).toBe("resolved");
  });

  it("stamps the responder OVER anything the browser frame claims", async () => {
    // The mutation this guards: reading the identity off the answer frame. A
    // tampered client could then answer as any account, and core would receive an
    // identity that never authenticated anything.
    const h = await makeHarness();
    const frame = interactionOpenFrame({ requestId: "req-forge" });
    const opening = h.open(frame);
    await h.waitForEvents("interaction-opened", 1);

    // The frame with a claimed identity is REJECTED at the validator — the
    // identity rule is enforced on the way IN, not only on the way out. An
    // honest answer then goes through with the hub's own identity.
    const forged = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "accept",
      content: { region: "eu-west" },
      responderId: "someone-else",
    });
    expect(forged.status).toBe(400);

    const clean = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "accept",
      content: { region: "eu-west" },
    });
    expect(clean.status).toBe(200);

    const result = await opening.promise;
    const body = result.body as { response: Record<string, unknown> };
    expect(body.response.responderId).toBe(h.accountId);
    expect(body.response.responderId).not.toBe("someone-else");
  });

  it("refuses an answer that carries an identity at all", async () => {
    // Rejected rather than dropped: an explicit refusal surfaces the violation.
    const h = await makeHarness();
    const frame = interactionOpenFrame({ requestId: "req-identity" });
    const opening = h.open(frame);
    await h.waitForEvents("interaction-opened", 1);
    const answered = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "accept",
      responderId: "attacker",
    });
    expect(answered.status).toBe(400);

    // And the interaction is still open and answerable by the real browser.
    const clean = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "decline",
    });
    expect(clean.status).toBe(200);
    const result = await opening.promise;
    const body = result.body as { response: Record<string, unknown> };
    expect(body.response.action).toBe("decline");
    expect(body.response.responderId).toBe(h.accountId);
  });

  it("closes the interaction as expired when the window passes with no answer", async () => {
    // A late answer must not win: the window is the authority, not the arrival.
    const h = await makeHarness();
    const frame = interactionOpenFrame({
      requestId: "req-expire",
      // Already closed: the hub refuses to open it rather than show an unanswerable form.
      expiresAt: Date.now() - 1,
    });
    const tooLate = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "accept",
    });
    expect(tooLate.status).toBe(409);

    const opening = h.open(frame);
    const result = await opening.promise;
    expect(result.body).toEqual({ responded: false, reason: "timeout" });
    // No form was ever published for a window that could not be answered.
    expect(h.broadcasts.filter((e) => e.type === "interaction-opened")).toHaveLength(0);
  });

  it("treats an answer for an unknown request as gone, without opening a decision", async () => {
    const h = await makeHarness();
    const unknown = await h.respond({
      requestId: "never-opened",
      kind: "elicitation",
      action: "accept",
    });
    expect(unknown.status).toBe(409);
    const body = unknown.body as { error: string };
    expect(body.error).toBe("interaction-gone");
  });

  it("refuses a permission interaction up front rather than hanging the turn", async () => {
    // The wire carries the kind, but nothing renders it. Leaving the turn waiting
    // for an answer that can never arrive is the failure this avoids.
    const h = await makeHarness();
    const opening = h.open({
      requestId: "req-perm",
      kind: "permission",
      expiresAt: Date.now() + 60_000,
      permission: { availableOutcomes: ["allow_once"] },
    });
    const result = await opening.promise;
    expect(result.body).toEqual({ responded: false, reason: "unsupported" });
    expect(h.broadcasts.filter((e) => e.type === "interaction-opened")).toHaveLength(0);
  });

  it("declares the interaction capability the connector advertises", () => {
    // Both ends must agree the transport exists: a hub that never advertised it
    // would never ask, and a connector that never advertised it would never
    // open. This pins the string so the two cannot drift.
    expect(RELAY_CAPABILITIES.interactionElicitationFormV1).toBe("interaction.elicitation.form.v1");
    expect(RELAY_CAPABILITIES.interactionPermissionV1).toBeUndefined();
  });

  it("supports a zero-field form: opens, confirms, and accepts null content", async () => {
    // An all-optional schema with nothing to ask is a LEGAL form. The wire and the
    // UI must carry it, and the accept must say "no answers" rather than "{}".
    const h = await makeHarness();
    const frame = interactionOpenFrame({
      requestId: "req-zero",
      elicitation: {
        mode: "form",
        message: "Everything is already configured.",
        fields: [],
      },
    });
    const opening = h.open(frame);
    await h.waitForEvents("interaction-opened", 1);
    const opened = h.broadcasts.find((e) => e.type === "interaction-opened") as
      Extract<ControlEventDto, { type: "interaction-opened" }> | undefined;
    expect(opened).toBeDefined();
    expect(opened!.interaction.elicitation!.fields).toHaveLength(0);

    const answered = await h.respond({
      requestId: frame.requestId,
      kind: "elicitation",
      action: "accept",
      content: null,
    });
    expect(answered.status).toBe(200);

    const result = await opening.promise;
    const body = result.body as { response: Record<string, unknown> };
    expect(body.response.action).toBe("accept");
    expect(body.response.content).toBeNull();
    expect(body.response.content).not.toEqual({});
  });
});

describe("the hub's answerability fence and close notification", () => {
  /**
   * The registry, on its own, is the right level for these two: the fence is
   * about what the registry accepts, and the notification is about what it emits.
   * Both are timer races that an HTTP-level test can only observe after the fact.
   */
  function makeRegistry(now: () => number = () => Date.now()) {
    const registry = new InteractionRegistry({
      debug: () => {},
    });
    return { registry, now };
  }

  function seed(registry: InteractionRegistry, overrides: {
    requestId: string;
    expiresAt: number;
  }) {
    let settled: { reason: string } | undefined;
    let resolved = false;
    registry.open({
      requestId: overrides.requestId,
      instanceId: "inst-1",
      accountId: "acct-1",
      kind: "elicitation",
      expiresAt: overrides.expiresAt,
      chatKey: "relay:acct-1",
      sessionAlias: "",
      // Wide enough that the timer could not have fired yet: the fence under
      // test is the wall-clock check inside `answer`, not the expiry timer.
      answerWindowMs: 60_000,
      timeoutMs: 60_000,
      resolve: () => {
        resolved = true;
      },
      reject: (reason) => {
        settled = { reason };
      },
    });
    return {
      wasResolved: () => resolved,
      wasRejectedWith: () => settled?.reason,
    };
  }

  const answerFrame = {
    requestId: "req-fence",
    kind: "elicitation" as const,
    action: "accept" as const,
    content: { region: "us-east" },
  };

  it("refuses an answer whose window is already over, however it arrives", () => {
    // The expiry timer is coarse; a real answer can land a millisecond after
    // `expiresAt` without it having fired. The wall-clock fence is what closes
    // that hole, and it must close it BEFORE the decision is handed out.
    const { registry, now } = makeRegistry(() => Date.parse("2026-09-30T00:00:00.000Z"));
    const probe = seed(registry, { requestId: "req-fence", expiresAt: now() + 10 });
    // The window, elapsed — with the timer still far in the future.
    const lateNow = now() + 11;
    Date.now = () => lateNow;

    try {
      expect(registry.answer("req-fence", answerFrame)).toBeNull();
    } finally {
      registry.close("req-fence", "expired");
    }

    expect(probe.wasResolved()).toBe(false);
    expect(probe.wasRejectedWith()).toBe("expired");
  });

  it("still answers inside the window", () => {
    const { registry } = makeRegistry();
    const probe = seed(registry, { requestId: "req-fence", expiresAt: Date.now() + 10_000 });
    expect(registry.answer("req-fence", answerFrame)).not.toBeNull();
    expect(probe.wasResolved()).toBe(true);
  });

  it("notifies a listener for every closer, so a browser never guesses a close", () => {
    // The four lifecycle endings that were being emitted from different places:
    // the handler that resolved, the socket handler that withdrew, and the paths
    // that closed because the window or the account was gone. A single listener
    // over the registry sees all of them, which is what makes the browser's state
    // a property of the registry rather than of an HTTP call.
    const { registry } = makeRegistry();
    const seen: Array<{ requestId: string; reason: string }> = [];
    registry.onClose((closed) => seen.push({ requestId: closed.requestId, reason: closed.reason }));

    const closers = ["resolved", "withdrawn", "expired"] as const;
    for (const reason of closers) {
      const requestId = `req-${reason}`;
      seed(registry, { requestId, expiresAt: Date.now() + 60_000 });
      if (reason === "resolved") {
        registry.answer(requestId, { ...answerFrame, requestId });
      } else {
        registry.close(requestId, reason);
      }
    }

    expect(seen).toEqual([
      { requestId: "req-resolved", reason: "resolved" },
      { requestId: "req-withdrawn", reason: "withdrawn" },
      { requestId: "req-expired", reason: "expired" },
    ]);
  });
});
