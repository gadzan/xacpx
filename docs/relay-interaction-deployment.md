# Relay Interaction Deployment Runbook

How the **Direct Bot → relay hub → browser → human → back** interaction path is
wired, what authority each Hop holds, and what happens when it breaks.

This is the relay half of the deployment runbook that milestone M5 asked for. The
Feishu card-callback half is
[`docs/feishu-cardactions-deployment.md`](./feishu-cardactions-deployment.md).

**What this runbook does NOT claim:** no live deployment round trip was performed
while writing it. See [Verification status](#verification-status).

---

## 1. The chain

```text
Direct Bot turn
  → connector interaction open
  → hub
  → subscribed browser
  → human response
  → hub-authenticated responder
  → connector
  → exact originating turn resumes
```

Concretely:

```text
core (Direct Bot agent)
  │  needs a human decision
  ▼
RelayChannel.requestElicitation()        packages/channel-relay/src/channel.ts
  │  (field/outcome helpers: packages/channel-relay/src/relay-interaction.ts)
  │  MSG.interactionRequest  (connector → hub, long-lived RPC)
  ▼
hub registry                               packages/relay/src/interaction-registry.ts
  │  broadcast interaction-opened          → every subscribed browser on that account
  ▼
browser (Relay Web / Direct Bots)          packages/relay-web/src/stores/direct-bots.ts
  │  renders the form, human answers, submits
  ▼
MSG.interactionRespond  (browser → hub)
  │  hub STAMPS the responder identity from its authenticated session
  ▼
hub → connector
  │  the long-lived interactionRequest RPC resolves with the decision
  ▼
back to core → the exact originating turn resumes
```

Also on this path: `MSG.interactionWithdraw` (the connector closing an interaction
early, e.g. the agent aborted), and `interaction-closed` as the browser-side
notification of any closure — resolved, withdrawn, or expired.

---

## 2. Authority model — the part that must not drift

| Hop | Owns | Must NOT |
|---|---|---|
| Browser | the form it renders; the user's local draft | assert a responder identity; decide a terminal reason the hub did not send |
| Hub | the responder identity (stamped from the authenticated session); the open set; who is allowed to answer | take an identity from the frame |
| Connector | the request it opened; the only half notified on withdrawal | invent a second interaction |
| Core | re-validating the responder before applying the decision | trust the hub's stamp without checking |

### 2.1 The header slip

`responderId` is stamped in **exactly one place**: the hub's own session
(`interaction-registry.ts`). The browser's frame carries **no identity field at
all**, so there is nothing to forge. If you see a change that lets a browser
supply an identity, it is a security regression, not a feature.

### 2.2 Kind isolation

The registry keys interactions by `(interactionId, kind)`. That isolation must
survive every refactor:

- a `permission`-kind answer must never be accepted for an `elicitation` interaction, or vice versa;
- registering a permission interaction must not overwrite or bind to an elicitation one.

### 2.3 Routes

An elicitation route is `bot:<conversation>:<topic>` — a product surface.
A permission route is a **`permissionChatKey`** carried from trusted human ingress,
deliberately **not** the product `bot:` key. Do not unify them; they answer
different questions and belong to different trust domains.

### 2.4 The window

`expiresAt` is when answering stops being legal. The window is re-checked on
**every** answer, so a late answer is rejected rather than applied to a turn that
already moved on.

The transport reserve IS derived, not independent
(`packages/relay/src/gateway/instance-gateway.ts`):

```ts
answerWindowMs = parsed.expiresAt - now
timeoutMs      = answerWindowMs + REQUEST_RESPONSE_RESERVE_MS   // 15_000ms
```

The invariant that must not drift is what each clock decides, not their
independence: `answerWindowMs` governs whether the human's answer is still
**legal**, while the reserve only keeps the call open long enough for a decision
made inside the window to **travel**. The reserve extends transport lifetime, not
the legal answer window — so a decision arriving after `expiresAt` is still
rejected, however much reserve remains.

---

## 3. Capability declaration

`channel-relay` advertises exactly one interaction capability:

```text
interaction.elicitation.form.v1
```

It is advertised because `requestElicitation` is a real implementation on this
transport, and deliberately not split into a separate flag that could rot: the
capability **is** the implementation.

The permission half is deliberately **absent**: the wire carries the kind, but
nothing renders it. `RELAY_CAPABILITIES` has **no**
`interactionPermissionV1` member, so nothing can advertise
`interaction.permission.v1` from this package. The identifier is referenced by
tests and closures precisely to assert that it stays `undefined` — the capability
is deliberately not defined, not merely unused. Defining it before a renderer
exists would be exactly the backwards order the M5 discipline forbids.

`relay-protocol`'s built bundle is protected by `assert:relay-protocol`
(`package.json`), which fails the build if the barrel is tree-shaken empty — a
tracked-dist guard on this very path.

---

## 4. Deployment checklist

```text
hub reachable from connector
  → hub reachable from browser (WSS)
  → account ownership matches on both sides
  → capability declared (channel-relay)
  → browser subscribed to the right instance
```

- [ ] Configure channel-relay with the Hub URL, pairwise: `xacpx channel add relay --url wss://<hub> --token <pairing-token>`.
      The connector's config is `url` + `pairingToken` (plus an optional `--name`) —
      nothing under `transport.command`/`acpx-bridge`, which is the **xacpx ↔ acpx runtime
      transport** and has no bearing on where the connector points.
- [ ] The instance has a stored instance credential **or** an initial pairing token.
      `channel.start()` reports a terminal failure when neither is present: the
      connector stops rather than reconnecting forever, `start()` rejects, and the
      registry records the channel so the declared-vs-live audit can see it. The
      same applies to a handshake the hub rejects (stale credential, or a pairing
      token already used or expired) and to a protocol/version mismatch.
- [ ] The browser connects over **WSS** on any untrusted network. `/ws` is
      **authenticated** at upgrade by the `xrelay_session` cookie — an upgrade
      with no resolvable account is destroyed (`packages/relay/src/server.ts`
      upgrade handler) — but plain `ws://` provides **no transport
      confidentiality or integrity**, so the session cookie and the interaction
      traffic itself are exposed to a network attacker.
- [ ] The instance and the browser belong to the **same account**. The hub checks
      ownership on both the open and the answer; a mismatch is rejected, not
      silently proxied.
- [ ] The browser has subscribed to that instance (see §5).
- [ ] `channel-relay` declares `interaction.elicitation.form.v1`.

### 4.1 Browser subscription

A browser receives `interaction-opened` only while subscribed to the instance the
interaction belongs to. The Direct Bot dashboard subscribes to **every owned
instance**, so background turns keep working while the user views another one.
The subscription is scoped by instance, and a snapshot for instance A is
authoritative **only** about A.

---

## 5. Reconnect behaviour

A socket that was disconnected misses one-shot pushes. Two mechanisms cover it:

1. **Replay on subscribe.** The hub re-sends `interaction-opened` for every
   interaction it still holds, so a reconnect does not lose a live form.
2. **The authoritative open set.** Replay alone is positive-only: it cannot say
   "that is all of them", so a tab that missed a close would keep a dead form
   forever. An authoritative snapshot on reconnect closes that boundary.

> **Status at the time of writing:** mechanism 1 is shipped. Mechanism 2 is
> tracked separately and had not landed on the base this runbook was written
> against. If it has since shipped, the deployable behaviour is: after a
> reconnect, a form the hub has closed disappears on its own — without the user
> having to click it and discover a 409.

### 5.1 What a user sees on a lost route

If the route is lost — core daemon restart mid-turn, lease expiry, a recovered
claim — the interaction is **cancelled**, not resumed. The M3 readiness analysis
is explicit that a renderer must not assume a `waiting-human` Run or a pending
elicitation implies the route is still bindable. The UI should render that as a
cancellation, not an error.

---

## 6. Failure semantics

| Event | System behaviour | What the human sees |
|---|---|---|
| Human answers in time | hub resolves the connector's RPC with the decision | the form closes with the chosen outcome |
| Answer after `expiresAt` | rejected; the interaction is already gone | a 409 on submit, and the form is retired |
| Connector withdraws | hub closes the interaction, notifies browsers | form closed as withdrawn |
| Window expires | hub closes as expired, notifies browsers | form closed |
| **Core** loses the exact human route (core restart / lease expiry / a recovered claim on the interaction) | **cancel**, fail-closed | a cancellation notice, not an error — governed by the core conversation-authority model (`authorityEpoch`), not by the hub |
| Hub restarts with in-flight interactions | they disappear; the connector's pending RPC fails | the agent turn ends without an answer |

The last two rows are the current semantics and are **not** durability. Making an
interaction survive a hub restart requires the connector's own pending-RPC chain
to survive too, which is a design of its own — not a flag.

---

## 7. Operational diagnostics

Where to look when a form does not appear, or an answer does not arrive:

| Symptom | Check |
|---|---|
| No form appears at all | capability declared? browser subscribed to the instance? same account? |
| Form appears but Submit 409s | the interaction closed elsewhere (another tab, expiry, withdrawal) — this is the fail-closed path working |
| Answer arrives but the turn does not resume | the connector's RPC was lost; look for a transport/watchdog log around the answer window |
| Form reappears after a reconnect | replay-on-subscribe; if it is a form the hub already closed, the snapshot gap in §5 is the cause |

The hub's own logs carry the open/close transitions; the interaction registry
notifies a listener from **every** closer, so there is no silent path.

---

## Verification status

| Layer | Status |
|---|---|
| Production code path exercised | yes — `packages/relay/src/interaction-registry.ts` is the shipped registry, and the responder stamp is the only place identity is added |
| Injected / loopback transport verified | yes — the relay suites drive the real registry and a real gateway subscription over loopback |
| **Production-shaped full chain, over loopback** | yes — `tests/unit/packages/channel-relay/relay-elicitation-browser-delivery.test.ts` drives the real `RelayChannel`, the real `RelayClient` framing, a real connector WebSocket, the real `InstanceGateway` and `InteractionRegistry`, the real `WebGateway` subscription fence, a real browser WebSocket, and the full response round trip. The M4 closure calls this the genuine full-chain coverage. |
| Real platform round trip | **not exercised** — no live relay deployment with a real connector and a real Direct Bot agent in the authoring environment |

The distinction is environment, not code path. What the loopback test already
covers is the whole production-shaped chain:

```text
RelayChannel → RelayClient → real connector WebSocket → InstanceGateway
→ InteractionRegistry → WebGateway subscription fence → real browser WebSocket
→ answer → hub stamp → connector → back to the channel
```

What remains unexercised is only a real deployed hub, browser, and connector
stack — DNS, TLS, multi-process deployment, hub restart across hosts. That is a
deployment-environment gap, not a shape gap.
